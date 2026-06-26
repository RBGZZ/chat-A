/**
 * VoiceLoop v1 —— 端到端语音回合编排器（runtime 薄外壳）。
 *
 * 设计依据：`docs/superpowers/specs/2026-06-23-voiceloop-skeleton-design.md`（§1~§5）
 * 与实现计划 `docs/superpowers/plans/2026-06-23-voiceloop-skeleton.md` Task 4。
 *
 * 职责（半双工、事件驱动、一轮 = 一个可作废 generation）：
 *   听 → 想（注入的 `send(text, onToken)`）→ 说，含核心打断 + 被打断半句写回记忆。
 *
 * 关键设计：
 * - **零改 Conversation**：只经注入的 `send: (text, onToken) => Promise<string>` 消费，
 *   不直接依赖 `Conversation` 类（调用方传 `conversation.send.bind(conversation)`）。
 * - **状态机**：单一四态 + 瞬态（voice-turn-state.ts）；迁移集中在 `#go(event)`，
 *   合法则 emit 对应 BusEvent + 设态，非法记 warn 不抛（§3.2 优雅降级）。
 * - **generation 自检作废**：持单调 `#gen`；每次喂 TTS / sendAudio 前自检 `gen === #gen`，
 *   不等即不发（单消费者单生产者，自检即足）。打断 = `#gen++` 使在途 onToken/#speak 变 no-op。
 * - **真取消**（§3.2 真打断）：每个「想」回合建一个 `AbortController`，把 `signal` 传进注入的
 *   `send(text, onToken, signal)`；打断/停止时 `abort()` 之，使底层 LLM 流**真正停止**（不再后台
 *   跑到完）。被取消的 send 以 AbortError reject，因 gen 已变在 .catch 里静默忽略（不重复 reset）。
 *   generation 自检仍兜住「输出作废」，二者叠加：既不浪费尾部算力，也不污染状态。
 * - 全程容错：任一步抛错被 catch，回 listening，永不崩（§3.2）。
 */
import type { AudioFrame, AudioTransport, Unsubscribe, VoiceTraceEvent } from '@chat-a/protocol';
import { makeBusEvent, makeDataFrame, type PcmFrame } from '@chat-a/protocol';
import { normalizedRms } from '@chat-a/voice-detect';
import type {
  VadDetector,
  VadFrameResult,
  TurnDetector,
  EchoGuardConfig,
  EchoGuardDecision,
  SpeechGateConfig,
  FillerDenylist,
} from '@chat-a/voice-detect';
import {
  EchoGuardGate,
  passesSpeechGate,
  meetsSpeechGate,
  isDenylistedFiller,
  DEFAULT_SPEECH_GATE_CONFIG,
} from '@chat-a/voice-detect';
import type {
  SttProvider,
  TtsProvider,
  PcmChunk,
  SttEmotion,
  TtsOptions,
  TtsStreamSession,
} from '@chat-a/providers';
import { supportsStreamingFeed } from '@chat-a/providers';
import type { SttEmotionLike } from '@chat-a/persona';
import type { MemoryStore } from '@chat-a/memory';
import type { LightVoiceBus } from './bus';
import { SentenceSplitter } from './sentence-splitter';
import { stripUserEmotionTag, splitSafeTextForTag } from './user-emotion-tag';
import { nextState, type VoiceBusEvent, type VoiceState } from './voice-turn-state';
import {
  evaluateAttention,
  type AttentionGateOptions,
  type AttentionMode,
  type UserVoiceSignal,
} from './attention';
import {
  type BackchannelConfig,
  type BackchannelState,
  INITIAL_BACKCHANNEL_STATE,
  decideBackchannel,
  onSpeechStartedState,
  onPartialState,
  onTurnDoneState,
} from './backchannel-controller';

/** 被打断半句写回记忆时拼接的尾标（承 OLV：小雪记得在哪被打断）。 */
const INTERRUPT_MARK = '[被用户打断]';

/**
 * omni 直路运行期失败时向用户播报的友好降级提示（§3.2「永不崩永不哑」单一真相源）。
 *
 * 与文字路 `CHAT_ERROR_TEXT`（desktop ipc-contract）同腔调,但语音路独立(runtime 不反向依赖 desktop,
 * §3.1 接缝边界):暗示可能原因(网络/模型),用户能听懂,**不**泄露原始堆栈(堆栈留 console.warn)。
 * 装配层/测试可 import 本常量做断言或文字镜像,避免新字符串散落。
 */
export const VOICE_FAILURE_NOTICE =
  '(小雪这边语音没接上——可能是网络或模型的问题,稍等一下再试。)';

/** TurnDetector 选阈值用的语种码（v1 固定中文；后续可由 STT detected language 驱动）。 */
const DEFAULT_LANG = 'zh';

/**
 * omni audio-in 直路（path B，§4 双路径）的产出事件（判别联合）。
 * 与 providers 的 `OmniEvent` 结构等价；runtime 侧最小重声明，避免反向依赖具体 provider 类。
 * - `transcript`：用户输入音频的转写（等价 STT 文本，供记忆/召回）。
 * - `text`：模型回复的文本增量（凑句喂 TTS）。
 * - `end`：本轮回复结束。
 */
export type VoiceOmniEvent =
  | { readonly type: 'transcript'; readonly text: string }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'end' };

/**
 * omni 直路可选参数（§5.4 分两档注入：把组装好的系统提示喂模型）。
 * - `instructions`：persona+记忆+语气 组装好的系统提示，映射 omni session 的 instructions/系统提示，
 *   让 audio-in 直路下的小雪有人设/记忆/语气背景（**不含本轮 transcript**——用户这轮说了什么由模型自己听）。
 * 形态与 `QwenOmniLlm.OmniAudioOptions` 兼容（其字段全可选，结构上满足本接口）。
 */
export interface OmniAudioOpts {
  readonly instructions?: string;
}

/**
 * audio-in 直路端口（path B，§7#5 prosody：让模型直接「听」原始音频、从语气感知情绪）。
 * 形态等价 `QwenOmniLlm.respondToAudio`（其 opts 全可选，故结构上满足本接口，可直接当端口注入）。
 * 吃 endpointing 攒好的 PCM 块流，yield transcript/text/end；signal 用于打断时真停底层流（§3.2）。
 */
export interface OmniAudioPort {
  /**
   * 该 omni 模型要求的输入音频采样率（Hz；Qwen-Omni realtime = 16000）。**可选、纯加法**：
   * 缺省（不声明）→ 消费者回落 16000（逐字现状）。装配层据此决定采集重采样目标率（与 STT 路 capabilities.sampleRate 同接缝）。
   */
  readonly inputSampleRate?: number;
  respondToAudio(
    audio: AsyncIterable<PcmChunk>,
    opts?: OmniAudioOpts,
    signal?: AbortSignal,
  ): AsyncIterable<VoiceOmniEvent>;
}

/**
 * 连续流式 STT 端口（path stt-stream，§全程流式）：开一条长连接会话,持续 pushAudio,
 * 服务端 VAD 自动分句,经 handlers 吐 speech_started/partial/final 事件。**只转写、不生成回复**
 * (回复仍走现有 LLM+TTS)。形态等价 omni 端口的「连续会话」变体;失败由消费者回落批式 stt。
 */
export interface StreamingSttHandlers {
  /** 服务端 VAD 检测到用户开口(每段都有 [started, stopped] 边界)。 */
  onSpeechStarted(): void;
  /**
   * 服务端 VAD 检测到一段语音结束(stopped 早于 final);纯边界回调、无负载。
   * 流式 speech-gate 据此冻结段级能量快照(防 ASR 静音/噪声幻觉)。
   */
  onSpeechStopped(): void;
  /** 临时转写(流式吐字,可被后续覆盖);emotion/lang 若引擎给出。 */
  onPartial(text: string, emotion?: SttEmotion, lang?: string): void;
  /** 一句定稿 = 一个回合的用户文本;emotion 经现有 prosody 通道并入 PAD。 */
  onFinal(text: string, emotion?: SttEmotion, lang?: string): void;
  /** 连接/协议错误;消费者据此降级(关会话、回落批式 stt)。 */
  onError(err: unknown): void;
}
export interface StreamingSttSession {
  /** 推一帧/块 16k mono s16le 音频到流式转写。 */
  pushAudio(chunk: PcmChunk): void;
  /** 关闭会话(发 finish + 关连接);幂等。 */
  close(): void;
}
export interface StreamingSttOpts {
  /** 输入语种(省略 = 服务端自动检测)。 */
  readonly language?: string;
}
export interface StreamingSttPort {
  openSession(handlers: StreamingSttHandlers, opts?: StreamingSttOpts): StreamingSttSession;
}

/**
 * 语音路径选择：`stt`=现有 STT→LLM 路径（缺省）；`omni`=audio-in 直路（需注入 `omni` 端口）；
 * `stt-stream`=连续流式 STT 路（需注入 `streamingStt` 端口）。
 */
export type VoicePath = 'stt' | 'omni' | 'stt-stream';

/**
 * VoiceLoop 依赖注入（全经接口/接缝，确定性可测）。
 * `send` 由调用方传 `conversation.send.bind(conversation)`；`clock` 缺省用 `Date.now`。
 */
