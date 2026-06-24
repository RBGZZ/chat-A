/**
 * Electron 主进程 ↔ 渲染层 的 **IPC 契约**(承 desktop-electron-frontend §3):
 * channel 常量(单一真相源)+ 类型 + **不依赖 electron 的映射纯逻辑**(可在 vitest 直接单测)。
 *
 * 设计(§3.1/§3.2):把"总线事件→UI 状态派生""回合编排→token/reply/error 序列""naudiodon 探测降级"
 * 这些**会决定 UI 行为**的逻辑抽成纯函数/纯类,既能 headless 单测,又让 main.ts 退化成薄壳。
 * 本文件 **不 import electron**(故 vitest 无需 electron 也能跑)。
 */
import type { BusEvent } from '@chat-a/protocol';
import type { LightVoiceBus } from '@chat-a/runtime';

// ───────────────────────────── channel 常量 ─────────────────────────────

/** IPC channel 名(单一真相源;preload/main/测试共用,杜绝散落字符串)。 */
export const IPC = {
  // 渲染 → 主(ipcRenderer.invoke)
  send: 'chat:send',
  voiceStart: 'voice:start',
  voiceStop: 'voice:stop',
  reset: 'session:reset',
  getInfo: 'app:get-info',
  // 主 → 渲染(webContents.send)
  token: 'chat:token',
  reply: 'chat:reply',
  error: 'chat:error',
  state: 'state:change',
  mood: 'mood:change',
  transcript: 'voice:transcript',
  voiceStatus: 'voice:status',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

// ───────────────────────────── 类型 ─────────────────────────────

/** UI 四态(状态栏展示):空闲 / 在听 / 在想 / 在说。 */
export type UiState = 'idle' | 'listening' | 'thinking' | 'speaking';

/** 心情摘要(状态栏展示;由 persona.tone() 摘要而来)。 */
export interface MoodSummary {
  readonly emotion: string;
  readonly pleasure: number;
  readonly arousal: number;
  readonly dominance: number;
}

/** 语音可用性状态(naudiodon 探测/启动结果);渲染层据此启用/禁用语音按钮。 */
export interface VoiceStatus {
  readonly available: boolean;
  /** 不可用时的中文原因(渲染层 tooltip 展示)。 */
  readonly reason?: string;
  /** 可用时:语音路径(stt/omni)。 */
  readonly path?: string;
  /** 可用时:设备标识。 */
  readonly device?: string;
}

/** 应用信息(横幅用;getInfo 返回)。 */
export interface AppInfo {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly memory: string;
  readonly isFake: boolean;
  readonly warmth: number;
  readonly expressiveness: number;
  readonly volatility: number;
}

// ───────────────────────────── state 派生(纯) ─────────────────────────────

/** 语音不可用的标准中文降级文案(单一真相源,§3.2)。 */
export const VOICE_UNAVAILABLE_REASON = '语音需安装原生音频(见 README);文字对话仍可正常使用。';

/**
 * 据一条总线事件 + 当前 UI 态推导下一个 UI 态(纯函数,确定性,§3.2 可测试性):
 * - `turn:start` → thinking(开始想)
 * - `tts:first_audio` → speaking(开始说,首音频到)
 * - `turn:end` → idle(回合结束回空闲)
 * - `vad:speech_start` → listening(用户开口,在听)
 * - `vad:speech_end` → 若仍在回合中保持 thinking(用户说完等模型);否则回 idle
 * 其它事件 → 保持当前态(不影响 UI 状态机)。
 */
export function deriveState(prev: UiState, event: BusEvent): UiState {
  switch (event.action) {
    case 'turn:start':
      return 'thinking';
    case 'tts:first_audio':
      return 'speaking';
    case 'turn:end':
      return 'idle';
    case 'vad:speech_start':
      return 'listening';
    case 'vad:speech_end':
      // 用户说完:正在听 → 转为在想(等模型);若已是 speaking/thinking 等保持。
      return prev === 'listening' ? 'thinking' : prev;
    default:
      return prev;
  }
}

/**
 * UI 状态跟踪器:持当前态,订阅 LightVoiceBus 把粗粒度总线事件归约成 UI 四态,
 * 仅在**态变化**时回调 `onChange`(避免无谓刷新)。`start(bus)` 返回退订函数。
 */
export class StateTracker {
  #state: UiState = 'idle';
  readonly #listeners = new Set<(s: UiState) => void>();

  get state(): UiState {
    return this.#state;
  }

  onChange(cb: (s: UiState) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  /** 喂一条事件,推进状态机;变化则通知监听者。返回是否发生了变化。 */
  feed(event: BusEvent): boolean {
    const next = deriveState(this.#state, event);
    if (next === this.#state) return false;
    this.#state = next;
    for (const cb of [...this.#listeners]) cb(next);
    return true;
  }

  /** 订阅总线全量事件驱动状态机;返回退订函数。 */
  start(bus: LightVoiceBus): () => void {
    return bus.onAny((e) => {
      this.feed(e);
    });
  }
}

/** 把 persona.tone() 的结果摘要成 UI 心情(纯函数)。 */
export function toMoodSummary(tone: {
  readonly emotion: string;
  readonly pad: { readonly pleasure: number; readonly arousal: number; readonly dominance: number };
}): MoodSummary {
  return {
    emotion: tone.emotion,
    pleasure: tone.pad.pleasure,
    arousal: tone.pad.arousal,
    dominance: tone.pad.dominance,
  };
}

// ───────────────────────────── 回合编排(纯) ─────────────────────────────

/** runSendTurn 所需的最小注入面(便于 headless 单测)。 */
export interface SendTurnPort {
  /** 想:吃用户文本 + onToken,resolve 完整回复(传 `app.convo.send`)。 */
  readonly send: (text: string, onToken: (t: string) => void) => Promise<string>;
  /** 向渲染层发一条 IPC(主进程传 `(ch,p)=>win.webContents.send(ch,p)`)。 */
  readonly emit: (channel: IpcChannel, payload: unknown) => void;
}

/** 回合出错时的标准中文降级文案(§3.2,永不崩永不哑)。 */
export const CHAT_ERROR_TEXT = '(小雪一时没接上话——可能是网络或模型出了点问题,稍后再试。)';

/**
 * 编排一个文字回合(纯,可单测,§3.2):
 * - `send(text, onToken)`:每个 token 经 `emit(IPC.token, t)` 逐个流式推给渲染层;
 * - resolve → `emit(IPC.reply, reply)`(本回合完整回复,供渲染层定型气泡);
 * - 抛错 → `emit(IPC.error, { text, detail })`(友好中文降级文案),**不向上抛**(主进程绝不崩)。
 */
export async function runSendTurn(port: SendTurnPort, text: string): Promise<void> {
  try {
    const reply = await port.send(text, (t) => port.emit(IPC.token, t));
    port.emit(IPC.reply, reply);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    port.emit(IPC.error, { text: CHAT_ERROR_TEXT, detail });
  }
}

// ───────────────────────────── naudiodon 探测(纯) ─────────────────────────────

/** probeVoice 注入面:能 `init()`(可能抛)的最小设备形态。 */
export interface ProbeDevice {
  init(): Promise<void>;
}

/**
 * 探测原生音频可用性(naudiodon)(纯,可单测,§3.2):
 * `makeDevice()` 造一个 `NodeAudioDevice` → `await init()` 动态加载 naudiodon。
 * - 成功 → `{ available:true }`(随后主进程进入 `startVoiceMode` 跑语音闭环);
 * - 抛错(未装/未 rebuild)→ `{ available:false, reason }`(中文原因),**不向上抛**,
 *   让 UI 禁用语音按钮、文字路不受影响。
 */
export async function probeVoice(makeDevice: () => ProbeDevice): Promise<VoiceStatus> {
  try {
    const device = makeDevice();
    await device.init();
    return { available: true };
  } catch {
    return { available: false, reason: VOICE_UNAVAILABLE_REASON };
  }
}
