/**
 * cli 语音模式入口(R2):把 {@link AudioDevice}(真/Fake)→ InProcessAudioTransport → VoiceLoop 接起来。
 *
 * 装配链(承任务交付 #4):
 *   - 设备:`CHAT_A_AUDIO_DEVICE=node` 用 {@link NodeAudioDevice}(动态加载原生库,装不上→明确报错并回落);
 *           缺省/`fake` 用 {@link FakeAudioDevice}(无原生依赖,可在任何环境跑;采集空,主要供冒烟)。
 *   - STT/TTS:`createStt(loadSttConfig(env))` / `createTts(loadTtsConfig(env))`(缺省 Fake)。
 *   - VAD/TurnDetector:按 `CHAT_A_VAD` 选真/桩——`silero`(/`real`/`sherpa`)注入真
 *     {@link SileroVadDetector} + {@link SmartTurnEouModel}(经 sherpa session 工厂动态加载真推理端口);
 *     缺省/其它/`stub` 用确定性桩。真路径加载/构造失败 → **打印明确中文提示并回落桩**
 *     (沿用真设备回落范式,绝不崩);真模型接入后**零改 VoiceLoop**(实现同接口即换)。
 *   - send 注入 `conversation.send.bind(conversation)`(零改 Conversation,§VoiceLoop 设计)。
 *
 * 文字模式默认不变;`--voice` 或 `CHAT_A_VOICE=1` 才进本模式(见 cli.ts 分发)。
 */
import { stdout, env as procEnv } from 'node:process';
import { SAMPLE_RATE_HZ } from '@chat-a/protocol';
import { connectClientTransport } from '@chat-a/gateway';
import {
  createStt,
  loadSttConfig,
  createTts,
  loadTtsConfig,
  QwenOmniLlm,
  QWEN_DASHSCOPE_REALTIME_URL,
  QwenAsrRealtimeStt,
  QWEN_ASR_REALTIME_URL,
  DEFAULT_QWEN_ASR_REALTIME_MODEL,
} from '@chat-a/providers';
import type { TtsOptions } from '@chat-a/providers';
import type { MemoryStore } from '@chat-a/memory';
import type { SttEmotionLike } from '@chat-a/persona';
import {
  StubVadDetector,
  TurnDetector,
  StubEouModel,
  SileroVadDetector,
  SmartTurnEouModel,
  EnergyVadDetector,
  SilenceTimeoutEouModel,
  DEFAULT_ECHO_GUARD_CONFIG,
  DEFAULT_VAD_CONFIG,
  DEFAULT_SPEECH_GATE_CONFIG,
  type VadDetector,
  type EchoGuardConfig,
} from '@chat-a/voice-detect';
import type { LightVoiceBus, SpeakStateView, OmniAudioPort, VoicePath, StreamingSttPort } from '@chat-a/runtime';
import type { AudioDevice } from './audio/audio-device';
import { FakeAudioDevice } from './audio/fake-audio-device';
import { NodeAudioDevice } from './audio/node-audio-device';
import {
  listInputDevices,
  listOutputDevices,
  resolveDeviceByName,
  type AudioDeviceInfo,
} from './audio/device-registry';
import { WavFileAudioDevice } from './audio/wav-file-audio-device';
import { createSherpaVadSession, createSherpaEouSession } from './audio/sherpa-vad-session';
import { runVoiceLoop, runTerminalBridge } from './audio/voice-runner';

/**
 * 传输选择(行为即配置,§3.1):`CHAT_A_TRANSPORT=inprocess|websocket`,**缺省 inprocess**(逐字不变)。
 *   - `inprocess`:设备↔InProcessAudioTransport↔VoiceLoop 全在本进程(单机形态,与本变更前一致)。
 *   - `websocket`:终端只起 WS client transport + 设备桥;大脑/VoiceLoop 在另一进程
 *     (经 `CHAT_A_GATEWAY_URL`,默认 `ws://127.0.0.1:8787`)。鉴权/WSS 为接缝预留未实装。
 */
export type TransportKind = 'inprocess' | 'websocket';

/** 大脑侧默认地址(本地双进程手测);真部署经 CHAT_A_GATEWAY_URL 覆盖(WSS 见接缝预留)。 */
export const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:8787';

/** 解析传输档:仅识别 websocket;其它/缺省一律回落 inprocess(缺省零行为变更)。 */
export function loadTransportKind(env: NodeJS.ProcessEnv): TransportKind {
  return (env['CHAT_A_TRANSPORT'] ?? '').toLowerCase() === 'websocket' ? 'websocket' : 'inprocess';
}

/** omni audio-in 直路默认 model id(承 provider design §0:目录可用 realtime id,无 .5,可经 env 覆盖)。 */
export const DEFAULT_OMNI_MODEL = 'qwen3.5-omni-flash-realtime';

/**
 * 解析语音路径档(§4 多路径,行为即配置):`CHAT_A_VOICE_PATH=stt|omni|stt-stream`,**缺省 `stt`**(逐字不变)。
 *   - `stt`(缺省/空/其它):现有 VAD→EOU→STT→LLM→TTS 批式路径。
 *   - `omni`:audio-in 直路(path B,§7#5 prosody)——尝试构造 omni 端口注入 VoiceLoop;
 *     构造/key 缺失失败则回落 STT(见 {@link createOmniAudioPort})。
 *   - `stt-stream`:连续流式 STT 路(全程流式)——尝试构造流式 ASR 端口注入 VoiceLoop;
 *     构造/key 缺失失败则回落 STT(见 {@link createStreamingSttPort})。
 * 三者互斥(单值决定);omni 与 stt-stream 不会同时生效。
 */