export interface VoiceLoopDeps {
  readonly transport: AudioTransport;
  readonly vad: VadDetector;
  readonly turnDetector: TurnDetector;
  readonly stt: SttProvider;
  readonly tts: TtsProvider;
  /**
   * 想：吃用户文本 + onToken（逐 token 回调）+ 可选 signal（协作取消）+ 可选 prosodyEmotion，resolve 完整回复。
   * `signal` 在打断时被 abort，使底层 LLM 流真停（§3.2 真打断）。
   * `prosodyEmotion`（§7#5「从语音读情绪」，**可选、纯加法**）：STT 读出的语气情绪,经 `Conversation.send`
   * 透传至 `persona.advance` 并入 PAD;**不传=无语音情绪=情绪推进与现状逐字一致**(旧实现/文字路不传即无感)。
   * 装配处传 `conversation.send.bind(conversation)`。
   */
  readonly send: (
    text: string,
    onToken: (t: string) => void,
    signal?: AbortSignal,
    prosodyEmotion?: SttEmotionLike,
  ) => Promise<string>;
  /** 半句写回只用到 appendMessage（最小面，§4 半句写回）。 */
  readonly memory: Pick<MemoryStore, 'appendMessage'>;
  readonly bus: LightVoiceBus;
  readonly sessionId: string;
  /** 注入时钟（测试确定性）；缺省 `Date.now`。 */
  readonly clock?: () => number;
  /**
   * 用户语音 URGENT 关注闸（§7 软反转，**可选**、纯加法）。
   * 不注入时(autonomy 默认关)→ barge-in 路径**逐字不变**(speaking 中一检出语音即即时打断,与现状一致)。
   * 注入后:speaking 中检出语音 → 经 `evaluateAttention(mode, signal)` 据 attention_mode 决定是否真打断;
   * 不可配底线(crisis/hardInterrupt)恒立即打断。本闸只影响「是否中断在飞输出」,不改其余状态机。
   */
  readonly attention?: VoiceLoopAttentionConfig;
  /**
   * 自打断防护(EchoGuard,§4 行 162/176 缺口的**软件侧部分缓解**,**可选**、纯加法)。
   * 不注入时(缺省)→ speaking 期 barge-in 逐字不变(检出语音即按既有路径打断,等价 N=1 即时确认)。
   * 注入后:speaking 期检出的上行语音帧先喂 `EchoGuardGate`,**连续 N 帧高置信**(可选叠能量阈值)
   * 才确认为真打断;压制自家 TTS 回声引起的误打断,但真人连续 N 帧仍能可靠打断(不变「打不断」)。
   * 与 attention 闸正交:EchoGuard 先去抖确认「是不是真语音」,确认后再(若注入 attention)按 mode 判。
   * ⚠️ 这**不是** AEC(回声消除需声学/原生方案);仅软件侧部分缓解。危机/硬打断信号豁免 N 帧去抖。
   */
  readonly echoGuard?: EchoGuardConfig;
  /**
   * EchoGuard 决策观测回调(day1 RMS instrument,§3.1「看不见就调不动」,**可选**、纯加法)。
   * 注入后每帧门控决策(RMS 值/当前 tier/是否放行/连续计数)经此抛出,供装配层打结构化日志/接 trace;
   * 不注入(缺省)→ VoiceLoop 用一个最简结构化日志默认观测(仅在注入了 echoGuard 时生效)。
   * 仅在 `echoGuard.enabled` 时被装上;回调抛错被 Gate 吞,绝不影响门控本身(§3.2)。
   */
  readonly echoGuardObserver?: (decision: EchoGuardDecision) => void;
  /**
   * audio-in 直路端口（path B，§4 双路径 / §7#5 prosody，**可选**、纯加法）。
   * 不注入（缺省）→ 纯走现有 STT→LLM 路径，行为与产出**逐字不变**。
   * 注入 **且** `voicePath==='omni'` → endpointing 攒的音频帧不喂 STT，而喂
   * `omni.respondToAudio(...)`：`transcript` 写记忆 + 推进 thinking、`text` 凑句喂 TTS、`end` 收尾。
   * 复用既有打断/generation/半句写回核心；omni 不可用/失败 → 优雅降级（§3.2，干净回 listening 不崩）。
   */
  readonly omni?: OmniAudioPort;
  /**
   * 连续流式 STT 端口（path stt-stream，**可选、纯加法**）。不注入(缺省)→ 不走连续路,逐字现状。
   * 注入 **且** `voicePath==='stt-stream'` → 开机开一条长连接会话,listening 期麦帧持续 pushAudio,
   * 服务端 VAD 分句:onFinal → 走现有 #send+TTS 回合(emotion 经 prosody 并入 PAD);speaking 期暂停推流,
   * 本地 EchoGuard/能量 VAD 仍管打断。WS 失败 → onError 降级回落批式 stt,绝不崩(§3.2)。
   */
  readonly streamingStt?: StreamingSttPort;
  /**
   * backchannel 附和配置(全双工 v1,**可选、纯加法**)。仅 `voicePath==='stt-stream'` 且注入时生效:
   * 用户说话中停顿时插一句缓存 clip「嗯/对」附和——**不占回合、不调 LLM、不进状态机**;播放期按时刻门控上行防回声。
   * 不注入(缺省)→ 不附和,逐字现状。
   */
  readonly backchannel?: BackchannelConfig;
  /**
   * omni 直路系统提示组装接缝（path B，§5.4 / §6 人格，**可选**、纯加法）。
   * 不注入（缺省）→ omni 路以**空 opts** 调 `respondToAudio`，与本切片前**逐字一致**（无人设/记忆/语气）。
   * 注入后 → omni 回合在调 `respondToAudio` 前先 `await` 它取得组装好的系统提示（persona 身份 + 记忆 +
   * 语气/立场/风格），以 `{ instructions }` 传入，让 audio-in 直路下的小雪和 STT 路一样有灵魂。
   * 装配层（cli）用与 `Conversation.send` 同源的 persona/memory/tone 机制实现并注入（复用既有组装，零重造）。
   * **降级**（§3.2/§5.5）：抛错/超时/返回空 → 退回空 opts（记 warn），绝不崩、绝不阻塞 omni 首音。
   * 本接缝**不影响 STT 路径**（STT 路不经过它）；instructions **不含本轮 transcript**（模型自己听音频）。
   */
  readonly composeOmniInstructions?: () => string | Promise<string>;
  /**
   * omni 路「情感→PAD」prosody 推进钩子（path B，§7#5 prosody / omni-prosody-to-pad，**可选**、纯加法）。
   * 不注入（缺省）→ omni 路**逐字现状**(只是没有 prosody→PAD)；注入后,omni 回合从模型回复尾部剥出的
   * `[user_emotion:label-intensity]` 标签 → 映射成 `SttEmotionLike` → 经此钩子喂进 PAD 情感内核。
   * 装配层(cli/app)把它接到 persona 的 prosody-only 推进通道(`convo.advanceProsody`,内部复用现成
   * `prosodyToPadPull` → `persona.advance('', { prosodyEmotion })`，**不新写映射**)。
   * **降级**(§3.2):抛错/reject 被 VoiceLoop 捕获并记 warn,**绝不中断回合**(分句→TTS→收尾照常)。
   * 仅 omni 路用此钩子;STT 路情绪走 `#send` 第 4 参,不经过它。
   */
  readonly advanceProsody?: (emotion: SttEmotionLike) => void | Promise<void>;
  /**
   * 语音路径开关（缺省 `stt`）；仅当为 `omni` **且**注入了 `omni` 端口时走 audio-in 直路，
   * 否则一律走现有 STT 路径（双保险：端口缺失即便选 omni 也回落 STT，行为逐字不变）。
   */
  readonly voicePath?: VoicePath;
  /**
   * 输入语种(§4.1 听=STT,**可选**、纯加法)。提供时 `#transcribe` 以 `SttOptions.language` 传给
   * `transcribe`(指定语种,不再自动检测);**省略(缺省)→ 不下发 language → STT 自动检测 → 逐字现状**。
   * 由装配层据 voice 配置(`CHAT_A_VOICE_INPUT_LANG` 非 auto 时)注入;VoiceLoop **不直接 import**
   * providers config(§3.1 接缝边界),只吃解析好的值。
   */
  readonly sttLanguage?: string;
  /**
   * 输出合成 opts(§4.1 说=TTS,**可选**、纯加法):`output_lang`→`language`、`voice_id`→`voiceId`、
   * `clone_ref`→`refAudio`。提供时 `#speak` 把它传给 `synthesize`(指定输出语种/音色/复刻);
   * **省略(缺省)→ synthesize 的 opts 仍为 undefined → 逐字现状**。同样由装配层据 voice 配置拼好后注入。
   */
  readonly ttsOptions?: TtsOptions;
  /**
   * 送 ASR 前段级语音门(防 ASR 静音幻觉 Layer 2,**可选**、纯加法)。
   * **不注入(缺省)→ 不门控 → 逐字现状**(STT 路与现有 1600+ 测试零影响)。
   * 注入后:STT 路在 `#transcribe` **之前**先过 `passesSpeechGate`——段过短/无足够有声内容(噪声尖峰/
   * 纯静音)直接判伪段,**不送 ASR**、静默回 listening,杜绝 qwen-asr 把静音幻觉成「嗯/thank you」。
   * 真 app 由装配层(cli-voice startVoiceMode)注入默认配置 → 真实用户得到保护。仅作用于 STT 路(omni 路自带 server VAD)。
   */
  readonly speechGate?: SpeechGateConfig;
  /**
   * 流式路 ASR 幻觉「填充词黑名单」(防 ASR 静音/噪声幻觉的**补充**判别,**可选、纯加法**)。
   * **不注入(缺省)→ 不查黑名单 → 逐字现状**(只剩空文本判伪)。
   * 注入后:仅 `voicePath==='stt-stream'` 的 `onFinal` 联合判伪用——「精确命中填充词 ∧ 段低能量
   * (segVoicedMs<minVoicedMs)」合取才丢(真说「嗯」有 voiced 能量 → 不丢)。**能量是第一判别,黑名单只补充**。
   * 装配层(cli-voice)注入 `DEFAULT_FILLER_DENYLIST`(可经 env 关);仅作用于流式路(批式/omni 不经过)。
   */
  readonly fillerDenylist?: FillerDenylist;
  /**
   * 流式路「纯低能量门」开关(`#gateStreamFinal` ③,**可选、默认关**)。
   * **默认关(缺省/false)**:本地段能量在某些麦(蓝牙 HFP 放音期/前后)极不可靠——真内容词(qwen 真转写出)
   *   会因段快照 voicedMs=0 被纯能量门误杀。故纯能量门弊大于利(丢真话),默认不开。
   * 注入 true(装配层经 `CHAT_A_STT_ENERGY_GATE=on` 显式开)→ 恢复纯能量门:`!meetsSpeechGate(段快照)` → 判伪
   *   (opt-in 能力保留,供本地能量可靠的麦/场景)。仅作用于 stt-stream 路;需同时注入 `speechGate` 才有效。
   */
  readonly streamEnergyGate?: boolean;
  /**
   * 语音管线可追溯观测回调(§8.1 可追溯性 / voice-traceability-design §4/§7，**可选**、纯加法)。
   * **不注入(缺省)→ 零开销**:各 emit 点经 `#emitTrace` 早退、`#traceOn` 为 false 跳过一切采样/汇总计算,
   *   VoiceLoop 行为与产出**逐字现状**(可观测性绝不打断/拖慢回合,§3.2)。
   * 注入后:VoiceLoop 在各决策/回合边界 emit `VoiceTraceEvent`(公共字段 atMs/sessionId/correlationId 由
   *   `#emitTrace` 中心化补全),装配层(cli-voice)经此 fan-out 到实时结构日志 + `SqliteVoiceTraceSink`。
   * 回调抛错被 `#emitTrace` 吞掉,**绝不打断回合**(§3.2)。
   */
  readonly voiceObserver?: (ev: VoiceTraceEvent) => void;
}

/**
 * `#emitTrace` 入参：`VoiceTraceEvent` 去掉公共字段(atMs/correlationId/sessionId/turnId)后的 kind 专属载荷。
 * 公共字段由 `#emitTrace` 中心化补全(分布式 Omit 保判别联合按 kind 收窄)。
 */
type VoiceTracePayload = VoiceTraceEvent extends infer T
  ? T extends VoiceTraceEvent
    ? Omit<T, 'atMs' | 'correlationId' | 'sessionId' | 'turnId'>
    : never
  : never;

/**
 * VoiceLoop 对外只读「忙闲」视图(承 §7 单一 is_speaking 硬闸)。
 *
 * 与 `@chat-a/autonomy` 的 `SpeakState` **结构等价**:装配层把本视图直接喂 arbiter 闭包,
 * 让仲裁查到 VoiceLoop 真实说话状态,而非保守缺省 `{isSpeaking:false}`。
 * 在 runtime 侧定义(不反向依赖 autonomy):`speakingPriority` MVP 省略 → arbitrate 按最低看待
 * (任何明确优先级都可抢占在说者),后续可由回合调度填真优先级。
 */
export interface SpeakStateView {
  /** 单一硬闸:当前是否正在说话(= 状态机处于 speaking)。 */
  readonly isSpeaking: boolean;
  /** 当前在说者优先级(MVP 省略;留作后续回合调度填充)。 */
  readonly speakingPriority?: 'URGENT' | 'PERCEPTION' | 'LOWEST';
}

/** VoiceLoop 关注闸配置(可选注入;承 §7 软反转 + attention_mode)。 */
export interface VoiceLoopAttentionConfig {
  /**
   * 当前关注模式;可为常量或现读函数(行为即配置,改配置下次检出生效,无重启)。
   * 函数形态便于装配层把 `interaction_dials.attention_mode` 热接入。
   */
  readonly mode: AttentionMode | (() => AttentionMode);
  /** 关注闸门槛旋钮(可选;省略用默认 focusSustainMs=600）。 */
  readonly options?: AttentionGateOptions;
  /**
   * 据当前用户语音事件构造 `UserVoiceSignal`(可选)。
   * 缺省:仅以 VAD speech_start 事件 + 据帧时间戳估算的 sustainedMs 构造(无 crisis/hardInterrupt 标注,
   * 由上层感知/分类经此回调注入危机/硬打断/在飞标志)。
   */
  readonly buildSignal?: (ctx: { readonly sustainedMs: number; readonly speaking: boolean }) => UserVoiceSignal;
}

