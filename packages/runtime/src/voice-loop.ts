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
import type { AudioFrame, AudioTransport, Unsubscribe } from '@chat-a/protocol';
import { makeBusEvent, makeDataFrame, type PcmFrame } from '@chat-a/protocol';
import type { VadDetector, TurnDetector } from '@chat-a/voice-detect';
import type { SttProvider, TtsProvider, PcmChunk } from '@chat-a/providers';
import type { MemoryStore } from '@chat-a/memory';
import type { LightVoiceBus } from './bus';
import { SentenceSplitter } from './sentence-splitter';
import { nextState, type VoiceBusEvent, type VoiceState } from './voice-turn-state';
import {
  evaluateAttention,
  type AttentionGateOptions,
  type AttentionMode,
  type UserVoiceSignal,
} from './attention';

/** 被打断半句写回记忆时拼接的尾标（承 OLV：小雪记得在哪被打断）。 */
const INTERRUPT_MARK = '[被用户打断]';

/** TurnDetector 选阈值用的语种码（v1 固定中文；后续可由 STT detected language 驱动）。 */
const DEFAULT_LANG = 'zh';

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
   * 想：吃用户文本 + onToken（逐 token 回调）+ 可选 signal（协作取消），resolve 完整回复。
   * `signal` 在打断时被 abort，使底层 LLM 流真停（§3.2 真打断）；可选、向后兼容（不传 signal 的
   * 旧实现仍可注入，只是不可取消）。装配处传 `conversation.send.bind(conversation)`。
   */
  readonly send: (text: string, onToken: (t: string) => void, signal?: AbortSignal) => Promise<string>;
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
}

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
  readonly #send: (text: string, onToken: (t: string) => void, signal?: AbortSignal) => Promise<string>;
  readonly #memory: Pick<MemoryStore, 'appendMessage'>;
  readonly #bus: LightVoiceBus;
  readonly #sessionId: string;
  readonly #now: () => number;
  /** 关注闸配置（§7 软反转）；未注入则保持现状即时打断（autonomy 默认关时逐字不变）。 */
  readonly #attention: VoiceLoopAttentionConfig | undefined;
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

  /** 启动：订阅上行音频，进入 listening。重复 start 幂等（先退订旧的）。 */
  start(): void {
    this.stop();
    this.#state = 'listening';
    this.#unsub = this.#transport.onAudio((frame) => this.#onAudio(frame));
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
  }

  /** abort 当前回合的取消控制器（若有）并清空句柄；幂等、不抛（§3.2）。 */
  #abortCurrent(): void {
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
    this.#state = to;
    try {
      this.#emit(event, opts);
    } catch (err) {
      // emit 失败不应打断回合推进（总线问题不致命,§3.2）
      console.warn('[VoiceLoop] emit BusEvent 抛错(已捕获):', err);
    }
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
      const result = this.#vad.pushFrame(pcm);
      const evt = result.event;

      // listening：检出语音起点 → endpointing，开始累积
      if (this.#state === 'listening') {
        if (evt?.type === 'speech_start') {
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
          this.#beginThinking(); // → thinking（STT + send）
        }
        return;
      }

      // speaking：检出语音起点 → barge_in_pending → v1 即时打断（或经关注闸据 attention_mode 判定）
      if (this.#state === 'speaking') {
        if (this.#attention === undefined) {
          // 未注入关注闸（autonomy 默认关）：逐字保持现状——检出语音起点即进 barge_in_pending 即时打断。
          if (evt?.type === 'speech_start') {
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
        } else if (result.speaking && this.#userSpeechStartAtMs !== null) {
          this.#applyAttention(pcm.timestampMs);
        }
        return;
      }

      // thinking / barge_in_pending：上行音频暂不驱动迁移（v1）
    } catch (err) {
      // 上行处理任何异常都不应崩；回 listening 兜底
      console.warn('[VoiceLoop] onAudio 抛错(已捕获,回 listening):', err);
      this.#resetToListening();
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

  /** endpointing → thinking：先迁移（emit stt:final 在 #startThinking 内做，带真转写文本）。 */
  #beginThinking(): void {
    void this.#startThinking();
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

    let text: string;
    try {
      text = await this.#transcribe(buf);
    } catch (err) {
      console.warn('[VoiceLoop] STT 抛错(降级回 listening):', err);
      this.#resetToListening();
      return;
    }
    if (gen !== this.#gen) return; // 转写期间被打断/换回合
    if (text.trim().length === 0) {
      // 空转写：降级回 listening（仍在 endpointing 态，用 vad:speech_end 合法迁移）
      this.#resetToListening();
      return;
    }

    // endpointing → thinking（emit stt:final 带真转写文本）
    if (this.#state !== 'endpointing') {
      // 状态已变（如被打断),放弃本回合
      return;
    }
    if (!this.#go('stt:final', { text })) {
      this.#resetToListening();
      return;
    }

    // 起想：onToken 凑句**串行**喂 #speak（保句序 + 便于在 send 完成后等全部出尽再收尾）。
    this.#replyAccum = '';
    const splitter = new SentenceSplitter();
    // 本回合取消控制器（§3.2 真打断）：打断/停止时 abort 之，使底层 LLM 流 + 在途 TTS 合成真停（不再后台跑到完）。
    const ac = new AbortController();
    this.#currentAbort = ac;
    // 串行说话链:每句接在上一句之后,保证下行 tts:chunk 顺序与句序一致。
    let speakChain: Promise<void> = Promise.resolve();
    // 透传本回合 ac.signal 到 #speak → tts.synthesize：打断/停止 abort() 后,在途 TTS 合成真停（§3.2）。
    // onToken 凑句与 send 完成后的尾句 flush 共用此闭包,故一处带上 signal 即覆盖全部喂句。
    const enqueueSpeak = (sentence: string): void => {
      speakChain = speakChain.then(() => this.#speak(sentence, gen, ac.signal));
    };
    const onToken = (tok: string): void => {
      if (gen !== this.#gen) return; // 作废：本回合已被打断/替换
      this.#replyAccum += tok;
      for (const sentence of splitter.push(tok)) enqueueSpeak(sentence);
    };

    this.#currentTurn = this.#send(text, onToken, ac.signal)
      .then(async (full) => {
        if (gen !== this.#gen) return; // 已被打断：忽略输出（协作式放弃）
        // 累积以 send 返回的完整回复为准(onToken 可能漏拼)
        if (full.length >= this.#replyAccum.length) this.#replyAccum = full;
        const tail = splitter.flush();
        if (tail !== null) enqueueSpeak(tail);
        await speakChain; // 等所有句出尽(首句已触发 thinking→speaking)再收尾
        this.#finishTurn(gen);
      })
      .catch((err) => {
        // 被打断的回合(gen 已变)其 send 多以 AbortError reject —— 属正常取消,静默忽略不重复 reset;
        // 仅当仍是本回合(真错误)才 warn + 回 listening 兜底(§3.2)。
        if (gen === this.#gen) {
          console.warn('[VoiceLoop] send 抛错(回 listening):', err);
          this.#resetToListening();
        }
      })
      .finally(() => {
        // 回合自然结束/出错收尾后清理本回合控制器(若仍是它);打断已在 #interrupt 里清。
        if (this.#currentAbort === ac) this.#currentAbort = null;
      });
  }

  /**
   * 收尾：send 完成后置 turn:end → listening。
   * v1 简化：不等播放真正排空（Fake TTS 同步出尽）；gen 失配即不收尾（已被打断）。
   */
  #finishTurn(gen: number): void {
    if (gen !== this.#gen) return;
    // 仍在 speaking 才合法迁移 turn:end;若从未进 speaking(无音频)则直接回 listening
    if (this.#state === 'speaking') {
      this.#go('turn:end');
    } else {
      this.#resetToListening();
    }
    this.#replyAccum = '';
  }

  /** 把累积音频帧转 PcmChunk 流喂 STT，取最后一条 final 文本（无 final 取最后一条）。 */
  async #transcribe(buf: readonly PcmFrame[]): Promise<string> {
    const self = this;
    async function* toChunks(): AsyncIterable<PcmChunk> {
      for (const f of buf) yield self.#toPcmChunk(f);
    }
    let lastFinal = '';
    let lastAny = '';
    for await (const r of this.#stt.transcribe(toChunks())) {
      lastAny = r.text;
      if (r.isFinal) lastFinal = r.text;
    }
    return lastFinal.length > 0 ? lastFinal : lastAny;
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
      for await (const chunk of this.#tts.synthesize(sentence, undefined, signal)) {
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
    this.#go('turn:interrupt', { reason }); // barge_in_pending → listening(reason 透传可追溯)
  }

  // ───────────────────────────── 兜底 ─────────────────────────────

  /**
   * 强制回 listening（降级兜底）：若当前态有合法路径就走（emit 对应事件），
   * 否则直接硬置 listening（不 emit，避免非法迁移 warn 噪声）。
   */
  #resetToListening(): void {
    if (this.#state === 'listening') return;
    // 优先走合法迁移以保持 BusEvent 可追溯
    if (this.#state === 'endpointing') {
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