export function loadVoicePath(env: NodeJS.ProcessEnv): VoicePath {
  const v = (env['CHAT_A_VOICE_PATH'] ?? '').toLowerCase();
  if (v === 'omni') return 'omni';
  if (v === 'stt-stream') return 'stt-stream';
  return 'stt';
}

/**
 * 解析语音模式 EchoGuard 档(自打断防护,§4 软件侧部分缓解,行为即配置):
 * 语音模式**默认开启** EchoGuard(`enabled:true`),压制自家 TTS 回声引起的误打断;
 * 经 `CHAT_A_ECHO_GUARD=off`(/`false`/`0`/`no`/`disabled`)可显式关闭(回落逐字现状即时打断)。
 *
 * **去抖默认 `confirmFrames:3`(barge-in-polish)**:协议帧 10ms/帧(见 protocol `FRAME_MS`),
 * N=3 ≈ 需连续 30ms 高置信语音才确认是用户真说话→才打断,压制自家 TTS 经空气/回环灌进麦克风的
 * **单帧回声尖峰**与瞬态噪声误打断(N=1 等价无去抖,是真机误打断防护的空档)。30ms 远低于人类
 * 反应/语音感知阈,伴侣仍「能被打断」(不变迟钝);此值即「最短连续语音时长门槛」,故无需再叠
 * 独立的 min-interruption 时长护栏(职责等价、避免重复工程)。
 *
 * **与库默认的分工**:此处**装配层**据真机场景把 `confirmFrames` 覆盖为去抖值 3;而
 * {@link DEFAULT_ECHO_GUARD_CONFIG} 的 `confirmFrames:1` 是**库级回归硬线**(配 `enabled:false`,
 * 直接构造/外部注入时给「逐字现状」安全起点),保持 1 不变。其余阈值(`minSpeechProb`/`minEnergy`/
 * `cooldownMs`/双层 RMS 门槛)仍沿用库默认。本切片不新增 `confirmFrames` 专属 env 旋钮(避免过度工程)。
 * 返回 undefined 仅当显式关闭 → VoiceLoop 不注入 → barge-in 逐字现状(与历史等价)。
 */
export function loadEchoGuardConfig(env: NodeJS.ProcessEnv): EchoGuardConfig | undefined {
  const raw = (env['CHAT_A_ECHO_GUARD'] ?? '').trim().toLowerCase();
  const off = raw === 'off' || raw === 'false' || raw === '0' || raw === 'no' || raw === 'disabled';
  if (off) return undefined; // 显式关 → 不注入 → 逐字现状
  // 缺省/其它值 → 语音模式默认开启(enabled 翻 true)+ 真去抖(confirmFrames 提到 3),其余沿用安全默认。
  return { ...DEFAULT_ECHO_GUARD_CONFIG, enabled: true, confirmFrames: 3 };
}

/**
 * 按 env 构造 omni audio-in 端口(path B):直接构造 `QwenOmniLlm`(它**不在 LLM registry**,
 * 因 DashScope realtime 不接纯文本 item)。`QwenOmniLlm.respondToAudio` 形态满足 `OmniAudioPort`,
 * 故可直接当端口注入 VoiceLoop。
 *   - key 读 `CHAT_A_DASHSCOPE_API_KEY`;缺失 → 打印明确中文提示,返回 undefined(回落 STT,绝不崩)。
 *   - model 读 `CHAT_A_OMNI_MODEL`(缺省 {@link DEFAULT_OMNI_MODEL});
 *     baseURL 读 `CHAT_A_OMNI_BASE_URL`(缺省 {@link QWEN_DASHSCOPE_REALTIME_URL})。
 *   - 构造抛错 → catch、打印中文提示、返回 undefined(回落 STT)。
 * 惰性连接:构造不触网(QwenOmniLlm 首次 respondToAudio 才建连),装配安全。
 */
export function createOmniAudioPort(env: NodeJS.ProcessEnv): OmniAudioPort | undefined {
  const apiKey = env['CHAT_A_DASHSCOPE_API_KEY'];
  if (apiKey === undefined || apiKey.length === 0) {
    stdout.write(
      '[语音] CHAT_A_VOICE_PATH=omni 但缺 CHAT_A_DASHSCOPE_API_KEY,已回落 STT 路径(请设置后重试)\n',
    );
    return undefined;
  }
  try {
    const rawRate = (env['CHAT_A_OMNI_SAMPLE_RATE'] ?? '').trim();
    const inputSampleRate = rawRate.length > 0 && Number.isFinite(Number(rawRate)) ? Number(rawRate) : undefined;
    const td = (env['CHAT_A_OMNI_TURN_DETECTION'] ?? '').trim().toLowerCase();
    const turnDetection =
      td === 'manual' || td === 'server_vad' || td === 'semantic_vad' ? (td as 'manual' | 'server_vad' | 'semantic_vad') : 'semantic_vad';
    return new QwenOmniLlm({
      id: 'qwen-omni',
      model: env['CHAT_A_OMNI_MODEL'] ?? DEFAULT_OMNI_MODEL,
      apiKey,
      baseURL: env['CHAT_A_OMNI_BASE_URL'] ?? QWEN_DASHSCOPE_REALTIME_URL,
      turnDetection,
      ...(inputSampleRate !== undefined ? { inputSampleRate } : {}),
    });
  } catch (err) {
    stdout.write(
      `[语音] omni audio-in 端口构造失败,已回落 STT 路径:${err instanceof Error ? err.message : String(err)}\n`,
    );
    return undefined;
  }
}