export class VoiceLoop {
  readonly #transport: AudioTransport;
  readonly #vad: VadDetector;
  readonly #turnDetector: TurnDetector;
  readonly #stt: SttProvider;
  readonly #tts: TtsProvider;
  readonly #send: (
    text: string,
    onToken: (t: string) => void,
    signal?: AbortSignal,
    prosodyEmotion?: SttEmotionLike,
  ) => Promise<string>;
  readonly #memory: Pick<MemoryStore, 'appendMessage'>;
  readonly #bus: LightVoiceBus;
  readonly #sessionId: string;
  readonly #now: () => number;
  /** 关注闸配置（§7 软反转）；未注入则保持现状即时打断（autonomy 默认关时逐字不变）。 */
  readonly #attention: VoiceLoopAttentionConfig | undefined;
  /**
   * 自打断防护去抖件(§4 软件侧部分缓解);未注入则 undefined → speaking 期 barge-in 逐字现状。
   * 注入后在 speaking 期累计「连续高置信语音帧数」,达 N 才确认真打断(压回声毛刺,真人仍打得断)。
   */
  readonly #echoGuard: EchoGuardGate | undefined;
  /**
   * audio-in 直路端口（path B）；未注入 → undefined → 走 STT 路径（§4 双路径）。
   * 仅在 `#voicePath==='omni'` 且本字段非空时,`#beginThinking` 分流到 omni 直路。
   */
  readonly #omni: OmniAudioPort | undefined;
  /**
   * 连续流式 STT 端口（path stt-stream）；未注入 → undefined → 不走连续路（§全程流式）。
   * 仅在 `#voicePath==='stt-stream'` 且本字段非空且未降级时,`start()` 开会话、`#onAudio` 持续推流。
   */
  readonly #streamingStt: StreamingSttPort | undefined;
  /** 当前流式会话（开机后开,stop/降级时关）；null = 未开/已关。 */
  #streamSession: StreamingSttSession | null = null;
  /** onError 后置 true:本轮退回批式 stt(本地 VAD+endpointing);`start()` 重置以给新一轮机会。 */
  #streamDegraded = false;
  /**
   * backchannel 附和配置(全双工 v1)；未注入 → undefined → 不附和(逐字现状)。
   * 仅 stt-stream 路用:stt-stream handlers 推进 `#bcState`,`#onAudio` 连续分支每帧 consult。
   */
  readonly #backchannel: BackchannelConfig | undefined;
  /** backchannel 外置状态(由本 loop 持有,由 stt-stream handlers + 每帧决策推进)。 */
  #bcState: BackchannelState = INITIAL_BACKCHANNEL_STATE;
  /**
   * 上行门控截止时刻(ms)：附和播放期内 `> now` 暂停上行推流(防自家附和音回灌 ASR);
   * `< now` 即不门控。**按时刻自动解除**(不依赖播放回调,绝不卡死推流,§3.2)。
   */
  #bcGateUntilMs = 0;
  /** 附和 clip 懒合成缓存(clipText → 合成好的 PcmChunk 序列;轮换复用,避免重复合成)。 */
  readonly #bcClipCache = new Map<string, PcmChunk[]>();
  /**
   * omni 直路系统提示组装接缝（path B，§5.4/§6）；未注入 → undefined → omni 路以空 opts(逐字现状)。
   * 注入后在 `#startThinkingOmni` 调 `respondToAudio` 前 `await` 它得 instructions(失败/空→退回空 opts)。
   */
  readonly #composeOmniInstructions: (() => string | Promise<string>) | undefined;
  /**
   * omni 路「情感→PAD」prosody 推进钩子（omni-prosody-to-pad）；未注入 → undefined → omni 路逐字现状。
   * 注入后在 `#startThinkingOmni` 收尾处把剥出的情绪喂它(失败吞错,不中断回合)。
   */
  readonly #advanceProsody: ((emotion: SttEmotionLike) => void | Promise<void>) | undefined;
  /** 语音路径开关（缺省 `stt`）；决定 `#beginThinking` 走 STT 还是 omni 直路。 */
  readonly #voicePath: VoicePath;
  /**
   * 输入语种(§4.1,可选);未注入 → undefined → `#transcribe` 不下发 language(自动检测,逐字现状)。
   */
  readonly #sttLanguage: string | undefined;
  /**
   * 输出合成 opts(§4.1,可选);未注入 → undefined → `#speak` 传 synthesize 的 opts 仍为 undefined(逐字现状)。
   */
  readonly #ttsOptions: TtsOptions | undefined;
  /**
   * 送 ASR 前段级语音门配置(防 ASR 静音幻觉 Layer 2);未注入 → undefined → 不门控(逐字现状)。
   * 注入后在 `#startThinking` 转写前过 `passesSpeechGate`,伪段(过短/无足够有声)不送 ASR、回 listening。
   */
  readonly #speechGate: SpeechGateConfig | undefined;
  /**
   * 流式路填充词黑名单(防 ASR 静音/噪声幻觉的补充判别);未注入 → undefined → 不查黑名单(逐字现状)。
   * 仅 stt-stream 路 onFinal 联合判伪用(精确命中 ∧ 段低能量 才丢)。
   */
  readonly #fillerDenylist: FillerDenylist | undefined;
  /**
   * 流式路「纯低能量门」开关(`#gateStreamFinal` ③);**默认 false(关)**——本地能量在某些麦(蓝牙 HFP
   * 放音期)不可靠会误杀真内容词,故纯能量门默认不开;显式 true 才恢复。黑名单(④)为默认主防御,不受此开关影响。
   */
  readonly #streamEnergyGate: boolean;
  /**
   * ── 流式段级被动能量累计(L1,**不丢帧、纯旁路观测**)──
   * `onSpeechStarted` 重置(segTotalMs=0/segVoicedMs=0/inSegment=true);listening/thinking 期 `#onAudio`
   * 推流照旧、若 inSegment 则旁路累计本帧时长与「有声帧」时长(复用批式同口径阈值);`onSpeechStopped`
   * 冻结 `#segSnapshot` 快照、inSegment=false。`onFinal` 据快照做能量/黑名单联合判伪(主门)。
   * 树莓派友好:只数两个标量,绝不 buffer 整段 PCM。
   */
  #segTotalMs = 0;
  #segVoicedMs = 0;
  #inSegment = false;
  /** 最近一段(speech_stopped 时)冻结的能量快照;null = 无段证据(协议异常/无 speech_started)→ 降级保守放行。 */
  #segSnapshot: { readonly segTotalMs: number; readonly segVoicedMs: number } | null = null;
  /**
   * 语音管线可追溯观测回调(§8.1);未注入 → undefined → `#emitTrace` 早退、`#traceOn` false → 零开销逐字现状。
   * 注入后各 emit 点的 `VoiceTraceEvent` 经此抛给装配层 fan-out(实时日志 + SQLite sink)。
   */
  readonly #voiceObserver: ((ev: VoiceTraceEvent) => void) | undefined;
  /** mic-sample 节流计数器(每 ~50 帧/≈500ms 采样一次麦电平,避免逐帧刷屏/写库,§4)。 */
  #micSampleCount = 0;
  /** 本次 speaking 回合用户开口的首帧时刻（ms），用于估算 sustainedMs 喂关注闸。 */
  #userSpeechStartAtMs: number | null = null;

  /** 当前状态（稳定四态 + 瞬态）。 */
  #state: VoiceState = 'listening';
  /** 回合令牌：单调 +1/回合；打断/换回合自增使在途 TTS/onToken 自检失败而作废。 */
  #gen = 0;
  /** 本回合已累积的回复文本（用于打断时半句写回）。 */
  #replyAccum = '';
  /** endpointing 期累积的用户音频帧（喂 TurnDetector / STT）。 */
  #audioBuf: PcmFrame[] = [];
  /** 下行 tts:chunk 单调序号（终端据此丢弃迟到块，对齐 generation 打断）。 */
  #ttsSeq = 0;
  /** 最近一次「说话中」帧的真实时刻（ms）；用于据帧时间戳算静音时长喂 TurnDetector。 */
  #lastVoiceAtMs = 0;
  /** transport.onAudio 注销句柄。 */
  #unsub: Unsubscribe | null = null;
  /** 当前回合的 send 链（仅用于内部追踪，不阻塞）。 */
  #currentTurn: Promise<void> | null = null;
  /**
   * 当前「想」回合的取消控制器（§3.2 真打断）：打断/停止时 abort() 之，使底层 LLM 流真停。
   * 每回合在 #startThinking 新建;无在途回合时为 null。
   */
  #currentAbort: AbortController | null = null;
  /**
   * 当前回合的 **warm TTS 会话**（CosyVoice 连接预热,承「砍首音建连+握手开销」）：
   * 回合起点(STT/LLM 阶段)即 `synthesizeStream()` 开 WS + run-task 握手,逐句 `push`,回合末 `finish`;
   * 打断/停止/抢占经 `#abortCurrent` → `#closeWarmSession` 干净 `abort`(幂等吞错,绝不泄漏 §3.2)。
   * 仅在 TTS 支持 `synthesizeStream`(supportsStreamingFeed)且未降级时启用;否则 null = 逐句 synthesize(逐字现状)。
   */
  #warmTtsSession: TtsStreamSession | null = null;
  /**
   * 预热降级闩(§3.2 优雅降级):某回合 warm 会话异步失败(建连/握手抛错/超时)后置 true,
   * 后续回合静默回落逐句 synthesize,不再尝试预热;`start()` 重置以给新一轮机会(对齐 `#streamDegraded`)。
   */
  #ttsStreamDegraded = false;

  constructor(deps: VoiceLoopDeps) {
    this.#transport = deps.transport;
    this.#vad = deps.vad;
    this.#turnDetector = deps.turnDetector;
    this.#stt = deps.stt;
    this.#tts = deps.tts;
    this.#send = deps.send;
    this.#memory = deps.memory;
    this.#bus = deps.bus;
    this.#sessionId = deps.sessionId;
    this.#now = deps.clock ?? Date.now;
    this.#attention = deps.attention;
    // EchoGuard:仅在注入且 enabled 时启用;否则 undefined → speaking 期 barge-in 逐字现状。
    // 可观测(§3.1 day1 RMS instrument):优先用注入的 echoGuardObserver,否则用最简结构化日志默认观测。
    this.#echoGuard =
      deps.echoGuard !== undefined && deps.echoGuard.enabled
        ? new EchoGuardGate(deps.echoGuard, {
            onDecision: deps.echoGuardObserver ?? VoiceLoop.#defaultEchoGuardObserver,
          })
        : undefined;
    this.#omni = deps.omni;
    this.#streamingStt = deps.streamingStt;
    this.#backchannel = deps.backchannel;
    this.#composeOmniInstructions = deps.composeOmniInstructions;
    this.#advanceProsody = deps.advanceProsody;
    this.#voicePath = deps.voicePath ?? 'stt';
    this.#sttLanguage = deps.sttLanguage;
    this.#ttsOptions = deps.ttsOptions;
    this.#speechGate = deps.speechGate;
    this.#fillerDenylist = deps.fillerDenylist;
    this.#streamEnergyGate = deps.streamEnergyGate ?? false;
    this.#voiceObserver = deps.voiceObserver;
  }

  /** 是否已注入语音可追溯观测;为 false 时各 emit 点跳过一切采样/汇总计算,零开销(§3.2/§8.1)。 */
  get #traceOn(): boolean {
    return this.#voiceObserver !== undefined;
  }

  /**
   * 中心化 emit 语音 trace(§8.1):补全公共字段(atMs/sessionId/correlationId)后抛给注入的 `#voiceObserver`。
   * - 未注入 → 早退(零开销);correlationId 取 bus 当前关联号(与 decision_traces/otel_spans 同键缝合),取不到则省略;
   *   turnId 暂无稳定来源(语音回合无独立 turnId 字段)→ 省略(§4 公共字段可缺省)。
   * - observer 抛错被吞,**绝不打断回合**(可观测性不致命,§3.2)。
   */
  #emitTrace(ev: VoiceTracePayload): void {
    const observer = this.#voiceObserver;
    if (observer === undefined) return; // 未注入:零开销 no-op
    try {
      const corr = this.#bus.currentCorrelationId();
      const full = {
        ...ev,
        atMs: this.#now(),
        sessionId: this.#sessionId,
        ...(corr !== undefined ? { correlationId: corr } : {}),
      } as VoiceTraceEvent;
      observer(full);
    } catch {
      /* 可观测性绝不打断回合(§3.2):吞错(连诊断都不打,避免噪声/递归) */
    }
  }

  /**
   * 汇总一段 PCM 帧的时长 + 归一 RMS 能量(供 `stt-input` trace,§4)。仅在 `#traceOn` 时调用(零开销)。
   * 与 EchoGuard/speech-gate 同口径(samples²均方根 / 满量程归一,clamp 到 1)。
   */
  #bufSummary(frames: readonly PcmFrame[]): { durationMs: number; rmsNorm: number } {
    let durationMs = 0;
    let sumSq = 0;
    let n = 0;
    for (const f of frames) {
      durationMs += (f.samples.length / f.sampleRate) * 1000;
      for (let i = 0; i < f.samples.length; i++) {
        sumSq += f.samples[i]! * f.samples[i]!;
        n += 1;
      }
    }
    const rms = n > 0 ? Math.sqrt(sumSq / n) : 0;
    return { durationMs, rmsNorm: Math.min(1, rms / VoiceLoop.#FULL_SCALE) };
  }

  /** 当前状态（供测试断言）。 */
  get state(): VoiceState {
    return this.#state;
  }

  /**
   * 只读 is_speaking 硬闸(§7):当前是否正在说话(= 状态机处于 speaking)。
   * autonomy 装配层经此接缝把真实忙闲喂 arbiter 闭包,**取代保守缺省**;
   * 纯只读、零副作用,不导出内部状态机(§3.1 经接口不经内部)。
   */
  get isSpeaking(): boolean {
    return this.#state === 'speaking';
  }

  /**
   * 只读忙闲视图(结构等价 autonomy `SpeakState`):供仲裁器查真实说话状态。
   * MVP 不填 `speakingPriority`(arbitrate 据此按最低看待,任何明确优先级可抢占)。
   */
  speakState(): SpeakStateView {
    return { isSpeaking: this.#state === 'speaking' };
  }

  /**
   * autonomy **自身抢占**触发入口(缝 1,承 §7 软反转下的「autonomy 抢占受约束」)。
   *
   * 与用户语音 URGENT 的 barge-in **完全独立**:那条路径在 `#onAudio` 里、恒最高优先,
   * 不经此钩子、不与之竞争——autonomy 抢占**绝不凌驾用户**。
   *
   * 判定(§7):
   *   1. **非 speaking**(无在飞 autonomy/动作输出可抢占)→ 不打断、无副作用,返回 false。
   *      (空闲时 autonomy 本就走正常 requestSpeak 放行,无需打断。)
   *   2. speaking 且**未注入关注闸** → 复用既有打断核心 `#interrupt(reason)`(与 attention 缺省即时
   *      打断语义一致:「能抢就抢」),返回 true。
   *   3. speaking 且**注入关注闸** → 经 `evaluateAttention(mode, {sustainedMs:0, somethingInFlight:true})`
   *      判 `trueInterrupt`:focus 模式下不轻易打断自己的专注输出;companion/危机/硬打断则打断。
   *
   * **复用** abort 三件套(`#gen++` + abort 底层 LLM 流 + clearBuffer + 半句写回),不重写打断核心。
   * `reason` 透传 `turn:interrupt` 的 reason(§8.1 可追溯,区分 barge_in / autonomy_preempt)。
   */
  requestAutonomyPreempt(reason = 'autonomy_preempt'): boolean {
    if (this.#state !== 'speaking') return false; // 无在飞输出可抢占
    const cfg = this.#attention;
    if (cfg === undefined) {
      // 未注入关注闸:复用既有即时打断语义。
      if (this.#go('vad:speech_start')) {
        this.#interrupt(reason);
        return true;
      }
      return false;
    }
    // 注入关注闸:autonomy 自身抢占也受 attention_mode 约束(focus 不轻易打断自己)。
    try {
      const mode = typeof cfg.mode === 'function' ? cfg.mode() : cfg.mode;
      const verdict = evaluateAttention(mode, { sustainedMs: 0, somethingInFlight: true }, cfg.options);
      if (!verdict.trueInterrupt) return false; // attention 不允许(如 focus 未达坚持)→ 不打断
      if (this.#go('vad:speech_start')) {
        this.#interrupt(reason);
        return true;
      }
      return false;
    } catch (err) {
      console.warn('[VoiceLoop] autonomy 抢占判定抛错(已捕获,放弃本次抢占):', err);
      return false;
    }
  }

  /**
   * 是否走连续流式路（path stt-stream）：选了 stt-stream + 注入了端口 + 本轮未降级。
   * 任一不满足 → false → `#onAudio` 走现有批式 STT 路径(逐字现状)。
   */
  get #useStream(): boolean {
    return this.#voicePath === 'stt-stream' && this.#streamingStt !== undefined && !this.#streamDegraded;
  }

  /**
   * 是否启用 backchannel 附和：走连续流式路(`#useStream`) **且**注入了 `backchannel` 配置。
   * 仅 stt-stream 路才有连续 partial 流可判「说话中停顿」;未注入/非 stt-stream → false → 逐字现状。
   */
  get #useBackchannel(): boolean {
    return this.#useStream && this.#backchannel !== undefined;
  }

  /** 启动：订阅上行音频，进入 listening。重复 start 幂等（先退订旧的）。 */
  start(): void {
    this.stop();
    this.#streamDegraded = false; // 新一轮:给流式路重新机会(上轮降级不延续)
    this.#ttsStreamDegraded = false; // 同理:重置 TTS 预热降级闩,新一轮重新尝试预热
    this.#state = 'listening';
    this.#unsub = this.#transport.onAudio((frame) => this.#onAudio(frame));
    // 连续流式路:开机即开一条长连接会话,listening 期持续推流(§全程流式)。
    if (this.#useStream) this.#openStream();
  }

  /**
   * 开一条连续流式 STT 会话（§全程流式）：注册 handlers——onFinal 驱动现有回合、onError 降级回批式。
   * 幂等:已有会话或未注入端口直接返回;openSession 抛错 → 降级(置 #streamDegraded),绝不崩(§3.2)。
   */
  #openStream(): void {
    if (this.#streamingStt === undefined || this.#streamSession !== null) return;
    const handlers: StreamingSttHandlers = {
      onSpeechStarted: () => {
        // L1:新一段开始 → 重置段级能量累计器(开始旁路累计本段时长/有声时长);清旧快照(已被上段 onFinal 消费)。
        this.#segTotalMs = 0;
        this.#segVoicedMs = 0;
        this.#inSegment = true;
        this.#segSnapshot = null;
        // backchannel:记本轮用户开口时刻(独立于语音状态机,故在早退之前推进)。未启用则 no-op。
        if (this.#useBackchannel) this.#bcState = onSpeechStartedState(this.#bcState, this.#now());
        // listening:仅作在场/状态提示(回合由 onFinal 驱动,这里不改状态机);其余态忽略。
        // emit 形态与 #emit 的 'vad:speech_start' 分支逐字一致(直接 emit,不经 #go 以免误迁移)。
        if (this.#state !== 'listening') return;
        try {
          const corr = this.#bus.currentCorrelationId() ?? `${this.#sessionId}/voice/${this.#gen}`;
          this.#bus.emit(makeBusEvent('vad:speech_start', { atMs: this.#now() }, corr));
        } catch (err) {
          console.warn('[VoiceLoop] 流式 speech_started emit 抛错(已捕获):', err);
        }
      },
      onSpeechStopped: () => {
        // L1:一段结束 → 冻结能量快照(供 onFinal 联合判伪),停止累计。stopped 早于 final,故快照在 onFinal 已就绪。
        this.#segSnapshot = { segTotalMs: this.#segTotalMs, segVoicedMs: this.#segVoicedMs };
        this.#inSegment = false;
        // 可追溯:段级门判定预览(passed=会否通过能量门;无 speechGate 时按 DEFAULT 配置汇报,仅观测不改判)。
        if (this.#traceOn) {
          const cfg = this.#speechGate ?? DEFAULT_SPEECH_GATE_CONFIG;
          this.#emitTrace({
            kind: 'speech-gate',
            passed: meetsSpeechGate({ totalMs: this.#segTotalMs, voicedMs: this.#segVoicedMs }, cfg),
            totalMs: this.#segTotalMs,
            voicedMs: this.#segVoicedMs,
          });
        }
      },
      onPartial: () => {
        // backchannel:刷新最近 partial 时刻(判停顿用);本切片 partial 仍不驱动回合。
        if (this.#useBackchannel) this.#bcState = onPartialState(this.#bcState, this.#now());
      },
      onFinal: (text, emotion, lang) => {
        // backchannel:一句定稿 → 清开口态(下句前不附和);保留冷却与 clip 索引。
        if (this.#useBackchannel) this.#bcState = onTurnDoneState(this.#bcState);
        // 可追溯:流式路无本地攒 buf(逐帧已推流)→ stt-input 时长/能量近似省略为 0(§4 流式约定);
        // stt-result 带服务端定稿文本/情绪/语种。
        this.#emitTrace({ kind: 'stt-input', path: 'stt-stream', durationMs: 0, rmsNorm: 0 });
        this.#emitTrace({
          kind: 'stt-result',
          text,
          isFinal: true,
          ...(emotion !== undefined ? { emotion: emotion.label } : {}),
          ...(lang !== undefined ? { lang } : {}),
        });
        // L2 联合判伪(主门,防 ASR 静音/噪声幻觉):空文本/段低能量/残差黑名单 → 不起回合、只记 gated。
        // 判伪只**不起新回合**(不 reset/不 abort 在飞回合):listening 常态下保持 listening,绝不误伤真回合。
        const gateReason = this.#gateStreamFinal(text);
        if (gateReason !== null) {
          this.#emitTrace({ kind: 'turn', outcome: 'gated', reason: gateReason });
          this.#segSnapshot = null; // 快照已消费,清除以免影响下一句降级判定
          return;
        }
        this.#segSnapshot = null; // 放行:快照已消费
        // 一句定稿 = 一个回合:走现有 #send+TTS 核心(emotion 经 prosody 并入 PAD)。
        this.#runStreamTurn(text, emotion);
      },
      onError: (err) => {
        // 连接/协议错误:降级回批式 stt(本地 VAD+endpointing),关会话、干净回 listening(§3.2)。
        console.warn('[VoiceLoop] 流式 ASR onError,降级回批式 stt:', err);
        this.#streamDegraded = true;
        try {
          this.#streamSession?.close();
        } catch {
          /* ignore */
        }
        this.#streamSession = null;
        this.#resetToListening();
      },
    };
    const opts = this.#sttLanguage !== undefined ? { language: this.#sttLanguage } : undefined;
    try {
      this.#streamSession = this.#streamingStt.openSession(handlers, opts);
    } catch (err) {
      console.warn('[VoiceLoop] 流式 ASR openSession 失败,降级批式 stt:', err);
      this.#streamDegraded = true;
    }
  }

  /** 停止：退订上行 + 作废当前回合（gen 作废 onToken/TTS + abort 真停底层 LLM 流，§3.2）。 */
  stop(): void {
    if (this.#unsub !== null) {
      this.#unsub();
      this.#unsub = null;
    }
    this.#gen++; // 作废在途回合（onToken/#speak 自检失败而 no-op）
    this.#abortCurrent(); // 真取消在途「想」回合的底层 LLM 流
    this.#replyAccum = '';
    this.#audioBuf = [];
    this.#userSpeechStartAtMs = null;
    this.#echoGuard?.resetTiers(); // 全量重置 EchoGuard 档位(清说话/冷却,start/stop 干净起步)
    // backchannel:清门控 + 重置外置状态(幂等,start/stop 干净起步);clip 缓存保留(同音色跨轮复用)。
    this.#bcGateUntilMs = 0;
    this.#bcState = INITIAL_BACKCHANNEL_STATE;
    // L1 流式段级能量累计器:清零(幂等,start/stop 干净起步)。
    this.#segTotalMs = 0;
    this.#segVoicedMs = 0;
    this.#inSegment = false;
    this.#segSnapshot = null;
    // 连续流式路:关会话(发 finish + 关连接);幂等。
    try {
      this.#streamSession?.close();
    } catch {
      /* ignore */
    }
    this.#streamSession = null;
  }

  /** abort 当前回合的取消控制器（若有）并清空句柄；同时干净关闭本回合 warm TTS 会话；幂等、不抛（§3.2）。 */
  #abortCurrent(): void {
    // 先关 warm 会话(若有):打断/停止/抢占都经此单一收口,绑回合生命周期,绝不泄漏(发 abort 丢在途音频+关连接)。
    this.#closeWarmSession();
    const ac = this.#currentAbort;
    this.#currentAbort = null;
    if (ac === null) return;
    try {
      ac.abort();
    } catch (err) {
      console.warn('[VoiceLoop] abort 当前回合抛错(已捕获):', err);
    }
  }

  // ───────────────────────────── 状态迁移 ─────────────────────────────

  /**
   * 集中迁移：查 `nextState`，合法则 emit 对应 BusEvent + 设态；非法记 warn 不抛（§3.2）。
   * `atMs` 缺省取注入时钟（emit 的 BusEvent 数据载荷需要）。
   */
  #go(event: VoiceBusEvent, opts?: { readonly text?: string; readonly reason?: string }): boolean {
    const to = nextState(this.#state, event);
    if (to === null) {
      console.warn(`[VoiceLoop] 非法迁移：${this.#state} --${event}--> (忽略,不抛)`);
      return false;
    }
    const from = this.#state;
    this.#state = to;
    // EchoGuard Tier1/Tier2 切换:进入 speaking → 硬门控;离开 speaking → 开冷却窗(承 §3.1)。
    // 集中在迁移处驱动,避免散落各调用点漏配;未注入 EchoGuard 时此调用为 no-op(#echoGuard undefined)。
    // 冷却窗起点用**最近一帧时间戳**对齐 push 的帧时间轴(确定性,不读墙钟);无帧时回落注入时钟。
    if (from !== 'speaking' && to === 'speaking') {
      this.#echoGuard?.setSpeaking(true, this.#lastFrameAtMs);
    } else if (from === 'speaking' && to !== 'speaking') {
      this.#echoGuard?.setSpeaking(false, this.#lastFrameAtMs);
    }
    try {
      this.#emit(event, opts);
    } catch (err) {
      // emit 失败不应打断回合推进（总线问题不致命,§3.2）
      console.warn('[VoiceLoop] emit BusEvent 抛错(已捕获):', err);
    }
    // 可追溯:状态迁移成功后 emit `state` from→to(§4 state)。
    this.#emitTrace({ kind: 'state', from, to });
    return true;
  }

  /** 把 VoiceBusEvent 桥接为 protocol BusEvent（各 action 的 data 载荷形状不同）。 */
  #emit(event: VoiceBusEvent, opts?: { readonly text?: string; readonly reason?: string }): void {
    const corr = this.#bus.currentCorrelationId() ?? `${this.#sessionId}/voice/${this.#gen}`;
    const at = this.#now();
    switch (event) {
      case 'vad:speech_start':
        this.#bus.emit(makeBusEvent('vad:speech_start', { atMs: at }, corr));
        return;
      case 'vad:speech_end':
        this.#bus.emit(makeBusEvent('vad:speech_end', { atMs: at }, corr));
        return;
      case 'stt:final':
        this.#bus.emit(makeBusEvent('stt:final', { text: opts?.text ?? '' }, corr));
        return;
      case 'tts:first_audio':
        this.#bus.emit(makeBusEvent('tts:first_audio', { atMs: at }, corr));
        return;
      case 'turn:end':
        this.#bus.emit(makeBusEvent('turn:end', { reason: 'completed', atMs: at }, corr));
        return;
      case 'turn:interrupt':
        this.#bus.emit(makeBusEvent('turn:interrupt', { reason: opts?.reason ?? 'barge_in' }, corr));
        return;
    }
  }

  // ───────────────────────────── 上行：听 ─────────────────────────────

  /** transport 上行回调：只处理 `audio:input`（下行 tts:chunk 经同一 transport 回环时忽略）。 */
  #onAudio(frame: AudioFrame): void {
    if (frame.type !== 'audio:input') return; // 只消费上行麦克风帧
    try {
      const pcm = frame.payload.audio; // payload.audio 本就是 PcmFrame，直接喂 VAD
      this.#lastFrameSamples = pcm.samples; // 供 EchoGuard 算本帧能量
      this.#lastFrameAtMs = pcm.timestampMs; // 供 EchoGuard 冷却窗起点对齐帧时间轴(确定性)
      // 可追溯:每 ~50 帧(≈500ms)采样一次麦电平(§4 mic-sample);`#traceOn` 短路 → 未注入观测时连计数都不做,零开销。
      if (this.#traceOn && this.#micSampleCount++ % 50 === 0) {
        this.#emitTrace({ kind: 'mic-sample', rmsNorm: this.#frameEnergy01() });
      }
      const result = this.#vad.pushFrame(pcm);
      const evt = result.event;
      // 可追溯:VAD 边沿(两路共用,在 stt-stream/批式分流前统一 emit,§4 vad)。
      if (evt?.type === 'speech_start') this.#emitTrace({ kind: 'vad', event: 'speech_start' });
      else if (evt?.type === 'speech_end') this.#emitTrace({ kind: 'vad', event: 'speech_end' });

      // 连续流式路（§全程流式）:listening/thinking 期持续把麦帧推给云端(服务端 VAD 分句);
      // speaking 期暂停推流(防自家 TTS 回声进 ASR)+ 复用既有 speaking 态打断逻辑(EchoGuard/能量 VAD)。
      // 注:前面已更新 #lastFrameSamples/#lastFrameAtMs(供 EchoGuard),且 result/evt 已算出供打断判定。
      if (this.#useStream) {
        if (this.#state === 'speaking') {
          this.#handleSpeakingBargeIn(pcm, result, evt); // 不推流,只判打断
          return;
        }
        // listening / thinking / endpointing 等非 speaking 态:持续推流(云端归入下一句,简单稳妥)。
        // backchannel 播放期(门控窗内 now < #bcGateUntilMs):暂停上行推流防自家附和音回灌 ASR;
        // 门控按时刻自动解除(不依赖播放回调,绝不卡死推流,§3.2)。未启用 backchannel 时门控恒为 0,逐字现状。
        const now = this.#now();
        // L1 被动能量累计(**不丢帧、纯旁路**):段内(speech_started 后)每帧旁路累计本帧时长与「有声帧」时长,
        // 复用批式 speech-gate 同口径阈值(无 speechGate 时回落 DEFAULT,仅用于累计判有声,绝不改推流)。
        if (this.#inSegment) {
          const cfg = this.#speechGate ?? DEFAULT_SPEECH_GATE_CONFIG;
          const ms = (pcm.samples.length / pcm.sampleRate) * 1000;
          this.#segTotalMs += ms;
          if (normalizedRms(pcm.samples, cfg.fullScale) >= cfg.voicedRmsThreshold) {
            this.#segVoicedMs += ms;
          }
        }
        // EchoGuard Tier2 冷却窗抑制(承批式 listening 分支同款 `#echoGuardSuppresses`,复用不另写门控):
        // 小雪刚说完 cooldownMs 窗内、该帧为低能量混响尾 → **不推流**(跳过该帧),防扬声器尾音回灌
        // 云端 ASR 被转写成「用户输入」致小雪自言自语(机内麦+扬声器无 AEC 时尤甚)。窗内高能量真插话
        // (过冷却高门槛)与冷却窗外帧照常推流;未注入/off EchoGuard → 恒不抑制,逐字现状(向后兼容)。
        const echoSuppressed =
          this.#echoGuard !== undefined && this.#echoGuardSuppresses(pcm.timestampMs);
        if (now >= this.#bcGateUntilMs && !echoSuppressed) {
          try {
            this.#streamSession?.pushAudio(this.#toPcmChunk(pcm));
          } catch {
            /* 推流失败不崩(§3.2) */
          }
        }
        // 每帧 consult 附和决策(命中则播缓存 clip,不占回合、不进状态机);未启用则 no-op。
        if (this.#useBackchannel) this.#maybeBackchannel(now);
        return;
      }

      // listening：检出语音起点 → endpointing，开始累积。
      // EchoGuard Tier2 冷却窗(§3.1):agent 刚说完 cooldownMs 内,用更高 RMS 门槛吸收混响衰减尾巴——
      // 低能量的混响尾被挡(不开启虚假回合),高能量真语音放行(允许用户立刻回话)。
      // 仅在注入 EchoGuard 时介入;冷却窗外(open 态)以 base 门槛判,常态灵敏度逐字不变。
      if (this.#state === 'listening') {
        if (evt?.type === 'speech_start') {
          // Tier2 冷却窗抑制查询(纯查询、不动 barge-in 去抖计数):冷却窗内低能量混响尾 → 挡。
          if (this.#echoGuard !== undefined && this.#echoGuardSuppresses(pcm.timestampMs)) {
            return; // 冷却窗内低能量混响尾 → 不进 endpointing
          }
          this.#audioBuf = [pcm];
          this.#lastVoiceAtMs = pcm.timestampMs;
          this.#go('vad:speech_start');
        }
        return;
      }

      // endpointing：累积音频；据 TurnDetector（静音时长）判「说完」→ thinking
      if (this.#state === 'endpointing') {
        this.#audioBuf.push(pcm);
        // 仍在「说话中」：刷新最近有声时刻，静音时长归零，不接话
        if (result.speaking) {
          this.#lastVoiceAtMs = pcm.timestampMs;
          return;
        }
        // 静音中：据帧时间戳算静音时长喂 TurnDetector（确定性，不读真实时间）
        const silenceMs = Math.max(0, pcm.timestampMs - this.#lastVoiceAtMs);
        if (this.#shouldEndpoint(silenceMs)) {
          this.#emitTrace({ kind: 'endpoint', silenceMs }); // 可追溯:EOU 断句(§4 endpoint)
          this.#beginThinking(); // → thinking（STT + send）
        }
        return;
      }

      // speaking：检出语音起点 → barge_in_pending → v1 即时打断（或经关注闸据 attention_mode 判定）。
      // EchoGuard（§4 软件侧自打断防护）若注入,则在进入打断判定**之前**做连续 N 帧高置信去抖,
      // 压制自家 TTS 回声引起的误打断（真人连续 N 帧仍能可靠打断）。危机/硬打断豁免去抖。
      if (this.#state === 'speaking') {
        this.#handleSpeakingBargeIn(pcm, result, evt);
        return;
      }

      // thinking / barge_in_pending：上行音频暂不驱动迁移（v1）
    } catch (err) {
      // 上行处理任何异常都不应崩；回 listening 兜底
      console.warn('[VoiceLoop] onAudio 抛错(已捕获,回 listening):', err);
      this.#resetToListening();
    }
  }

  /**
   * speaking 态打断判定（§4 barge-in，纯重构自 `#onAudio` 原 speaking 分支,**行为逐字不变**）：
   * EchoGuard 注入则先连续 N 帧高置信去抖(压自家 TTS 回声误打断;危机/硬打断豁免);
   * 未注入 attention → 检出语音即时打断;注入 attention → 据 attention_mode 判真打断(§7 软反转)。
   * 批式 STT 路(原 `#onAudio`)与连续流式路(`#useStream` 分支)都复用本方法。
   */
  #handleSpeakingBargeIn(
    pcm: PcmFrame,
    result: VadFrameResult,
    evt: VadFrameResult['event'],
  ): void {
    if (this.#echoGuard !== undefined) {
      // 危机/硬打断豁免:经 attention 的 buildSignal 取信号,若标 crisis/hardInterrupt 则绕过 N 帧去抖。
      if (!this.#echoGuardConfirms(result, pcm.timestampMs, evt?.type === 'speech_start')) {
        return; // 未确认(回声毛刺/连续帧不足)→ 保持 speaking,只感知不打断
      }
      // 已确认(连续 N 帧 / 危机豁免):落到下方既有打断判定(未注入 attention→即时;注入→按 mode)。
    }

    if (this.#attention === undefined) {
      // 未注入关注闸（autonomy 默认关）：逐字保持现状——检出语音起点即进 barge_in_pending 即时打断。
      // 注:EchoGuard 注入时,确认由 #echoGuardConfirms 决定(上方已 return 拦截未确认帧),
      //     故此处确认后无论本帧是否 speech_start 事件都应打断（连续第 N 帧可能非 start 事件）。
      if (evt?.type === 'speech_start' || this.#echoGuard !== undefined) {
        if (this.#go('vad:speech_start')) {
          this.#interrupt(); // barge_in_pending → listening
        }
      }
      return;
    }
    // 注入关注闸（§7 软反转）：
    // - 首次检出语音起点：记用户开口起点，立即按 attention_mode 判一次（companion/balanced 即打断；
    //   focus 未达坚持门槛则仅感知不打断，保持 speaking）。
    // - 用户持续出声（result.speaking 且已记起点）：随 sustainedMs 增长重判（focus 坚持够即打断）。
    if (evt?.type === 'speech_start') {
      this.#userSpeechStartAtMs = pcm.timestampMs;
      this.#applyAttention(pcm.timestampMs);
    } else if ((result.speaking || this.#echoGuard !== undefined) && this.#userSpeechStartAtMs !== null) {
      this.#applyAttention(pcm.timestampMs);
    } else if (this.#echoGuard !== undefined && this.#userSpeechStartAtMs === null) {
      // EchoGuard 确认但尚未记起点(连续帧确认在 start 事件之外):补记起点并判一次。
      this.#userSpeechStartAtMs = pcm.timestampMs;
      this.#applyAttention(pcm.timestampMs);
    }
  }

  /** 问 TurnDetector 当前是否该接话（endpointing 期）。 */
  #shouldEndpoint(silenceMs: number): boolean {
    try {
      const decision = this.#turnDetector.step({
        window: this.#audioBuf,
        silenceMs,
        lang: DEFAULT_LANG,
      });
      return decision.shouldEndpoint;
    } catch (err) {
      console.warn('[VoiceLoop] turnDetector.step 抛错(视作未说完):', err);
      return false;
    }
  }

  /**
   * endpointing → thinking 分流（§4 双路径）：
   * - 注入了 omni 端口 **且** `voicePath==='omni'` → audio-in 直路（`#startThinkingOmni`，
   *   让模型直接「听」原始音频感知语气/情绪，§7#5 prosody）。
   * - 否则 → 现有 STT→LLM 路径（`#startThinking`，**逐字不变**）。
   * 双保险：omni 端口缺失（即便 voicePath=omni）也回落 STT，绝不空转。
   */
  #beginThinking(): void {
    // 单回合守卫(single-flight)+ 关重入窗：endpointing→committing（瞬态忙）。
    // 一旦迁入 committing,`#onAudio` 的 endpointing 分支不再累积/判 EOU → 转写在途期间不可能并发
    // 起第二个回合（批式卡死竞态从源头消除）。仅在 endpointing 才合法,非 endpointing → go 返回 false → 拒绝起步。
    if (!this.#go('eou')) return;
    if (this.#omni !== undefined && this.#voicePath === 'omni') {
      void this.#startThinkingOmni(this.#omni);
    } else {
      void this.#startThinking();
    }
  }

  // ───────────────────────────── 想：STT + send ─────────────────────────────

  /**
   * 起一个回合：STT 转写累积音频 → send（onToken 流式凑句喂 TTS）。
   * 空文本/异常 → 回 listening（降级）。
   */
  async #startThinking(): Promise<void> {
    const gen = ++this.#gen; // 捕获本回合令牌
    const buf = this.#audioBuf;
    this.#audioBuf = [];

    // 防 ASR 静音幻觉 Layer 2:注入了 speechGate 才门控(不注入=逐字现状)。
    // 伪段(过短/无足够有声内容,如噪声尖峰/纯静音):不送 ASR,静默回 listening(与空转写同处理)。
    if (this.#speechGate !== undefined) {
      const passed = passesSpeechGate(buf, this.#speechGate);
      // 可追溯:段级门判定(§4 speech-gate);totalMs/voicedMs 复用 speech-gate 同口径汇总,仅注入观测时计算。
      if (this.#traceOn) {
        const cfg = this.#speechGate;
        let totalMs = 0;
        let voicedMs = 0;
        for (const f of buf) {
          const ms = (f.samples.length / f.sampleRate) * 1000;
          totalMs += ms;
          if (normalizedRms(f.samples, cfg.fullScale) >= cfg.voicedRmsThreshold) voicedMs += ms;
        }
        this.#emitTrace({ kind: 'speech-gate', passed, totalMs, voicedMs });
      }
      if (!passed) {
        this.#emitTrace({ kind: 'turn', outcome: 'gated' }); // 可追溯:本回合被段级门拦下(§4 turn)
        this.#resetToListening();
        return;
      }
    }

    // 可追溯:送 STT 前的音频摘要(§4 stt-input);仅注入观测时汇总(零开销)。
    if (this.#traceOn) {
      const { durationMs, rmsNorm } = this.#bufSummary(buf);
      this.#emitTrace({ kind: 'stt-input', path: 'stt', durationMs, rmsNorm });
    }

    let text: string;
    let emotion: SttEmotion | undefined;
    try {
      const r = await this.#transcribe(buf);
      text = r.text;
      emotion = r.emotion; // §7#5:STT 读出的语气情绪(qwen-asr 填,其余 undefined),稍后透传给 #send。
    } catch (err) {
      console.warn('[VoiceLoop] STT 抛错(降级回 listening):', err);
      this.#emitTrace({ kind: 'turn', outcome: 'error' }); // 可追溯:STT 失败(§4 turn)
      this.#resetToListening();
      return;
    }
    // 可追溯:批式转写结果(§4 stt-result);emotion 仅取标签(trace 为 string),lang 批式不可得 → 省略。
    this.#emitTrace({
      kind: 'stt-result',
      text,
      isFinal: true,
      ...(emotion !== undefined ? { emotion: emotion.label } : {}),
    });
    // 转写期间被打断/换回合：**失配必恢复**——绝不裸 return 留卡死,统一收口回 listening(§3.2)。
    if (gen !== this.#gen) {
      this.#resetToListening();
      return;
    }
    if (text.trim().length === 0) {
      // 空转写：降级回 listening（此时处 committing 态，用 vad:speech_end 合法迁移）。
      this.#emitTrace({ kind: 'turn', outcome: 'empty' }); // 可追溯:空转写(§4 turn)
      this.#resetToListening();
      return;
    }

    // 拿到 text/emotion 后的回合执行段统一走 #runTurn(批式路与连续流式路共用)；
    // 批式路此刻处 committing,#runTurn 据当前态合法迁移进 thinking,状态非预期则其内部 resetToListening 兜底。
    this.#runTurn(text, emotion, gen);
  }

  /**
   * 回合执行核心（从「拿到 text/emotion」到 send+speak 收尾，批式 STT 路与连续流式路**共用**）。
   *
   * **前置**:调用方已确保当前态可经合法迁移进 thinking。本方法据当前态合法迁移:
   *   - `endpointing`（批式路 #startThinking）→ `stt:final` → thinking;
   *   - `listening`（连续流式路 #runStreamTurn，迁移表无 listening→thinking 直达）→ 先补
   *     `vad:speech_start`(→endpointing) 再 `stt:final`(→thinking) 两步;
   *   - 其余态 / 任一迁移失败 → `#resetToListening` 兜底(§3.2 永不崩)。
   *
   * 迁移成功后:onToken 凑句串行喂 `#speak`(保句序)、透传本回合 `ac.signal`(打断真停底层 LLM/TTS)、
   * emotion 经 `#send` 第 4 参并入 PAD;`.finally` 清本回合控制器。**纯重构,行为与原 #startThinking 一致**。
   */
  #runTurn(text: string, emotion: SttEmotion | undefined, gen: number): void {
    // 合法迁移进 thinking：
    //   - 连续流式路从 listening 需先补一步 vad:speech_start 到 endpointing;
    //   - 批式路此刻处 committing（#beginThinking 已迁入）;两者都经 stt:final → thinking。
    if (this.#state === 'listening') {
      if (!this.#go('vad:speech_start')) {
        this.#resetToListening();
        return;
      }
    }
    // committing（批式）/ endpointing（流式补步后）→ thinking（emit stt:final 带真转写文本）。
    // 状态非预期 / 迁移失败 → resetToListening 兜底(§3.2 永不卡死)。
    if (
      (this.#state !== 'committing' && this.#state !== 'endpointing') ||
      !this.#go('stt:final', { text })
    ) {
      this.#resetToListening();
      return;
    }

    // 起想：onToken 凑句**串行**喂 #speak（保句序 + 便于在 send 完成后等全部出尽再收尾）。
    this.#replyAccum = '';
    const splitter = new SentenceSplitter();
    // 本回合取消控制器（§3.2 真打断）：打断/停止时 abort 之，使底层 LLM 流 + 在途 TTS 合成真停（不再后台跑到完）。
    const ac = new AbortController();
    this.#currentAbort = ac;

    // ── CosyVoice 连接预热(承「砍首音建连+握手开销」)──
    // 在 STT 已就绪、LLM 首 token 之前就开 WS + run-task 握手:`synthesizeStream()` 同步建连并(open 后)发 run-task,
    // 文本经 `push` 后到(内部缓冲到 task-started),首句就绪即 continue-task → 首 chunk 不再含建连+握手。
    // 与 `#send`(LLM)**并行**:开会话不 await,绝不阻塞首 token。仅 TTS 支持流式喂且未降级时启用;
    // 同步抛(能力门 fail-fast)/不支持 → session=null → 回落逐句 synthesize(逐字现状,纯加法向后兼容)。
    const session = this.#openWarmTtsSession(gen);
    // session 非空 → 单条 warm 会话的 chunks 由 drain 统一消费(下行+首音迁移+gen 自检);否则空转。
    const drain: Promise<void> = session !== null ? this.#drainTtsSession(session, gen, ac.signal) : Promise.resolve();

    // 串行说话链:每句接在上一句之后,保证下行 tts:chunk 顺序与句序一致(仅逐句回落路用)。
    let speakChain: Promise<void> = Promise.resolve();
    // 透传本回合 ac.signal 到 #speak → tts.synthesize：打断/停止 abort() 后,在途 TTS 合成真停（§3.2）。
    // onToken 凑句与 send 完成后的尾句 flush 共用此闭包,故一处带上 signal 即覆盖全部喂句。
    // warm 会话路:逐句 `push`(同一 run-task 多 continue-task,消除句间重连);否则逐句 synthesize。
    const enqueueSpeak =
      session !== null
        ? (sentence: string): void => {
            session.push(sentence);
          }
        : (sentence: string): void => {
            speakChain = speakChain.then(() => this.#speak(sentence, gen, ac.signal));
          };
    const onToken = (tok: string): void => {
      if (gen !== this.#gen) return; // 作废：本回合已被打断/替换
      this.#replyAccum += tok;
      for (const sentence of splitter.push(tok)) enqueueSpeak(sentence);
    };

    // §7#5:把 STT 读出的语气情绪经第 4 参透传给 send(→ persona.advance 并入 PAD);
    // emotion 缺省(其余 provider / 文字路)即第 4 参 undefined,调用形状与现状等价、行为不变。
    this.#currentTurn = this.#send(text, onToken, ac.signal, emotion)
      .then(async (full) => {
        if (gen !== this.#gen) return; // 已被打断：忽略输出（协作式放弃）
        // 累积以 send 返回的完整回复为准(onToken 可能漏拼)
        if (full.length >= this.#replyAccum.length) this.#replyAccum = full;
        const tail = splitter.flush();
        if (tail !== null) enqueueSpeak(tail);
        // 等所有句出尽(首句已触发 thinking→speaking)再收尾:
        // warm 会话路 → finish(发 finish-task) + await drain 把剩余音频放尽;逐句路 → await speakChain。
        if (session !== null) {
          session.finish();
          await drain;
        } else {
          await speakChain;
        }
        this.#finishTurn(gen);
      })
      .catch((err) => {
        // 被打断的回合(gen 已变)其 send 多以 AbortError reject —— 属正常取消,静默忽略不重复 reset;
        // 仅当仍是本回合(真错误)才 warn + 回 listening 兜底(§3.2)。
        if (gen === this.#gen) {
          console.warn('[VoiceLoop] send 抛错(回 listening):', err);
          this.#emitTrace({ kind: 'turn', outcome: 'error' }); // 可追溯:send 真失败(§4 turn)
          this.#resetToListening();
        }
      })
      .finally(() => {
        // 回合自然结束/出错收尾后清理本回合控制器(若仍是它);打断已在 #interrupt 里清。
        if (this.#currentAbort === ac) {
          this.#currentAbort = null;
          return;
        }
        // 本回合已被超越/取消(currentAbort 已是别的回合或被清):若**管线无新主**(currentAbort===null)
        // 却仍卡在瞬态忙(committing/thinking/endpointing),收口回 listening——绝不留卡死(回合并发竞态兜底)。
        // 若已有新回合在跑(currentAbort 非 null 且非 ac),则**不**复位,避免误清新回合状态。
        if (this.#currentAbort === null && this.#isTransientBusy()) {
          this.#resetToListening();
        }
      });
  }

  /** 当前是否卡在「瞬态忙」(非稳定 listening/speaking,无对应自然收尾事件触达)——供超越/失配后的兜底收口判定。 */
  #isTransientBusy(): boolean {
    return (
      this.#state === 'committing' || this.#state === 'thinking' || this.#state === 'endpointing'
    );
  }

  /**
   * 连续流式路：一句 final 起一个回合（§全程流式）。空文本忽略;`gen=++#gen` 抢占;
   * 经 `#runTurn` 据当前态(常为 listening)合法迁移进 thinking。迁移失败 → `#runTurn` 内已 resetToListening。
   * emotion 经 `#runTurn` 的 `#send` 第 4 参并入 PAD(与批式路同一通道)。
   */
  #runStreamTurn(text: string, emotion?: SttEmotion): void {
    if (text.trim().length === 0) return; // 空 final 忽略
    // **超越必取消**：起新回合前先真 abort 旧回合(LLM/TTS 底层流真停),不再直接覆盖 #currentAbort 让旧回合后台跑到完。
    this.#abortCurrent();
    // 收口旧回合残留态(thinking/speaking/...)→ 让新句能干净从 listening 起步,**绝不静默丢弃新句**
    // (旧 runStreamTurn 在 thinking 态下新句会命中 #runTurn 兜底被 resetToListening 吞掉)。
    this.#resetToListening();
    const gen = ++this.#gen; // 抢占:本句成为当前回合(在 abort/复位之后自增,旧 onToken/TTS 据此作废)
    this.#runTurn(text, emotion, gen);
  }

  /**
   * 流式 onFinal 联合判伪(L2 主门,防 ASR 静音/噪声幻觉)。返回判伪归因(丢弃)或 null(放行)。
   *
   * 判别顺序(黑名单为默认主防御、纯能量门可选):
   *   ① 空文本 → 'empty'(逐字现状,无门也丢)。
   *   ② **无段证据(无 speech_started/快照,协议异常)→ 降级保守放行**(只过空文本,不靠能量误杀;
   *      黑名单的「低能量」合取也无从判定,故同样放行)。
   *   ③ **纯低能量门(可选、默认关,`#streamEnergyGate===true` ∧ 注入 speechGate 才生效)**:
   *      `!meetsSpeechGate(快照)` → 'low-energy'。**默认关原因**:本地段能量在某些麦(蓝牙 HFP 放音期/前后)
   *      极不可靠——真内容词(qwen 真转写出,如「十点」「我觉得」)会因段快照 voicedMs=0 被误杀;纯能量门弊大于利
   *      (丢真话),故默认不开,仅 opt-in 给本地能量可靠的麦。
   *   ④ 残差黑名单(注入 fillerDenylist 时,**默认主防御**):精确命中已知填充词(「嗯/啊/thank you/谢谢观看」等)
   *      ∧ 段 voiced < minVoicedMs → 'denylist'(真说「嗯」有 voiced 能量 → 合取不成立 → 放行;只作用于已知填充
   *      短语,不会误杀内容词)。
   * **纯查询、无副作用**(状态/快照清理在调用方),便于确定性测试。
   */
  #gateStreamFinal(text: string): 'empty' | 'low-energy' | 'denylist' | null {
    if (text.trim().length === 0) return 'empty';
    const snap = this.#segSnapshot;
    if (snap === null) return null; // 降级:无段证据 → 保守放行(不靠能量误杀)
    // ③ 纯低能量门(可选、默认关):仅 #streamEnergyGate 显式开 ∧ 注入 speechGate 时生效;段过短/无足够有声 → 判伪。
    //    默认关:本地能量在蓝牙 HFP 放音期等不可靠,会误杀真内容词(voicedMs=0)——黑名单(④)才是默认主防御。
    if (
      this.#streamEnergyGate &&
      this.#speechGate !== undefined &&
      !meetsSpeechGate({ totalMs: snap.segTotalMs, voicedMs: snap.segVoicedMs }, this.#speechGate)
    ) {
      return 'low-energy';
    }
    // ④ 残差黑名单(仅注入 fillerDenylist 时):精确命中 ∧ 段低能量(voiced<minVoicedMs)才丢。
    if (this.#fillerDenylist !== undefined && isDenylistedFiller(text, this.#fillerDenylist)) {
      const minVoicedMs = (this.#speechGate ?? DEFAULT_SPEECH_GATE_CONFIG).minVoicedMs;
      if (snap.segVoicedMs < minVoicedMs) return 'denylist';
    }
    return null;
  }

  // ───────────────────────────── backchannel 附和（全双工 v1）─────────────────────────────

  /**
   * 每帧 consult backchannel 决策核(仅 stt-stream 路、注入了 backchannel 时调用)：
   * 据外置 `#bcState` 与注入配置判是否到附和点;命中则懒合成/缓存 clip 并下行播放(`#playBackchannel`)。
   * **不占回合、不进 thinking/speaking 状态机、不调 `#send`/LLM**。决策抛错静默跳过(§3.2)。
   */
  #maybeBackchannel(nowMs: number): void {
    if (this.#backchannel === undefined) return;
    let d: ReturnType<typeof decideBackchannel>;
    try {
      d = decideBackchannel(this.#bcState, nowMs, this.#backchannel);
    } catch (err) {
      console.warn('[VoiceLoop] backchannel 决策抛错(已捕获,跳过):', err);
      return;
    }
    this.#bcState = d.state;
    if (d.fire && d.clipText !== undefined) {
      this.#emitTrace({ kind: 'backchannel', fired: true, clipText: d.clipText }); // 可追溯:附和命中(§4 backchannel)
      void this.#playBackchannel(d.clipText);
    }
  }

  /**
   * 播一句附和 clip(懒合成+缓存);**绝不占回合、不改状态机、不调 `#send`**(承全双工 v1 关键约束)。
   * 缓存命中则直接复用;首次以 `#tts.synthesize(clipText, #ttsOptions)` 合成并缓存(与 `#speak` 同通道)。
   * 按 clip 时长 + 余量设上行门控截止 `#bcGateUntilMs`——**按时刻自动解除**(不依赖播放回调,绝不卡死推流);
   * 经 `#transport.sendAudio(#toTtsFrame(...))` 下行播放,不经状态机/不触发 tts:first_audio。
   * 任何失败(合成/下行)静默跳过(§3.2),绝不拖累主对话。
   */
  async #playBackchannel(clipText: string): Promise<void> {
    try {
      let chunks = this.#bcClipCache.get(clipText);
      if (chunks === undefined) {
        chunks = [];
        for await (const c of this.#tts.synthesize(clipText, this.#ttsOptions)) chunks.push(c);
        this.#bcClipCache.set(clipText, chunks);
      }
      // 门控上行 = clip 总时长 + 余量(按时刻自动解除,绝不卡死推流,§3.2)。
      const durMs = chunks.reduce((a, c) => a + (c.samples.length / c.sampleRate) * 1000, 0);
      this.#bcGateUntilMs = this.#now() + durMs + 200;
      // 下行播放:不改状态机(不进 speaking、不 emit tts:first_audio),附和不占回合。
      for (const c of chunks) this.#transport.sendAudio(this.#toTtsFrame(c));
    } catch (err) {
      console.warn('[VoiceLoop] backchannel 跳过(不影响对话):', err);
    }
  }

  // ───────────────────────────── 想：omni audio-in 直路（path B）─────────────────────────────

  /**
   * 起一个 omni 直路回合（§4 双路径 / §7#5 prosody）：endpointing 攒的音频帧**不喂 STT**，
   * 而喂 `omni.respondToAudio(audio, opts, signal)`（opts 携 persona/记忆/语气组装的 instructions），消费事件：
   * - `transcript`（首条）→ 当作本轮用户话语：写记忆（role:'user'，供记忆/召回）+ `#go('stt:final')`
   *   推进 endpointing→thinking（复用现有迁移，转写来源不同、语义相同）。
   * - `text` → 回复增量，累积 `#replyAccum` + 既有 `SentenceSplitter` 分句 → 既有 `#speak` → TTS。
   * - `end`（或流自然结束）→ flush 尾句、等出尽、`#finishTurn` 收尾。
   *
   * 与 `#startThinking` **结构对称**：共享 gen 捕获、本回合 `AbortController`（透传 signal 到
   * `respondToAudio` → 打断/停止时底层 WS 流真停，§3.2）、`enqueueSpeak`/`#speak`、`#finishTurn`、
   * generation 自检与半句写回（`#interrupt` 原样复用，**不重写打断核心**）。
   * omni 失败（连接/鉴权/WS 意外关闭/抛错且本回合未被打断）→ 干净回 listening 不崩（§3.2 降级）。
   */
  async #startThinkingOmni(omni: OmniAudioPort): Promise<void> {
    const gen = ++this.#gen; // 捕获本回合令牌
    const buf = this.#audioBuf;
    this.#audioBuf = [];

    // 可追溯:送 omni 前的音频摘要(§4 stt-input,path='omni');仅注入观测时汇总(零开销)。
    if (this.#traceOn) {
      const { durationMs, rmsNorm } = this.#bufSummary(buf);
      this.#emitTrace({ kind: 'stt-input', path: 'omni', durationMs, rmsNorm });
    }

    this.#replyAccum = '';
    const splitter = new SentenceSplitter();
    // 本回合取消控制器（§3.2 真打断）：abort 之 → 传给 respondToAudio 的 signal aborted → 底层 WS 真停。
    const ac = new AbortController();
    this.#currentAbort = ac;
    // 串行说话链（与 STT 路径同）：保下行 tts:chunk 句序，透传本回合 signal 给 TTS 合成。
    let speakChain: Promise<void> = Promise.resolve();
    const enqueueSpeak = (sentence: string): void => {
      speakChain = speakChain.then(() => this.#speak(sentence, gen, ac.signal));
    };

    const self = this;
    async function* toChunks(): AsyncIterable<PcmChunk> {
      for (const f of buf) yield self.#toPcmChunk(f);
    }

    let sawTranscript = false; // 仅首条 transcript 触发迁移/写记忆（避免重复迁移）
    // omni-prosody-to-pad（方案 A）:流式剥 `[user_emotion:label-intensity]` 标签——
    // `pendingText` 暂存「可能是半截标签」的尾巴(hold-back),保证标签**绝不**进 TTS/显示/记忆;
    // `lastEmotion` 记本轮解析出的最后一个合法情绪,收尾时经 `#advanceProsody` 喂 PAD(复用 prosodyToPadPull)。
    let pendingText = '';
    let lastEmotion: SttEmotionLike | undefined;
    // 把一段「确认安全可出」的文本(已无完整标签)累积进 #replyAccum 并分句喂 TTS。
    const consumeClean = (clean: string): void => {
      if (clean.length === 0) return;
      this.#replyAccum += clean;
      for (const sentence of splitter.push(clean)) enqueueSpeak(sentence);
    };
    this.#currentTurn = (async () => {
      try {
        // 组装本回合系统提示（persona/记忆/语气，§5.4/§6）：在开 WS / 首音前先取（失败/空→空 opts，§3.2/§5.5）。
        const instructions = await this.#composeOmniInstructionsSafe();
        const opts: OmniAudioOpts = instructions !== undefined ? { instructions } : {};
        for await (const ev of omni.respondToAudio(toChunks(), opts, ac.signal)) {
          if (gen !== this.#gen) return; // 被打断/换回合：协作式放弃
          if (ev.type === 'transcript') {
            const text = ev.text.trim();
            if (text.length > 0 && !sawTranscript) {
              sawTranscript = true;
              // 可追溯:omni 首条 transcript = 本轮用户话语(§4 stt-result);omni 无独立 emotion/lang 通道 → 省略。
              this.#emitTrace({ kind: 'stt-result', text, isFinal: true });
              // committing → thinking（emit stt:final 带真转写文本，复用现有迁移）。
              // omni 路经 #beginThinking 已迁入 committing(关重入窗);首条 transcript 才推进到 thinking。
              if (this.#state === 'committing') this.#go('stt:final', { text });
              // 写记忆：本轮用户话语（等价 STT 文本，供记忆/召回）。
              try {
                this.#memory.appendMessage({
                  sessionId: this.#sessionId,
                  turnId: 'omni',
                  role: 'user',
                  content: text,
                  createdAtMs: this.#now(),
                });
              } catch (err) {
                console.warn('[VoiceLoop] omni transcript 写记忆抛错(已捕获):', err);
              }
            }
          } else if (ev.type === 'text') {
            // 累积到 pending,切出「保证不可能再属于未完成标签前缀」的安全部分(hold-back);
            // 安全部分里若已含**完整**标签(如中段标签后又跟正文)则就地剥除并记最后情绪。
            pendingText += ev.text;
            const { emit, hold } = splitSafeTextForTag(pendingText);
            pendingText = hold;
            if (emit.length > 0) {
              const { cleanText, emotion } = stripUserEmotionTag(emit);
              if (emotion !== undefined) lastEmotion = emotion;
              consumeClean(cleanText);
            }
          } else {
            // 'end'：flush 尾句后跳出（下方统一等出尽 + 收尾）。
            break;
          }
        }
        if (gen !== this.#gen) return; // 流结束时已被打断
        // 收尾:对暂留的尾巴(此时含完整标签或残余)做最终剥离,把干净正文喂出、记最后情绪。
        if (pendingText.length > 0) {
          const { cleanText, emotion } = stripUserEmotionTag(pendingText);
          if (emotion !== undefined) lastEmotion = emotion;
          consumeClean(cleanText);
          pendingText = '';
        }
        const tail = splitter.flush();
        if (tail !== null) enqueueSpeak(tail);
        await speakChain; // 等所有句出尽(首句已触发 thinking→speaking)再收尾
        // §7#5 prosody→PAD:把本轮解析出的语气情绪喂进情感内核(复用 prosodyToPadPull,经装配层钩子)。
        // 缺省不注入 / 无标签(lastEmotion undefined) → 不调,omni 路逐字现状;失败吞错不中断回合(§3.2)。
        await this.#feedProsody(gen, lastEmotion);
        this.#finishTurn(gen);
      } catch (err) {
        // 被打断回合(gen 已变)其 respondToAudio 多以 AbortError reject —— 属正常取消,静默忽略;
        // 仅当仍是本回合(真失败:连接/鉴权/WS 意外关闭)才 warn + 向用户播报友好提示 + 干净回 listening 降级(§3.2)。
        if (gen === this.#gen) {
          // 堆栈仅留 console(调试用),绝不泄露给用户。
          console.warn('[VoiceLoop] omni 直路失败(降级回 listening + 播报提示):', err);
          this.#emitTrace({ kind: 'turn', outcome: 'error' }); // 可追溯:omni 直路失败(§4 turn)
          // §3.2 永不哑:用 TTS 说一句友好降级提示,让用户知道「没接上」而非伴侣静默哑火。
          await this.#speakFailureNotice(gen, ac.signal);
          this.#resetToListening();
        }
      } finally {
        if (this.#currentAbort === ac) {
          this.#currentAbort = null;
        } else if (this.#currentAbort === null && this.#isTransientBusy()) {
          // 与批式 #runTurn 一致:本回合被超越/取消且管线无新主却仍卡瞬态忙 → 收口回 listening(绝不卡死)。
          this.#resetToListening();
        }
      }
    })();
  }

  /**
   * 把 omni 回合解析出的语气情绪喂进 PAD（omni-prosody-to-pad，§7#5 prosody，§3.2 降级）：
   * - 未注入 `#advanceProsody` 钩子 / 无情绪(undefined) → 不调,omni 路逐字现状(零回归)。
   * - gen 失配(已被打断/换回合) → 不喂(协作式放弃)。
   * - 钩子可同步/异步;抛错或 reject 被捕获并记 warn,**绝不中断回合**(收尾照常)。
   */
  async #feedProsody(gen: number, emotion: SttEmotionLike | undefined): Promise<void> {
    if (gen !== this.#gen) return;
    const hook = this.#advanceProsody;
    if (hook === undefined || emotion === undefined) return;
    try {
      await hook(emotion);
    } catch (err) {
      console.warn('[VoiceLoop] omni prosody→PAD 钩子抛错(已捕获,不影响回合):', err);
    }
  }

  /**
   * omni 直路失败时用 TTS 播报一句友好降级提示(§3.2 永不哑;仅 omni 路调用,STT 路不经此)。
   *
   * **复用既有 `#speak`**(同一 TTS 下行机制,不新造通道):
   * - 失败时状态多为 `endpointing`(连接/鉴权失败常在 yield 前抛,尚未 `stt:final`)或 `thinking`/`speaking`;
   *   为让提示以正常「说话」形态下行(`tts:first_audio→speaking` 可追溯 + EchoGuard 一致),仍在 `endpointing`
   *   时**硬推进**到 `thinking`(降级瞬态,**不** emit `stt:final` 以免把提示误记为用户话语)。
   * - 提示音合成本身再失败(如网络全断)由 `#speak` 内部吞错——已尽力,绝不二次抛(§3.2)。
   * 收尾(speaking→listening 的 `turn:end`)由调用方 `#resetToListening` 统一处理。
   */
  async #speakFailureNotice(gen: number, signal?: AbortSignal): Promise<void> {
    if (gen !== this.#gen) return; // 已被打断/换回合:不抢着播旧回合的提示
    // 让 #speak 的 thinking→speaking 迁移成立:omni 失败常停在 committing(连接/鉴权在首 transcript 前抛)或 endpointing。
    if (this.#state === 'endpointing' || this.#state === 'committing') this.#state = 'thinking';
    await this.#speak(VOICE_FAILURE_NOTICE, gen, signal);
  }

  /**
   * 安全组装 omni 直路系统提示（§5.4/§6 人格，§3.2/§5.5 降级）：
   * - 未注入 `#composeOmniInstructions` → 返回 undefined（omni 路退回空 opts，与本切片前逐字一致）。
   * - 注入则 `await` 之并 try/catch：抛错/超时/返回空白串 → 返回 undefined（退回空 opts，记 warn）。
   * 绝不崩、绝不抛、不阻塞回合（失败立即兜底，不卡 omni 首音）。
   */
  async #composeOmniInstructionsSafe(): Promise<string | undefined> {
    const compose = this.#composeOmniInstructions;
    if (compose === undefined) return undefined;
    try {
      const text = await compose();
      const trimmed = typeof text === 'string' ? text.trim() : '';
      return trimmed.length > 0 ? text : undefined;
    } catch (err) {
      console.warn('[VoiceLoop] omni 系统提示组装抛错(退回空 opts,不影响回合):', err);
      return undefined;
    }
  }

  /**
   * 收尾：send 完成后置 turn:end → listening。
   * v1 简化：不等播放真正排空（Fake TTS 同步出尽）；gen 失配即不收尾（已被打断）。
   */
  #finishTurn(gen: number): void {
    if (gen !== this.#gen) return;
    this.#emitTrace({ kind: 'turn', outcome: 'replied' }); // 可追溯:回合正常收尾(§4 turn)
    // 仍在 speaking 才合法迁移 turn:end;若从未进 speaking(无音频)则直接回 listening
    if (this.#state === 'speaking') {
      this.#go('turn:end');
    } else {
      this.#resetToListening();
    }
    this.#replyAccum = '';
    this.#echoGuard?.reset(); // 清自打断防护连续计数(回合自然结束)
  }

  /**
   * 把累积音频帧转 PcmChunk 流喂 STT,取最后一条 final 文本(无 final 取最后一条)。
   * §7#5:额外回传该条结果的 prosody 情绪 `emotion?`(qwen-asr 等会填,其余 provider 恒 undefined)——
   * 取「被采纳为最终文本」那一条 `SttResult` 的 emotion(优先 final;无 final 取 lastAny 那条),纯加法。
   */
  async #transcribe(buf: readonly PcmFrame[]): Promise<{ text: string; emotion?: SttEmotion }> {
    const self = this;
    async function* toChunks(): AsyncIterable<PcmChunk> {
      for (const f of buf) yield self.#toPcmChunk(f);
    }
    let lastFinal = '';
    let lastAny = '';
    let lastFinalEmotion: SttEmotion | undefined;
    let lastAnyEmotion: SttEmotion | undefined;
    // §4.1:注入了输入语种则以 SttOptions.language 传给 STT(指定语种);未注入 → opts=undefined →
    // 调用形状与现状 `transcribe(toChunks())` 字面等价(STT 自动检测,逐字现状)。
    const sttOpts = this.#sttLanguage !== undefined ? { language: this.#sttLanguage } : undefined;
    for await (const r of this.#stt.transcribe(toChunks(), sttOpts)) {
      lastAny = r.text;
      lastAnyEmotion = r.emotion;
      if (r.isFinal) {
        lastFinal = r.text;
        lastFinalEmotion = r.emotion;
      }
    }
    const useFinal = lastFinal.length > 0;
    const text = useFinal ? lastFinal : lastAny;
    const emotion = useFinal ? lastFinalEmotion : lastAnyEmotion;
    // exactOptionalPropertyTypes:仅在有 emotion 时带键(缺席=无语音情绪,下游不传给 send,行为不变)。
    return emotion !== undefined ? { text, emotion } : { text };
  }

  // ───────────────────────────── 说：TTS 下行 ─────────────────────────────

  /**
   * 合成并下行一句：把本回合 `signal` 传进 `synthesize`，使打断/停止 abort() 后**在途 TTS 合成真停**
   * （§3.2 真打断，不再后台跑到完——对 WebSocket realtime TTS 尤为关键，省额度/释连接）；
   * 逐 chunk 仍自检 `gen === #gen` 作为**双保险**（signal 停底层产出 + generation 作废已产出输出），
   * 通过则转 tts:chunk 帧 sendAudio。首个下行 chunk 触发 tts:first_audio（thinking → speaking）。
   * `signal` 可选、向后兼容：缺省时 `synthesize` 调用形状与现状等价。
   */
  async #speak(sentence: string, gen: number, signal?: AbortSignal): Promise<void> {
    if (gen !== this.#gen) return; // 进入即自检（本回合已作废）
    try {
      // §4.1:注入了 ttsOptions(output_lang/voice_id/clone_ref)则传给 synthesize(指定输出语种/音色/复刻);
      // 未注入 → #ttsOptions=undefined → 与现状 `synthesize(sentence, undefined, signal)` 字面等价(逐字现状)。
      for await (const chunk of this.#tts.synthesize(sentence, this.#ttsOptions, signal)) {
        if (gen !== this.#gen) return; // 每 chunk 再自检：打断后旧 gen 帧不再下行
        // 首音频：thinking → speaking（仅在 thinking 态时迁移,幂等）
        if (this.#state === 'thinking') {
          this.#go('tts:first_audio');
        }
        this.#transport.sendAudio(this.#toTtsFrame(chunk));
      }
    } catch (err) {
      console.warn('[VoiceLoop] TTS 合成抛错(跳过本句):', err);
    }
  }

  // ───────────────────────────── 说：warm 会话预热（砍首音建连+握手）─────────────────────────────

  /**
   * 回合起点开一条 **warm TTS 会话**(预热):`synthesizeStream()` 同步建连并(open 后)发 run-task 握手,
   * 与 `#send`(LLM)并行进行——首句就绪时直接 `push`(continue-task),首 chunk 不再含建连+握手开销。
   *
   * 仅在 TTS 支持流式喂(`supportsStreamingFeed`)且未降级(`#ttsStreamDegraded`)时尝试;
   * 同步抛(能力门 fail-fast / voiceId 缺失等)→ 吞错返回 null → 调用方回落逐句 synthesize(纯加法,逐字现状)。
   * 成功则记入 `#warmTtsSession`(绑本回合,经 `#abortCurrent`→`#closeWarmSession` 收尾,绝不泄漏)。
   */
  #openWarmTtsSession(_gen: number): TtsStreamSession | null {
    const tts = this.#tts;
    if (this.#ttsStreamDegraded || !supportsStreamingFeed(tts)) return null;
    try {
      const session = tts.synthesizeStream(this.#ttsOptions);
      this.#warmTtsSession = session;
      return session;
    } catch (err) {
      // 预热同步失败(能力门/构造期 fail-fast):静默回落逐句 synthesize,绝不崩(§3.2)。
      console.warn('[VoiceLoop] TTS 预热(synthesizeStream)同步抛,回落逐句合成:', err);
      return null;
    }
  }

  /**
   * 消费 warm 会话的 `chunks`(单条会话覆盖本回合全部句):逐 chunk 自检 `gen===#gen`/`signal.aborted`,
   * 首 chunk 触发 thinking→speaking(与 `#speak` 同语义),转 tts:chunk 帧下行。
   * chunks 抛错(建连/握手/服务端失败)→ 吞错 + 置降级闩(后续回合回落逐句),绝不崩(§3.2);
   * finally 若本会话仍是当前 warm 会话则清引用(被新回合超越时不误清,见 `#warmTtsSession === session` 守卫)。
   */
  async #drainTtsSession(session: TtsStreamSession, gen: number, signal: AbortSignal): Promise<void> {
    try {
      for await (const chunk of session.chunks) {
        if (gen !== this.#gen || signal.aborted) return; // 打断/换回合:旧 gen 帧不再下行
        if (this.#state === 'thinking') this.#go('tts:first_audio'); // 首音:thinking → speaking(幂等)
        this.#transport.sendAudio(this.#toTtsFrame(chunk));
      }
    } catch (err) {
      // 预热会话异步失败:降级闩 → 后续回合回落逐句 synthesize;本回合静默(与 #speak 吞错对齐,绝不崩 §3.2)。
      console.warn('[VoiceLoop] TTS 预热会话合成抛错(降级后续回合回落逐句):', err);
      this.#ttsStreamDegraded = true;
    } finally {
      if (this.#warmTtsSession === session) this.#warmTtsSession = null;
    }
  }

  /** 干净关闭当前 warm 会话(打断/停止/抢占):直接 `abort` 丢弃在途音频、关连接;幂等吞错,绝不泄漏(§3.2)。 */
  #closeWarmSession(): void {
    const session = this.#warmTtsSession;
    this.#warmTtsSession = null;
    if (session === null) return;
    try {
      session.abort();
    } catch (err) {
      console.warn('[VoiceLoop] 关闭 warm TTS 会话抛错(已捕获):', err);
    }
  }

  // ───────────────────────────── 关注闸（§7 软反转）─────────────────────────────

  /**
   * speaking 期用户开口时据 attention_mode 判定是否真打断（§7 软反转）。
   * 仅在注入 `#attention` 时调用（未注入走现状即时打断路径，行为逐字不变）。
   *
   * 流程：算 sustainedMs → `evaluateAttention(mode, signal)` → 若 `trueInterrupt`：
   *   `#go('vad:speech_start')`(speaking→barge_in_pending) + `#interrupt()`(→listening)；
   * 否则（如 focus 未达坚持门槛）保持 speaking，只感知不打断（绝不装聋）。
   * 任何异常被捕获（§3.2）：兜底退回「即时打断」以不漏掉用户。
   */
  #applyAttention(nowFrameMs: number): void {
    const cfg = this.#attention;
    if (cfg === undefined) return;
    try {
      const startedAt = this.#userSpeechStartAtMs ?? nowFrameMs;
      const sustainedMs = Math.max(0, nowFrameMs - startedAt);
      const mode = typeof cfg.mode === 'function' ? cfg.mode() : cfg.mode;
      const signal: UserVoiceSignal = cfg.buildSignal
        ? cfg.buildSignal({ sustainedMs, speaking: true })
        : { sustainedMs, somethingInFlight: true };
      const verdict = evaluateAttention(mode, signal, cfg.options);
      if (verdict.trueInterrupt) {
        this.#userSpeechStartAtMs = null;
        if (this.#go('vad:speech_start')) {
          this.#interrupt(); // barge_in_pending → listening
        }
      }
      // trueInterrupt=false：保持 speaking，仅感知不打断（focus 短促出声 / balanced 无在飞）。
    } catch (err) {
      console.warn('[VoiceLoop] 关注闸判定抛错(兜底即时打断):', err);
      this.#userSpeechStartAtMs = null;
      if (this.#go('vad:speech_start')) this.#interrupt();
    }
  }

  // ───────────────────────────── EchoGuard（§4 软件侧自打断防护）─────────────────────────────

  /** Int16 满量程(能量归一化分母);具名常量,无 magic number。 */
  static readonly #FULL_SCALE = 32_768;

  /**
   * 默认 EchoGuard 决策观测(§3.1 day1 RMS instrument):未注入自定义观测时用此最简结构化日志。
   * 只在「被门控挡住」时打 debug(放行属常态,不刷屏);RMS/tier/门槛/连续计数全带,便于真机调阈。
   * 装配层可经 `echoGuardObserver` 注入接 observability 包的 trace(本模块不反向依赖 observability)。
   */
  static readonly #defaultEchoGuardObserver = (d: EchoGuardDecision): void => {
    if (d.tier === 'disabled') return;
    if (!d.pass) {
      console.debug(
        `[EchoGuard] 挡 tier=${d.tier} rms=${d.energy01.toFixed(4)} thr=${d.rmsThreshold.toFixed(4)} run=${d.run}`,
      );
    }
  };

  /**
   * speaking 期 EchoGuard Tier1 硬门控放行判定（仅在注入 `#echoGuard` 时调用）。
   *
   * 返回 true 表示「应放行到既有打断判定」：
   *   1. **危机/硬打断豁免**：若注入了 attention 的 `buildSignal` 且其信号标 `crisis`/`hardInterrupt`，
   *      绕过 RMS/N 帧去抖立即放行（承「救命不可配」§法律底线）。
   *   2. 否则把本帧喂 `EchoGuardGate.push`：speaking 档用**最高 RMS 门槛**(`cooldownRmsThreshold`)
   *      压住自家 TTS 回声(低能量回声被挡),真人足够响 + 连续 N 帧高置信才放行(不变「打不断」)；
   *      未放行 → 返回 false（保持 speaking，只感知不打断）。
   *
   * `prob` 取自 VAD 结果；`energy01` 由帧样本 RMS 归一化喂双层门槛；`atMs` 喂 Gate 判档(确定性)。
   * 任何异常被捕获（§3.2 优雅降级）：兜底放行（宁可不漏掉用户，也不因防护 bug 变「打不断」）。
   */
  #echoGuardConfirms(
    result: { readonly prob: number; readonly speaking: boolean },
    nowFrameMs: number,
    isSpeechStart: boolean,
  ): boolean {
    const gate = this.#echoGuard;
    if (gate === undefined) return true; // 未注入:即时确认(逐字现状)
    try {
      // 危机/硬打断豁免:只在有 attention buildSignal 通道时有意义(纯语音无危机分类来源)。
      const cfg = this.#attention;
      if (cfg?.buildSignal) {
        const startedAt = this.#userSpeechStartAtMs ?? nowFrameMs;
        const sustainedMs = Math.max(0, nowFrameMs - startedAt);
        const sig = cfg.buildSignal({ sustainedMs, speaking: true });
        if (sig.crisis === true || sig.hardInterrupt === true) {
          gate.reset(); // 豁免立即打断后清计数,避免残留影响下一回合
          return true;
        }
      }
      const decision = gate.push({
        prob: result.prob,
        energy01: this.#frameEnergy01(),
        // VAD「说话中」或本帧即 speech_start 事件都视作有声(speech_start 当帧 result.speaking 可能尚未翻真)。
        speakingFromVad: result.speaking || isSpeechStart,
        atMs: nowFrameMs, // 帧时刻喂 Gate 判冷却窗内/外(确定性,不读墙钟)
      });
      // 可追溯:EchoGuard speaking 期去抖决策(§4 echo-guard;复用 decision 现成值,与 echoGuardObserver 同源)。
      this.#emitTrace({
        kind: 'echo-guard',
        tier: decision.tier,
        rmsNorm: decision.energy01,
        run: decision.run,
        passed: decision.pass,
      });
      return decision.pass;
    } catch (err) {
      console.warn('[VoiceLoop] EchoGuard 判定抛错(兜底放行,不变打不断):', err);
      return true;
    }
  }

  /** 最近一帧时间戳(ms);供 EchoGuard 冷却窗起点对齐帧时间轴(确定性,不读墙钟)。 */
  #lastFrameAtMs = 0;
  /**
   * Tier2 冷却窗输入抑制(listening 期,仅在注入 `#echoGuard` 时调用):
   * 问 Gate「这帧是不是 agent 刚说完的低能量混响尾」——是则抑制(不开启虚假回合),否则放行。
   * 纯查询、不动 barge-in 去抖计数;异常被吞 → 兜底不抑制(宁可多接一句也不漏掉用户,§3.2)。
   */
  #echoGuardSuppresses(nowFrameMs: number): boolean {
    const gate = this.#echoGuard;
    if (gate === undefined) return false;
    try {
      return gate.shouldSuppressInput({
        prob: 1,
        energy01: this.#frameEnergy01(),
        speakingFromVad: true,
        atMs: nowFrameMs,
      });
    } catch (err) {
      console.warn('[VoiceLoop] EchoGuard 冷却窗抑制判定抛错(兜底不抑制):', err);
      return false;
    }
  }

  /** 本帧归一化 RMS 能量(0~1);喂 EchoGuard 双层 RMS 门槛判定。 */
  #lastFrameSamples: Int16Array | null = null;
  #frameEnergy01(): number {
    const s = this.#lastFrameSamples;
    if (s === null || s.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < s.length; i++) sum += s[i]! * s[i]!;
    const rms = Math.sqrt(sum / s.length);
    return Math.min(1, rms / VoiceLoop.#FULL_SCALE);
  }

  // ───────────────────────────── 打断 ─────────────────────────────

  /**
   * 核心打断（barge_in_pending → listening，§4）：
   *   1. `#gen++` 作废在途 TTS/onToken；
   *   2. `abort()` 真停在途「想」回合的底层 LLM 流（§3.2 真打断，不再后台跑到完）；
   *   3. transport.clearBuffer() 排空已下发未播音频；
   *   4. 半句写回（`#replyAccum + [被用户打断]`，仅非空时）；
   *   5. 清状态、回 listening。被取消的 send 以 AbortError reject,因 gen 已变在 .catch 里静默忽略。
   *
   * `reason` 透传 `turn:interrupt` 的 reason(默认 `barge_in` 保持用户打断现状;autonomy 自身抢占传
   * `autonomy_preempt` 以区分,§8.1 可追溯)。打断核心逻辑不因 reason 改变。
   */
  #interrupt(reason = 'barge_in'): void {
    this.#gen++; // 在途旧 TTS 帧/onToken 立即作废
    this.#abortCurrent(); // 真取消:abort 本回合底层 LLM 流(承 §3.2)
    try {
      this.#transport.clearBuffer();
    } catch (err) {
      console.warn('[VoiceLoop] clearBuffer 抛错(已捕获):', err);
    }
    const half = this.#replyAccum.trim();
    if (half.length > 0) {
      try {
        this.#memory.appendMessage({
          sessionId: this.#sessionId,
          turnId: 'interrupted',
          role: 'assistant',
          content: this.#replyAccum + INTERRUPT_MARK,
          createdAtMs: this.#now(),
        });
      } catch (err) {
        console.warn('[VoiceLoop] 半句写回抛错(已捕获):', err);
      }
    }
    this.#replyAccum = '';
    this.#audioBuf = [];
    this.#userSpeechStartAtMs = null;
    this.#echoGuard?.reset(); // 清自打断防护连续计数(回合结束)
    this.#emitTrace({ kind: 'turn', outcome: 'barge_in' }); // 可追溯:回合被打断/抢占(§4 turn)
    this.#go('turn:interrupt', { reason }); // barge_in_pending → listening(reason 透传可追溯)
  }

  // ───────────────────────────── 兜底 ─────────────────────────────

  /**
   * 强制回 listening（降级兜底）：若当前态有合法路径就走（emit 对应事件），
   * 否则直接硬置 listening（不 emit，避免非法迁移 warn 噪声）。
   */
  #resetToListening(): void {
    this.#echoGuard?.reset(); // 清自打断防护连续计数(降级回 listening)
    if (this.#state === 'listening') return;
    // 优先走合法迁移以保持 BusEvent / trace 可追溯。
    // committing 与 endpointing 同样有合法的 vad:speech_end → listening（committing 为批式瞬态忙的收口）。
    if (this.#state === 'endpointing' || this.#state === 'committing') {
      this.#audioBuf = [];
      this.#go('vad:speech_end');
      return;
    }
    if (this.#state === 'speaking') {
      this.#go('turn:end');
      return;
    }
    // thinking / barge_in_pending：无直达 listening 的合法事件 → 硬置（瞬态降级,不 emit）
    this.#state = 'listening';
    this.#audioBuf = [];
  }

  // ───────────────────────────── 类型桥接 ─────────────────────────────

  /** PcmFrame → PcmChunk（STT 输入）：同为 samples + sampleRate + channels。 */
  #toPcmChunk(frame: PcmFrame): PcmChunk {
    return { samples: frame.samples, sampleRate: frame.sampleRate, channels: frame.channels };
  }

  /** PcmChunk → 下行 tts:chunk AudioFrame（DataFrame，打断时丢弃语义）。 */
  #toTtsFrame(chunk: PcmChunk): AudioFrame {
    return makeDataFrame('tts:chunk', {
      format: { sampleRate: chunk.sampleRate, channels: chunk.channels, sampleFormat: 's16le' },
      samples: chunk.samples,
      seq: this.#ttsSeq++,
    });
  }
}