/**
 * 按 env 构造连续流式 STT 端口(path stt-stream):直接构造 {@link QwenAsrRealtimeStt}
 * (realtime WS,服务端 VAD 连续分句),其 `openSession` 形态满足 `StreamingSttPort`,可直接注入 VoiceLoop。
 *   - key 读 `CHAT_A_DASHSCOPE_API_KEY`;缺失 → 打印明确中文提示,返回 undefined(回落批式 STT,绝不崩)。
 *   - model 读 `CHAT_A_STT_REALTIME_MODEL`(缺省 {@link DEFAULT_QWEN_ASR_REALTIME_MODEL});
 *     baseURL 读 `CHAT_A_STT_REALTIME_BASE_URL`(缺省 {@link QWEN_ASR_REALTIME_URL})。
 *   - 构造抛错 → catch、打印中文提示、返回 undefined(回落批式 STT)。
 * 惰性连接:构造不触网(首次 openSession 才建 WS),装配安全。范式对齐 {@link createOmniAudioPort}。
 */
export function createStreamingSttPort(env: NodeJS.ProcessEnv): StreamingSttPort | undefined {
  const apiKey = env['CHAT_A_DASHSCOPE_API_KEY'];
  if (apiKey === undefined || apiKey.length === 0) {
    stdout.write(
      '[语音] CHAT_A_VOICE_PATH=stt-stream 但缺 CHAT_A_DASHSCOPE_API_KEY,已回落批式 STT 路径(请设置后重试)\n',
    );
    return undefined;
  }
  try {
    return new QwenAsrRealtimeStt({
      id: 'qwen-asr-rt',
      model: env['CHAT_A_STT_REALTIME_MODEL'] ?? DEFAULT_QWEN_ASR_REALTIME_MODEL,
      apiKey,
      baseURL: env['CHAT_A_STT_REALTIME_BASE_URL'] ?? QWEN_ASR_REALTIME_URL,
    });
  } catch (err) {
    stdout.write(
      `[语音] 流式 ASR 端口构造失败,已回落批式 STT:${err instanceof Error ? err.message : String(err)}\n`,
    );
    return undefined;
  }
}

/**
 * 语音 autonomy 装配所需的 VoiceLoop 最小读面(companion-live-wiring,§3.1):
 * 只读 `speakState`(is_speaking 真闸)/ `requestAutonomyPreempt`(真打断),**不暴露 VoiceLoop 内部**。
 */
export interface VoiceLoopAutonomyView {
  speakState(): SpeakStateView;
  requestAutonomyPreempt(reason?: string): boolean;
}

/** 语音 autonomy 装配钩子返回的可停句柄(纳入语音 stop 收尾)。 */
export interface VoiceAutonomyHandle {
  stop(): void;
}

/** 语音模式所需的、由 cli.ts 已装配好的依赖(复用文字链路的 convo/memory/bus/session)。 */
export interface VoiceModeDeps {
  /**
   * 想:吃用户文本 + onToken(+ 可选 signal 协作取消 + 可选 prosodyEmotion 语音情绪),resolve 完整回复。
   * 装配处传 `conversation.send.bind(conversation)`(或转发全部入参的等价闭包)。
   * §7#5「从语音读情绪」:VoiceLoop 会把 STT final 读出的语气情绪经**第 4 参** `prosodyEmotion` 透传至此,
   * 由 `Conversation.send` 再透传给 `persona.advance` 并入 PAD;不转发即丢失语音情绪驱动(本切片补齐的缺口)。
   * `signal`(第 3 参)在打断/停止时被 abort,使底层 LLM 流真停(§3.2 真打断);不转发则打断只作废输出、不真停流。
   */
  readonly send: (
    text: string,
    onToken: (t: string) => void,
    signal?: AbortSignal,
    prosodyEmotion?: SttEmotionLike,
  ) => Promise<string>;
  /** 半句写回只用到 appendMessage(VoiceLoop 最小面)。 */
  readonly memory: Pick<MemoryStore, 'appendMessage'>;
  /** 复用 cli 的总线(与文字链路共享 correlation/历史)。 */
  readonly bus: LightVoiceBus;
  /** 贯穿本会话的 sessionId(与 Conversation 一致,半句写回归属正确)。 */
  readonly sessionId: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * omni 直路系统提示组装接缝(omni-persona-context,path B,**可选**、纯加法)。
   * 仅 omni 路用到:omni 回合在调 `respondToAudio` 前 `await` 它得 persona/记忆/语气组装的 instructions,
   * 让 audio-in 直路下的小雪和 STT 路一样有灵魂(修复 omni 回复退化成通用「AI 助手」腔的真 bug)。
   * cli.ts 以 `() => convo.composeOmniInstructions()` 注入(与文字链路同一 Conversation,同源人设/记忆/语气);
   * 仅在提供时透传进 `loopDeps`(未提供 / 非 omni 路 → omni 退回空 opts,逐字现状)。STT 路不经过它。
   */
  readonly composeOmniInstructions?: () => string | Promise<string>;
  /**
   * omni 路「情感→PAD」prosody 推进钩子(omni-prosody-to-pad,path B,**可选**、纯加法)。
   * 仅 omni 路用到:omni 回合从模型回复尾部剥出 `[user_emotion:...]` 标签 → 映射成 SttEmotionLike → 经此钩子
   * 喂进 PAD(复用 prosodyToPadPull → persona.advance,落地 §7「prosody 永不漏听」)。
   * cli.ts/app 以 `(e) => convo.advanceProsody(e)` 注入(与文字链路同一 Conversation,同源 persona/PAD);
   * 仅在提供时透传进 `loopDeps`(未提供 / 非 omni 路 → omni 路逐字现状,无 prosody→PAD)。STT 路不经过它。
   */
  readonly advanceProsody?: (emotion: SttEmotionLike) => void | Promise<void>;
  /**
   * 语音 autonomy 装配钩子(companion-live-wiring,**默认关随 CHAT_A_AUTONOMY**):
   * 语音模式拿到 VoiceLoop 后回调它装配 autonomy 并注入 `voiceState`(is_speaking 真闸)+
   * `preempt`(真打断,受 §7 约束:用户 URGENT 最高、不凌驾用户)+ 真候选源;返回的句柄纳入语音 stop 收尾。
   * cli 仅在 autonomy on 时传入;off 时不传(语音侧零构造 autonomy,逐字不变)。**只读** VoiceLoop API,不改其内部。
   */
  readonly assembleVoiceAutonomy?: (
    loop: VoiceLoopAutonomyView,
    bus: LightVoiceBus,
  ) => VoiceAutonomyHandle | undefined;
  /**
   * 输入语种(§4.1 听=STT,**可选**、纯加法):由 voice 配置 `input_lang`(非 auto 时)拼好后注入 VoiceLoop。
   * 省略(缺省)→ VoiceLoop 不下发 language → STT 自动检测 → 逐字现状。
   */
  readonly sttLanguage?: string;
  /**
   * 输出合成 opts(§4.1 说=TTS,**可选**、纯加法):由 voice 配置 `output_lang`/`voice_id`/`clone_ref`
   * 拼好后注入 VoiceLoop。省略(缺省)→ synthesize 的 opts 仍为 undefined → 逐字现状。
   */
  readonly ttsOptions?: TtsOptions;
  /** 设备选择/持久化注入(CLI 传文字菜单壳;desktop 用 IPC,不经此)。缺省=非交互回退默认。 */
  readonly audioSelect?: CreateAudioDeviceDeps;
}

/** 语音模式运行句柄:停 = 收尾(停采集/loop/设备)。 */
export interface VoiceModeHandle {
  /** 设备/STT/TTS/VAD/EOU 的可读标识(状态行用;vad/eou 反映回落后的实际实现)。 */
  readonly info: {
    readonly device: string;
    readonly stt: string;
    readonly tts: string;
    readonly vad: string;
    readonly eou: string;
    /** 传输档(inprocess 缺省 / websocket);websocket 档下 stt/tts/vad/eou 标注「大脑侧」。 */
    readonly transport: TransportKind;
    /** 语音路径(stt 缺省 / omni audio-in 直路);omni 端口回落时标 'stt'。 */
    readonly path: VoicePath;
    /** EchoGuard 自打断防护(语音模式默认 on;CHAT_A_ECHO_GUARD=off 时 off)。 */
    readonly echoGuard: 'on' | 'off';
  };
  stop(): void;
}

/** 端点检测装配结果:VAD + TurnDetector + 实际生效的实现标识(真/桩,供状态行)。 */
export interface Detectors {
  readonly vad: VadDetector;
  readonly turnDetector: TurnDetector;
  /** 实际生效的 VAD 实现标识(回落后)。 */
  readonly vadKind: string;
  /** 实际生效的 EOU 实现标识(回落后)。 */
  readonly eouKind: string;
}

/** 桩端点检测:与历史行为逐字一致的「恒有声 + 高 EOU」占位序列。 */
function createStubDetectors(): Detectors {
  return {
    vad: new StubVadDetector([0.9]),
    turnDetector: new TurnDetector(new StubEouModel([0.9])),
    vadKind: 'stub',
    eouKind: 'stub',
  };
}

/**
 * 按 env 选端点检测实现(承本切片目标):
 *   - `CHAT_A_VAD=silero`(/`real`/`sherpa`)→ 真 {@link SileroVadDetector} + {@link SmartTurnEouModel}
 *     (经 sherpa session 工厂动态加载真推理端口;模块名可经 `CHAT_A_SHERPA_MODULE` 覆盖)。
 *   - 缺省/空/其它/`stub` → 确定性桩(CI/冒烟默认,文字模式与现状逐字不变)。
 * 真路径动态加载/构造**任一步抛错** → 打印明确中文提示并**回落桩**,绝不崩(§3.2,沿用真设备回落范式)。
 */
export async function createDetectors(env: NodeJS.ProcessEnv): Promise<Detectors> {
  const mode = (env['CHAT_A_VAD'] ?? 'stub').toLowerCase();

  // 无模型档(填 key 即测):纯 JS 能量 VAD + 静音超时 EOU,零模型/零原生依赖。
  // 构造为纯算术,理论不会失败;仍包一层回落桩以守优雅降级范式(§3.2)。
  if (mode === 'energy') {
    try {
      return {
        // 防 ASR 静音幻觉 Layer 1:能量 VAD 抗噪——把起始去抖提到 25 帧(=250ms@10ms),
        // 让噪声尖峰(1~2 帧)无法误触发 speech_start;Silero 档不动。逢低清零的去抖已在 VadGate(连续达标计数)。
        vad: new EnergyVadDetector({ vadConfig: { ...DEFAULT_VAD_CONFIG, speechStartFrames: 25 } }),
        turnDetector: new TurnDetector(new SilenceTimeoutEouModel()),
        vadKind: 'energy',
        eouKind: 'silence-timeout',
      };
    } catch (err) {
      stdout.write(
        `[语音] 能量 VAD/静音 EOU 初始化失败,已回落确定性桩:${err instanceof Error ? err.message : String(err)}\n`,
      );
      return createStubDetectors();
    }
  }

  const wantReal = mode === 'silero' || mode === 'real' || mode === 'sherpa';
  if (!wantReal) return createStubDetectors();

  try {
    // 真路径:动态加载 sherpa 同步推理端口,注入既有真适配器(零改 VoiceLoop)。
    const vadSession = await createSherpaVadSession({ env });
    const eouSession = await createSherpaEouSession({ env });
    const vad = new SileroVadDetector({ session: vadSession });
    const turnDetector = new TurnDetector(new SmartTurnEouModel({ session: eouSession }));
    return { vad, turnDetector, vadKind: 'silero', eouKind: 'silero' };
  } catch (err) {
    stdout.write(
      `[语音] 真 VAD/EOU(sherpa)初始化失败,已回落确定性桩:${err instanceof Error ? err.message : String(err)}\n`,
    );
    return createStubDetectors();
  }
}

/**
 * 解析「当前路径所需输入采样率」(能力驱动解耦):omni 路读端口 inputSampleRate,
 * STT 路读 capabilities.sampleRate;缺省一律回落 16000(VAD/EOU 硬约束 + 既有现状)。
 */
export function resolveRequiredInputRate(
  stt?: { readonly capabilities: { readonly sampleRate: number } },
  omni?: { readonly inputSampleRate?: number },
  path: 'stt' | 'omni' = 'stt',
): number {
  if (path === 'omni') return omni?.inputSampleRate ?? 16000;
  return stt?.capabilities.sampleRate ?? 16000;
}

/** 惰性加载 naudiodon(装配层枚举用;失败返回 {} 触发降级,绝不崩)。 */
async function loadNaudiodon(moduleName?: string): Promise<unknown> {
  try {
    return await import(/* @vite-ignore */ moduleName ?? 'naudiodon');
  } catch {
    return {};
  }
}

/**
 * `createAudioDevice` 注入面(纯逻辑接缝,可单测):能力驱动采集率 + 枚举模块注入 +
 * 解析未命中时的设备选择/持久化回调(CLI/desktop 各自实现壳;缺省非交互→回退系统默认)。
 */
export interface CreateAudioDeviceDeps {
  /** 当前路径所需输入采样率(目标重采样率;由 {@link resolveRequiredInputRate} 算出)。缺省 16000。 */
  readonly requiredInputRate?: number;
  /** 注入枚举用的原生模块(缺省动态 import naudiodon;失败→{} 触发降级)。 */
  readonly loadNativeModule?: () => Promise<unknown>;
  /** 解析未命中时的选择回调(CLI/desktop 各自实现);返回 null=用户取消→回退默认。 */
  readonly promptSelect?: (
    kind: 'input' | 'output',
    devices: readonly AudioDeviceInfo[],
  ) => Promise<AudioDeviceInfo | null>;
  /** 选定后持久化(写 .env.local 设备名)。 */
  readonly persistSelection?: (kind: 'input' | 'output', dev: AudioDeviceInfo) => void;
}

/**
 * 按 env 选设备:`node` → NodeAudioDevice(先按名解析输入/输出设备 + 能力驱动采集率,再 init
 * 动态加载原生库;失败抛错由调用方决定是否回落);其它 → FakeAudioDevice。返回设备 + 是否真实设备
 * (供状态行/回落判断)。
 *
 * node 分支解析优先级(§3.2 优雅降级,缺设备/非交互绝不崩):
 *   - 输入/输出设备:**纯按设备名解析**(名→当前 id) > 选择回调 > 系统默认 -1。**不用持久化数字 id**
 *     (PortAudio id 随插拔/重启洗牌;数字 id 只在启动时由设备名临时解析、用完即弃,绝不进配置)。
 *   - 采集率:取解析到设备的 defaultSampleRate(=设备原生率,免配)。
 *   - 目标重采样率 requiredInputRate 由能力声明驱动(STT capabilities.sampleRate / omni inputSampleRate);
 *     fail-fast 校验须 = 16k(VAD/EOU 硬约束)。
 */
export async function createAudioDevice(
  env: NodeJS.ProcessEnv,
  opts?: CreateAudioDeviceDeps,
): Promise<{ device: AudioDevice; real: boolean }> {
  const mode = (env['CHAT_A_AUDIO_DEVICE'] ?? 'fake').toLowerCase();
  if (mode === 'node' || mode === 'naudiodon' || mode === 'real') {
    const nativeModule = env['CHAT_A_AUDIO_MODULE'];
    // 目标采集率(能力驱动):STT/omni 路各自声明,缺省 16000(VAD/EOU 硬约束)。
    const requiredRate = opts?.requiredInputRate ?? SAMPLE_RATE_HZ;
    // 采样率校验(fail-fast):目标率必须 > 0。
    if (!(requiredRate > 0)) {
      throw new Error(`无效的所需输入采样率:${requiredRate}`);
    }
    // fail-fast 守住 VAD/EOU 恒 16k:本切片 VAD/EOU 物理锁 16kHz,且未实现「≠16k 时分叉第二条采集流」,
    // 故采集目标率必须 = SAMPLE_RATE_HZ(16000)。若 STT/omni 声明的输入率非 16k → 明确抛错而非静默跑错。
    if (requiredRate !== SAMPLE_RATE_HZ) {
      throw new Error(
        `VAD/EOU 恒需 ${SAMPLE_RATE_HZ}Hz,当前 STT/omni 要求输入率=${requiredRate}Hz 的分叉未实现;` +
          `请用 16k STT 或勿设 CHAT_A_STT_SAMPLE_RATE 为非16k`,
      );
    }

    // 枚举设备(经 deps 注入,缺省动态 import naudiodon;失败→空,降级到 env/默认)。
    const mod = await (opts?.loadNativeModule?.() ?? loadNaudiodon(nativeModule));
    const inputs = listInputDevices(mod);
    const outputs = listOutputDevices(mod);

    // 输入设备:**纯按设备名解析**(名→当前 id) > (无名/未命中)选择回调 > 系统默认 -1。不读任何持久化 id。
    let deviceId: number | undefined;
    let deviceCaptureRate: number | undefined; // 设备开流率取解析到设备的原生 defaultSampleRate(免配)。
    {
      const name = (env['CHAT_A_AUDIO_INPUT_DEVICE_NAME'] ?? '').trim();
      const host = (env['CHAT_A_AUDIO_INPUT_DEVICE_HOST'] ?? '').trim() || undefined;
      let chosen = name.length > 0 ? resolveDeviceByName(inputs, name, host) : null;
      if (chosen === null && opts?.promptSelect && inputs.length > 0) {
        chosen = await opts.promptSelect('input', inputs);
        if (chosen) opts.persistSelection?.('input', chosen);
      }
      if (chosen) {
        deviceId = chosen.id;
        deviceCaptureRate = chosen.defaultSampleRate;
      }
    }

    // 输出设备:纯按设备名解析 > 选择回调 > 系统默认 -1(与输入分离,绝不套用输入 id,修 bug1)。
    let outputDeviceId: number | undefined;
    let outputSampleRate: number | undefined; // 输出设备原生率;TTS 块重采样到它(修 16k-only 蓝牙免提输出强开 24k 失败)。
    {
      const oname = (env['CHAT_A_AUDIO_OUTPUT_DEVICE_NAME'] ?? '').trim();
      const ohost = (env['CHAT_A_AUDIO_OUTPUT_DEVICE_HOST'] ?? '').trim() || undefined;
      let ochosen = oname.length > 0 ? resolveDeviceByName(outputs, oname, ohost) : null;
      if (ochosen === null && opts?.promptSelect && outputs.length > 0) {
        ochosen = await opts.promptSelect('output', outputs);
        if (ochosen) opts.persistSelection?.('output', ochosen);
      }
      if (ochosen) {
        outputDeviceId = ochosen.id;
        outputSampleRate = ochosen.defaultSampleRate;
      }
    }

    const device = new NodeAudioDevice({
      ...(nativeModule ? { nativeModule } : {}),
      ...(deviceId !== undefined ? { deviceId } : {}),
      ...(outputDeviceId !== undefined ? { outputDeviceId } : {}),
      captureSampleRate: requiredRate,
      ...(deviceCaptureRate !== undefined ? { deviceCaptureRate } : {}),
      ...(outputSampleRate !== undefined ? { outputSampleRate } : {}),
    });
    await device.init(); // 装不上 → 抛明确报错(调用方 catch 后回落 Fake)
    return { device, real: true };
  }
  // WAV 文件设备(填 key 即测):从 WAV 读帧当麦克风、把 TTS 产出写 WAV 当扬声器;零原生依赖。
  if (mode === 'wav') {
    const inWav = env['CHAT_A_AUDIO_IN_WAV'];
    const outWav = env['CHAT_A_AUDIO_OUT_WAV'];
    const device = new WavFileAudioDevice({
      ...(inWav ? { inputWavPath: inWav } : {}),
      ...(outWav ? { outputWavPath: outWav } : {}),
    });
    // 视作「真」设备(有真音频 I/O,非占位);采集为空时(未给输入 WAV)仍可只测下行播放。
    return { device, real: true };
  }
  return { device: new FakeAudioDevice(), real: false };
}

/**
 * 启动语音闭环。已装配好 convo/memory/bus/session 后调用。
 * 设备装配失败(原生库缺失)→ 打印明确提示并回落 FakeAudioDevice,绝不崩(§3.2)。
 */
export async function startVoiceMode(deps: VoiceModeDeps): Promise<VoiceModeHandle> {
  const env = deps.env ?? procEnv;

  // 传输档:缺省 inprocess(逐字不变);websocket 走终端桥(大脑/VoiceLoop 在另一进程)。
  if (loadTransportKind(env) === 'websocket') {
    return startTerminalWebsocketMode(deps, env);
  }

  // STT / TTS 经配置工厂(缺省 Fake)。
  const sttCfg = loadSttConfig(env);
  const ttsCfg = loadTtsConfig(env);
  const stt = createStt(sttCfg);
  const tts = createTts(ttsCfg);

  // 语音路径(§4 双路径):缺省 stt(逐字不变);omni 档尝试构造 audio-in 端口。
  // 端口构造/key 缺失失败 → createOmniAudioPort 返回 undefined(已打印提示),此时即便选 omni
  // 也回落 STT(VoiceLoop 内部双保险:omni 端口为空则不走直路)。
  // 须在 createAudioDevice 前算好(能力驱动采集率要据生效路径读 stt/omni 的声明采样率)。
  const voicePath = loadVoicePath(env);
  const wantOmni = voicePath === 'omni';
  const omni = wantOmni ? createOmniAudioPort(env) : undefined;
  // 连续流式路(§全程流式):与 omni 互斥——CHAT_A_VOICE_PATH 单值决定,二者不会同时构造。
  // 端口构造/key 缺失失败 → createStreamingSttPort 返回 undefined(已打印提示),回落批式 STT。
  const wantStream = voicePath === 'stt-stream';
  const streamingStt = wantStream ? createStreamingSttPort(env) : undefined;
  // 实际生效路径:omni 端口真构造出 → 'omni';流式端口真构造出 → 'stt-stream';否则回落 'stt'
  //(供状态行如实反映回落)。omni 与 streamingStt 互斥,故顺序判定无歧义。
  const effectivePath: VoicePath =
    omni !== undefined ? 'omni' : streamingStt !== undefined ? 'stt-stream' : 'stt';

  // 能力驱动采集率:据生效路径读 STT capabilities.sampleRate / omni inputSampleRate(缺省 16000)。
  // stt-stream 走 STT 分支(QwenAsrRealtimeStt 固定 16k,与批式 STT 同口径)。
  const requiredInputRate = resolveRequiredInputRate(stt, omni, effectivePath === 'omni' ? 'omni' : 'stt');

  // 设备:真设备装不上则回落 Fake(明确提示)。能力驱动采集率 + 可选选择壳经 deps.audioSelect 注入。
  let device: AudioDevice;
  let real: boolean;
  try {
    const made = await createAudioDevice(env, { requiredInputRate, ...(deps.audioSelect ?? {}) });
    device = made.device;
    real = made.real;
  } catch (err) {
    stdout.write(`[语音] 真实音频设备初始化失败,已回落 Fake 设备:${err instanceof Error ? err.message : String(err)}\n`);
    device = new FakeAudioDevice();
    real = false;
  }

  // VAD / TurnDetector:按 CHAT_A_VAD 选真/桩;真路径加载/构造失败回落桩(明确提示,绝不崩)。
  const detectors = await createDetectors(env);

  // EchoGuard(§4 软件侧自打断防护):语音模式默认开;CHAT_A_ECHO_GUARD=off 显式关(回落逐字现状)。
  const echoGuard = loadEchoGuardConfig(env);

  const handle = runVoiceLoop({
    device,
    bus: deps.bus,
    loopDeps: {
      vad: detectors.vad,
      turnDetector: detectors.turnDetector,
      stt,
      tts,
      send: deps.send,
      memory: deps.memory,
      sessionId: deps.sessionId,
      // 防 ASR 静音幻觉 Layer 2:真 app 默认注入段级语音门——伪段(过短/无足够有声内容)不送 ASR,
      // 杜绝 qwen-asr 把噪声尖峰/静音幻觉成「嗯/thank you」。CLI 与 desktop 共用此装配。
      speechGate: DEFAULT_SPEECH_GATE_CONFIG,
      // EchoGuard:默认开(enabled:true);显式关时 echoGuard=undefined → 不带键 → VoiceLoop 逐字现状。
      ...(echoGuard ? { echoGuard } : {}),
      // §4.1:语音 I/O 语种解耦——仅在提供时透传(缺省不传 → STT 自动检测 + synthesize opts=undefined,逐字现状)。
      ...(deps.sttLanguage ? { sttLanguage: deps.sttLanguage } : {}),
      ...(deps.ttsOptions ? { ttsOptions: deps.ttsOptions } : {}),
      // omni 路:注入端口 + 路径开关 + 系统提示组装接缝(让 omni 直路有 persona/记忆/语气,omni-persona-context)。
      // composeOmniInstructions 仅在 omni 路且 cli 提供时透传(未提供 → omni 退回空 opts,逐字现状);STT 路不带。
      ...(omni !== undefined
        ? {
            omni,
            voicePath: 'omni' as const,
            ...(deps.composeOmniInstructions ? { composeOmniInstructions: deps.composeOmniInstructions } : {}),
            // omni-prosody-to-pad:把模型回复尾部情绪标签喂进 PAD(仅 omni 路且 cli 提供时;未提供 → 逐字现状)。
            ...(deps.advanceProsody ? { advanceProsody: deps.advanceProsody } : {}),
          }
        : {}),
      // 连续流式路(§全程流式):注入流式 ASR 端口 + 路径开关。与 omni 注入**互斥**
      //(CHAT_A_VOICE_PATH 单值决定,omni 与 streamingStt 不会同时构造出)。未构造出 → 不带键 → 批式现状。
      ...(streamingStt !== undefined ? { streamingStt, voicePath: 'stt-stream' as const } : {}),
    },
  });

  // companion-live-wiring:autonomy on 时(cli 传入钩子)用 VoiceLoop 真闸/抢占装配 autonomy。
  // 钩子内部回调失败不影响语音主链路(§3.2);off / 未传钩子时此处零开销。VoiceLoop 只被**读取**(不改其内部)。
  let voiceAutonomy: VoiceAutonomyHandle | undefined;
  if (deps.assembleVoiceAutonomy) {
    try {
      voiceAutonomy = deps.assembleVoiceAutonomy(handle.loop, handle.bus);
    } catch (err) {
      stdout.write(
        `[语音] autonomy 装配失败(已跳过,不影响对话):${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  return {
    info: {
      device: `${device.id}${real ? '' : ' (占位/无真采集)'}`,
      stt: sttCfg.kind,
      tts: ttsCfg.kind,
      vad: detectors.vadKind,
      eou: detectors.eouKind,
      transport: 'inprocess',
      path: effectivePath,
      echoGuard: echoGuard ? 'on' : 'off',
    },
    stop: () => {
      // 先停 autonomy(停定时器 + 退订总线),再停语音闭环;均幂等、失败吞(§3.2)。
      try {
        voiceAutonomy?.stop();
      } catch {
        /* ignore */
      }
      handle.stop();
    },
  };
}

/**
 * 终端 WebSocket 模式(B 架构「终端」侧):本进程**只**起设备 + WS client transport + 设备桥,
 * STT/TTS/VAD/EOU/VoiceLoop 全在**大脑侧另一进程**(故 info 中标「大脑侧」)。
 *
 * 大脑侧 server 进程如何起(本地双进程手测指引):
 *   1. 另起一个 node 进程,用 `ws` 建 `WebSocketServer({ port: 8787 })`;
 *   2. 在 `connection` 事件里 `acceptServerTransport(ws)` 得到大脑侧 transport;
 *   3. 把它作为 `transport` 传给 `runVoiceLoop`(或直接喂 VoiceLoop),即得「大脑」。
 *   (本 change 提供 transport 两端实现 + 单测;大脑侧进程脚手架与真机手测留主控/后续 change。)
 * 终端经 `CHAT_A_GATEWAY_URL`(默认 {@link DEFAULT_GATEWAY_URL})连大脑;鉴权/WSS 为接缝预留未实装。
 */
async function startTerminalWebsocketMode(
  deps: VoiceModeDeps,
  env: NodeJS.ProcessEnv,
): Promise<VoiceModeHandle> {
  const url = env['CHAT_A_GATEWAY_URL'] ?? DEFAULT_GATEWAY_URL;

  // 设备:真设备装不上则回落 Fake(明确提示,沿用 inprocess 范式)。
  let device: AudioDevice;
  let real: boolean;
  try {
    const made = await createAudioDevice(env);
    device = made.device;
    real = made.real;
  } catch (err) {
    stdout.write(
      `[语音] 真实音频设备初始化失败,已回落 Fake 设备:${err instanceof Error ? err.message : String(err)}\n`,
    );
    device = new FakeAudioDevice();
    real = false;
  }

  // 终端侧 WS transport:连大脑;断网→指数重连(在 transport 内,绝不崩,§8)。
  const transport = connectClientTransport(url, { sessionId: deps.sessionId });
  stdout.write(`[语音] WebSocket 传输:连接大脑 ${url}(STT/TTS/VAD/EOU 在大脑侧)\n`);

  const bridge = runTerminalBridge({ device, transport });

  let stopped = false;
  return {
    info: {
      device: `${device.id}${real ? '' : ' (占位/无真采集)'}`,
      stt: '大脑侧',
      tts: '大脑侧',
      vad: '大脑侧',
      eou: '大脑侧',
      transport: 'websocket',
      // 语音路径由大脑侧 VoiceLoop 决定(终端是哑收发端);此处标 stt 占位,真值在大脑侧 info。
      path: 'stt',
      // EchoGuard 由大脑侧 VoiceLoop 决定(终端不跑 loop);此处标 off 占位,真值在大脑侧 info。
      echoGuard: 'off',
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      bridge.stop();
      try {
        transport.close();
      } catch {
        /* ignore */
      }
    },
  };
}
