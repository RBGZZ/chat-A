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
  voiceClone: 'voice:clone',
  /** 渲染→主:设置面板写回语音输出语种(CHAT_A_VOICE_OUTPUT_LANG;运行时即时生效 + 持久化)。 */
  settingsSetOutputLang: 'settings:set-output-lang',
  // —— 人格自定义(代理C) ——
  /** 渲染→主:读当前可编辑人格(名字 + 三档)。 */
  personaGet: 'persona:get',
  /** 渲染→主:应用人格修改(运行时生效 + 可选持久化)。 */
  personaUpdate: 'persona:update',
  // 主 → 渲染(webContents.send)
  token: 'chat:token',
  reply: 'chat:reply',
  error: 'chat:error',
  state: 'state:change',
  mood: 'mood:change',
  transcript: 'voice:transcript',
  voiceStatus: 'voice:status',
  voiceCloneResult: 'voice:clone-result',
  voiceCloneStatus: 'voice:clone-status',
  /** 主→渲染:复刻进行中进度(上传/创建/异步部署轮询期),渲染层显示"复刻处理中"。 */
  voiceCloneProgress: 'voice:clone-progress',
  proactiveMessage: 'proactive:message', // —— 主动消息(代理B) ——
  // —— 记忆/设置(代理D) ——
  /** 渲染 → 主:只读列出最近 N 条记忆(陪伴工具记忆查看面板;绝不触发写/巩固)。 */
  memoryList: 'memory:list',
  // —— 语种控制(本批次:显示/合成/复刻三独立语种 + 朗读开关) ——
  /** 渲染 → 主:读当前三语种 + 朗读开关 + 朗读是否可用(语言面板初值)。 */
  langGet: 'lang:get',
  /** 渲染 → 主:应用语种/朗读设置(运行时生效 + 持久化到 .env.local)。 */
  langSet: 'lang:set',
  // —— 朗读(本批次:文字回复 → 渲染层 Web Audio 播放) ——
  /** 主 → 渲染:一块合成 PCM(Int16@sampleRate),渲染层排队无缝播放。 */
  ttsAudio: 'tts:audio',
  /** 主 → 渲染:停止并清空播放队列(回合结束/被打断)。 */
  ttsAudioStop: 'tts:audio-stop',
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

/** 复刻一键请求载荷:渲染层给本地文件路径(优先)或字节(兜底,无 .path 时)。 */
export interface VoiceCloneInput {
  /** 本地音频文件路径(Electron 渲染层 File.path);可用即用。 */
  readonly path?: string;
  /** 兜底:音频字节(无 path 时,渲染层经 arrayBuffer() 传)。 */
  readonly bytes?: Uint8Array;
  /** 兜底字节对应的 MIME(随 bytes 给)。 */
  readonly mime?: string;
}

/** 复刻结果(主→渲染):成功带 voiceId,失败带中文文案。 */
export interface VoiceCloneResult {
  readonly ok: boolean;
  /** 成功时:复刻得到的 voice id。 */
  readonly voiceId?: string;
  /** 文案(成功提示 / 失败友好中文)。 */
  readonly message: string;
}

/** 复刻进行中进度(主→渲染):轮询/上传期的中文进度文案。 */
export interface VoiceCloneProgress {
  readonly message: string;
}

/** 复刻区可用性(主→渲染):无 key 时禁用 + 中文提示。 */
export interface VoiceCloneStatus {
  readonly available: boolean;
  /** 不可用时中文原因(渲染层 tooltip / 提示)。 */
  readonly reason?: string;
}

/** 应用信息(横幅 + 设置面板用;getInfo 返回)。 */
export interface AppInfo {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly memory: string;
  readonly isFake: boolean;
  readonly warmth: number;
  readonly expressiveness: number;
  readonly volatility: number;
  /**
   * 语音输出语种(CHAT_A_VOICE_OUTPUT_LANG;''=自动)。设置面板据此回填可写下拉。
   * **与输入 STT 语种、与 voiceId 正交**(语种解耦既定原则);独立于语言面板的显示文字语种。
   */
  readonly outputLang: string;
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

// ───────────────────────────── 一键复刻(纯) ─────────────────────────────

/** 复刻区无 key 时的标准中文提示(单一真相源,§3.2)。 */
export const CLONE_NO_KEY_REASON =
  '声音复刻需要 DashScope API key;请在项目根 .env.local 填写 CHAT_A_DASHSCOPE_API_KEY 后重启。';
/** 复刻失败的标准中文降级文案前缀(§3.2,永不崩)。 */
export const CLONE_ERROR_TEXT = '声音复刻没成功——';

/**
 * 在 `.env.local` 文本里 upsert 一个键(纯函数,可单测,§3.2):
 * - 已存在(忽略前导空白、允许 `export ` 前缀)→ 原地替换其值,保留其它行与注释;
 * - 不存在 → 末尾追加一行(必要时补换行);
 * - 空文本 → 直接产出 `KEY=value\n`。
 * 值不做引号包裹(voiceId 为安全字符);返回新文本。
 */
export function upsertEnvLocal(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const lines = text.split('\n');
  const re = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=`);
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i] as string)) {
      lines[i] = line;
      replaced = true;
      break;
    }
  }
  if (replaced) return lines.join('\n');
  // 追加:确保与既有内容隔一行,文末留换行。
  if (text.length === 0) return `${line}\n`;
  const sep = text.endsWith('\n') ? '' : '\n';
  return `${text}${sep}${line}\n`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** runCloneVoice 注入面(便于 headless 单测;不依赖 electron / 真网络 / 真盘)。 */
export interface CloneVoicePort {
  /** 真复刻:吃载荷 → resolve voiceId(主进程注入:读文件 + 调 createVoice)。 */
  readonly clone: (input: VoiceCloneInput) => Promise<string>;
  /** 持久化 voiceId(主进程注入:写 .env.local CHAT_A_VOICE_ID + 设进程 env);失败可抛,会被降级。 */
  readonly persist: (voiceId: string) => void | Promise<void>;
  /** 向渲染层推一条 IPC(主进程传 webContents.send 包装)。 */
  readonly emit: (channel: IpcChannel, payload: unknown) => void;
}

/**
 * 编排一次"一键复刻"(纯,可单测,§3.2):
 * - 成功:`persist(voiceId)` 后 `emit(voiceCloneResult, {ok:true, voiceId, message})`;
 *   即使 persist 抛错也算复刻成功(voiceId 已拿到),只在文案里提示需手动填,**不丢结果**。
 * - 失败:`emit(voiceCloneResult, {ok:false, message})`(友好中文 + detail),**不向上抛**(主进程绝不崩)。
 */
export async function runCloneVoice(port: CloneVoicePort, input: VoiceCloneInput): Promise<void> {
  let voiceId: string;
  try {
    voiceId = await port.clone(input);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    port.emit(IPC.voiceCloneResult, {
      ok: false,
      message: `${CLONE_ERROR_TEXT}${detail}`,
    } satisfies VoiceCloneResult);
    return;
  }
  let persistWarn = '';
  try {
    await port.persist(voiceId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    persistWarn = `(已复刻,但保存配置失败,请手动把 CHAT_A_VOICE_ID 写入 .env.local:${detail})`;
  }
  port.emit(IPC.voiceCloneResult, {
    ok: true,
    voiceId,
    message: `小雪的新声音已就绪(音色 id 已保存,重启后自动生效)。${persistWarn}`,
  } satisfies VoiceCloneResult);
}

// ═══════════════════════════════ 代理B:主动消息(自发气泡)═══════════════════════════════
//
// 主动陪伴(北极星「会主动开口」):autonomy 引擎在用户空闲时,经真 persona/记忆生成一句主动话,
// 经 `IPC.proactiveMessage` 推给渲染层,渲染成一条带「主动」标记的小雪气泡(与用户回合 pendingBubble
// 互不干扰)。下列为该通道的类型 + 不依赖 electron 的纯逻辑(headless 可单测)。
//
// **不涉及 TTS 语种**:本通道只把主动话送成文字气泡,不经 TTS 朗读;若后续要发声,应沿用既有
// VoiceLoop/TTS 的 `language_type` 输出语种路径(输出语种由配置/人格决定、与输入语种解耦),不在此绕过。

/** 一条主动消息(主→渲染):小雪自发说的话 + 来源信号 kind + 是否伴随抢占。 */
export interface ProactiveMessage {
  /** 主动话语正文(经 persona guardrail 的真实话语,非空)。 */
  readonly text: string;
  /** 触发本次主动回合的感知信号 kind(便于 UI/追溯标注;如 `temporal:idle-tick`)。 */
  readonly signalKind: string;
  /** 本次是否伴随抢占(打断在说者);渲染层可据此微调标记。 */
  readonly preempted: boolean;
}

/**
 * 把一条 autonomy `ProactiveSpeech`(client 侧形态)归一为可上 IPC 的 {@link ProactiveMessage}(纯函数,
 * 可单测,§3.2):裁剪首尾空白;`text` 为空白则返回 null(调用方据此**不推**,绝不推空气泡)。
 * `signalKind`/`preempted` 缺省给安全值。
 */
export function toProactiveMessage(speech: {
  readonly text: string;
  readonly signalKind?: string;
  readonly preempted?: boolean;
}): ProactiveMessage | null {
  const text = (speech.text ?? '').trim();
  if (text.length === 0) return null;
  return {
    text,
    signalKind: speech.signalKind ?? 'unknown',
    preempted: speech.preempted === true,
  };
}

/**
 * 解析主动陪伴是否启用(纯函数,可单测,§3.2):沿用 autonomy 主开关 `CHAT_A_AUTONOMY=on`
 * (大小写不敏感、去空白);**缺省/任何其它值 = 关**(默认安全,绝不擅自开口)。
 * 与 `@chat-a/autonomy` 的 `isAutonomyEnabled` 同义;此处复制一份纯逻辑以便 desktop 侧 headless 单测,
 * 不引入对 autonomy 的额外依赖(主进程仍以 client 的真装配为准)。
 */
export function isProactiveEnabled(env: Record<string, string | undefined>): boolean {
  return (env['CHAT_A_AUTONOMY'] ?? '').trim().toLowerCase() === 'on';
}
// ───────────────────────────── 人格自定义(代理C) ─────────────────────────────

/**
 * 人格面板可编辑表单(渲染↔主):名字 + 三档情绪旋钮(warmth/expressiveness/volatility,均 [0,1])。
 * 与 AppInfo / persona.PersonaView 的三档同名同义;**不含语种字段**——输出语种解耦是项目既定原则,
 * 人格 dials 与语种正交,人格自定义不引入"输出语种硬绑输入语种"的任何逻辑。
 */
export interface PersonaForm {
  readonly name: string;
  readonly warmth: number;
  readonly expressiveness: number;
  readonly volatility: number;
}

/** 人格 dial 取值的合法区间(单一真相源;三档同区间)。 */
export const PERSONA_DIAL_MIN = 0;
export const PERSONA_DIAL_MAX = 1;

/** 把单个 dial 夹取到 [PERSONA_DIAL_MIN, PERSONA_DIAL_MAX];非有限 → 回落 fallback(纯,可单测)。 */
export function clampDial(raw: number, fallback: number): number {
  if (!Number.isFinite(raw)) return fallback;
  return raw < PERSONA_DIAL_MIN ? PERSONA_DIAL_MIN : raw > PERSONA_DIAL_MAX ? PERSONA_DIAL_MAX : raw;
}

/**
 * 规整渲染层提交的人格表单(纯函数,可 headless 单测,§3.2):
 * - 名字:trim;空白 → 回落 fallback.name(绝不产出空名)。
 * - 三档:各自经 {@link clampDial} 夹取 [0,1];非有限 → 回落 fallback 对应档。
 * fallback 传当前人格视图,保证任何缺漏/非法输入都退化为"维持现状"而非破坏人格。
 */
export function sanitizePersonaForm(raw: Partial<PersonaForm>, fallback: PersonaForm): PersonaForm {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  return {
    name: name.length > 0 ? name : fallback.name,
    warmth: clampDial(typeof raw.warmth === 'number' ? raw.warmth : Number.NaN, fallback.warmth),
    expressiveness: clampDial(
      typeof raw.expressiveness === 'number' ? raw.expressiveness : Number.NaN,
      fallback.expressiveness,
    ),
    volatility: clampDial(
      typeof raw.volatility === 'number' ? raw.volatility : Number.NaN,
      fallback.volatility,
    ),
  };
}

// ───────────────────────────── 记忆/设置(代理D) ─────────────────────────────

/**
 * 记忆面板用的展示条目(主→渲染;只读):把 memory 的 `MemoryRecord` 蒸馏成 UI 需要的最小面。
 * 与 `@chat-a/memory` 的 `MemoryRecord` 字段同义(text/memoryKind/createdAtMs/lastSeenAtMs/importance),
 * 但本类型**自含**(不跨包 import memory 类型,保持 ipc-contract 纯逻辑、不引入新依赖)。
 */
export interface MemoryItem {
  /** 记忆正文。 */
  readonly text: string;
  /** 认知分层中文标签(episodic→情景 / semantic→事实 / core→核心)。 */
  readonly kindLabel: string;
  /** 重要度 [0,1],保留两位(供 UI 直接展示)。 */
  readonly importance: number;
  /** 最近被想起/更新的时间(毫秒;UI 自行本地化展示)。 */
  readonly lastSeenAtMs: number;
  /** 首次记下的时间(毫秒)。 */
  readonly createdAtMs: number;
}

/**
 * `toMemoryItems` 入参的最小结构形(只读 memory 条目需要的字段子集)。
 * `@chat-a/memory` 的 `MemoryRecord` 结构上满足它,故 main.ts 可直接传 `memory.listRecent()` 结果,
 * 而本模块无需 import memory 包(保持纯逻辑可 headless 单测)。
 */
export interface MemoryRecordLike {
  readonly text: string;
  readonly memoryKind?: 'episodic' | 'semantic' | 'core';
  readonly importance?: number;
  readonly lastSeenAtMs: number;
  readonly createdAtMs: number;
}

/** 认知分层 → 中文展示标签(单一真相源;未知值兜底为「情景」,与 memory 读列兜底一致)。 */
const MEMORY_KIND_LABEL: Record<'episodic' | 'semantic' | 'core', string> = {
  episodic: '情景',
  semantic: '事实',
  core: '核心',
};

/**
 * 把只读记忆记录映射为 UI 展示条目(纯函数,可 headless 单测,§3.2):
 * - 分层取中文标签(缺省/未知 → 情景);
 * - importance 缺省 0、夹到 [0,1] 并保留两位;
 * - 时间戳原样透传(UI 侧本地化)。**只做格式化,不读库不触发任何写/巩固**。
 */
export function toMemoryItems(records: readonly MemoryRecordLike[]): readonly MemoryItem[] {
  return records.map((r) => ({
    text: r.text,
    kindLabel: MEMORY_KIND_LABEL[r.memoryKind ?? 'episodic'],
    importance: Math.round(Math.min(Math.max(r.importance ?? 0, 0), 1) * 100) / 100,
    lastSeenAtMs: r.lastSeenAtMs,
    createdAtMs: r.createdAtMs,
  }));
}

// ═══════════════════════════════ 三独立语种控制 + 朗读(本批次) ═══════════════════════════════
//
// 显示/合成/复刻**三个独立语种**(承 canonical §4.1 语种解耦)+ 朗读开关。语言面板里:
//  1) 显示文字语种 displayLang(看到的)→ 驱动 LLM 回复语言(Conversation 的 outputLang),env CHAT_A_DISPLAY_LANG;
//  2) 合成音频语种 ttsLang(听到的)→ TTS 的 language + 决定是否翻译,env CHAT_A_TTS_LANG,特殊值 follow=跟随显示;
//  3) 复刻参考语种 cloneRefLang(复刻录音是什么语言)→ 复刻时用,env CHAT_A_VOICE_CLONE_REF_LANG。
//
// **显示/合成解耦是一等概念**:displayText(进气泡)与 spokenText(喂 TTS)是两个独立字段,绝不假设相等。
// 下列纯函数把「语种解析(effectiveTtsLang / 是否翻译 / 默认值)」钉死成 ipc-contract 风格纯逻辑(headless 可单测)。

/** ttsLang 的特殊值:跟随显示语种(默认)。大小写不敏感。 */
export const TTS_LANG_FOLLOW = 'follow';

/** 显示语种特殊值/空 = 自动(不强制 LLM 回复语言;TTS 也不下发 language)。 */
export const DISPLAY_LANG_AUTO = '';

/** 语言面板可编辑表单(渲染↔主):三独立语种(ISO 码;空=自动/跟随)+ 朗读开关 + 朗读是否可用。 */
export interface LangForm {
  /** 显示文字语种(ISO:''=自动 / zh / en / ja / ko …)。 */
  readonly displayLang: string;
  /** 合成音频语种(''/follow=跟随显示 / 具体 ISO)。 */
  readonly ttsLang: string;
  /** 复刻参考语种(''=不指定 / 具体 ISO);用于即时复刻/未来 provider(qwen 云复刻语种中性)。 */
  readonly cloneRefLang: string;
  /** 朗读开关(渲染层据此决定是否朗读小雪文字回复)。 */
  readonly speak: boolean;
  /** 朗读是否可用(TTS provider 解析为真合成才 true;Fake/无真合成→false,渲染层禁开关并提示)。 */
  readonly speakAvailable: boolean;
}

/** 规整一个语种码(纯):trim;`auto`/空 → ''(自动)。不强制大小写(ISO 码与 Qwen 名映射另在 providers 侧做)。 */
export function normalizeLangCode(raw: string | undefined): string {
  const s = (raw ?? '').trim();
  if (s.length === 0 || s.toLowerCase() === 'auto') return DISPLAY_LANG_AUTO;
  return s;
}

/**
 * 规整 ttsLang(纯):trim;空 → follow(默认跟随);`follow`(大小写不敏感)→ 'follow';否则视作语种码(经 normalizeLangCode)。
 * 返回 'follow' 或具体语种码或 ''(用户显式填 auto)。
 */
export function normalizeTtsLang(raw: string | undefined): string {
  const s = (raw ?? '').trim();
  if (s.length === 0) return TTS_LANG_FOLLOW; // 缺省=跟随显示。
  if (s.toLowerCase() === TTS_LANG_FOLLOW) return TTS_LANG_FOLLOW;
  return normalizeLangCode(s);
}

/**
 * 算「实际生效的合成语种」(纯,§4.1):
 * - ttsLang 为 follow / 空 → = displayLang(跟随显示);
 * - 否则 → = ttsLang(已规整的具体码或 ''=自动)。
 * 返回空串表示自动(TTS 不下发 language)。
 */
export function resolveEffectiveTtsLang(displayLang: string, ttsLang: string): string {
  const dl = normalizeLangCode(displayLang);
  const tl = normalizeTtsLang(ttsLang);
  if (tl === TTS_LANG_FOLLOW) return dl;
  return tl;
}

/** 朗读合成计划(纯解析结果):喂 TTS 的语种 + 是否需先翻译(displayText→spokenText)。 */
export interface SpokenPlan {
  /**
   * 喂 TTS 的目标语种(effectiveTtsLang);空串=自动(TTS opts 不下发 language)。
   * 渲染/合成时:空 → opts.language 省略;非空 → opts.language=该码。
   */
  readonly ttsLang: string;
  /**
   * 是否需要走一次轻量 LLM 翻译把显示文字译成合成语种:
   * - effectiveTtsLang 为空/自动 → false(直接合成显示 reply,零额外开销);
   * - effectiveTtsLang == displayLang → false(同语种,直接合成);
   * - effectiveTtsLang 具体且 ≠ displayLang(含 displayLang 为空时)→ true(走翻译通道)。
   */
  readonly needsTranslation: boolean;
}

/**
 * 算朗读合成计划(纯,§4.1 显示/合成解耦核心;golden 钉死跟随/相同/不同/自动各分支):
 * 入参为面板里的 displayLang(可空=自动)与 ttsLang(可 follow/空/具体)。
 */
export function resolveSpokenPlan(displayLang: string, ttsLang: string): SpokenPlan {
  const dl = normalizeLangCode(displayLang);
  const effective = resolveEffectiveTtsLang(displayLang, ttsLang);
  // 自动(空)→ 直接合成显示 reply,不发 language、不翻译。
  if (effective.length === 0) return { ttsLang: '', needsTranslation: false };
  // 与显示语种相同 → 直接合成显示 reply。
  if (effective === dl) return { ttsLang: effective, needsTranslation: false };
  // 具体且与显示不同(含 displayLang 为空) → 走翻译通道。
  return { ttsLang: effective, needsTranslation: true };
}

/** ISO 语种码 → 翻译提示用的中文语言名(单一真相源;未知码回落原码)。 */
const LANG_NAME_ZH: Readonly<Record<string, string>> = {
  zh: '中文',
  en: '英文',
  ja: '日文',
  ko: '韩文',
  de: '德文',
  fr: '法文',
  es: '西班牙文',
  ru: '俄文',
  it: '意大利文',
  pt: '葡萄牙文',
};

/** 取语种码的中文名(纯;未知 → 原码)。 */
export function langNameZh(code: string): string {
  return LANG_NAME_ZH[code.trim().toLowerCase()] ?? code;
}

/**
 * 组装「轻量翻译」的 system 提示(纯,§4.1 翻译通道):把显示文字按目标语种自然口语翻译,
 * 保留语气与人格,**只输出译文**。具体语种名用 {@link langNameZh}。
 */
export function buildTranslateSystemPrompt(targetLang: string): string {
  const name = langNameZh(targetLang);
  return (
    `把下面这句话**按${name}的语言习惯自然口语地翻译**,保留说话人的语气与人格,` +
    `**只输出译文**,不加任何解释、不加引号、不加前后缀。`
  );
}

/** translateForSpeech 注入面(便于 headless 单测;不依赖真 LLM)。 */
export interface TranslatePort {
  /** 真翻译:吃 system + user(显示文字)→ resolve 译文;失败可抛(调用方降级)。 */
  readonly complete: (system: string, user: string) => Promise<string>;
}

/**
 * 把显示文字翻译成合成语种(纯编排,§4.1;翻译失败 → 降级返回原文,有声优先、不崩):
 * - 组装翻译 system → port.complete;trim 非空 → 返回译文;
 * - 抛错 / 译文空白 → 返回原 displayText(降级直接合成显示 reply)。
 */
export async function translateForSpeech(
  port: TranslatePort,
  displayText: string,
  targetLang: string,
): Promise<string> {
  try {
    const out = (await port.complete(buildTranslateSystemPrompt(targetLang), displayText)).trim();
    return out.length > 0 ? out : displayText;
  } catch {
    return displayText; // 降级:有声优先,直接合成显示 reply。
  }
}

// ───────────────────────────── 朗读:合成块编排(纯) ─────────────────────────────

/** 一块合成 PCM(主→渲染):Int16 样本 + 采样率;渲染层 Web Audio 排队无缝播放。 */
export interface TtsAudioChunk {
  /** Int16 PCM 样本(mono);经 IPC 结构化克隆透传。 */
  readonly pcm: Int16Array;
  /** 采样率(Hz;TTS 出常为 24000)。 */
  readonly sampleRate: number;
}

/** runSpeakReply 注入面(headless 单测:不依赖真 TTS / 分句器 / electron)。 */
export interface SpeakReplyPort {
  /** 把整段回复分句(传 SentenceSplitter 风格:push+flush;此处简化为一次性分句函数)。 */
  readonly splitSentences: (text: string) => readonly string[];
  /** 逐句合成:吃句子 + 目标语种(空=不下发)→ 异步产出 Int16 PCM 块流;signal 可取消。 */
  readonly synthesize: (
    sentence: string,
    ttsLang: string,
    signal: AbortSignal,
  ) => AsyncIterable<TtsAudioChunk>;
  /** 翻译通道(needsTranslation 时调;返回 spokenText)。 */
  readonly translate: (displayText: string, targetLang: string) => Promise<string>;
  /** 向渲染层推一块音频(主进程传 emit(IPC.ttsAudio, chunk))。 */
  readonly emitAudio: (chunk: TtsAudioChunk) => void;
}

/**
 * 编排「朗读一条回复」(纯,可单测,§3.2,§4.1):
 * - 据 {@link resolveSpokenPlan} 算合成语种 + 是否翻译;needsTranslation → 先 translate 得 spokenText;
 * - spokenText 分句 → 逐句 synthesize → 每块经 emitAudio 推渲染层;
 * - 全程尊重 signal:已 abort 即提前返回(被打断/回合切换);任何合成错误吞掉(有声尽力、不崩)。
 * 返回实际朗读用的 spokenText(便于追溯/单测:解耦后它可能 ≠ displayText)。
 */
export async function runSpeakReply(
  port: SpeakReplyPort,
  displayText: string,
  displayLang: string,
  ttsLang: string,
  signal: AbortSignal,
): Promise<string> {
  const plan = resolveSpokenPlan(displayLang, ttsLang);
  const spokenText = plan.needsTranslation
    ? await port.translate(displayText, plan.ttsLang)
    : displayText;
  if (signal.aborted) return spokenText; // 翻译期间被打断 → 不再合成。
  const sentences = port.splitSentences(spokenText);
  for (const sentence of sentences) {
    if (signal.aborted) break;
    if (sentence.trim().length === 0) continue;
    try {
      for await (const chunk of port.synthesize(sentence, plan.ttsLang, signal)) {
        if (signal.aborted) break;
        port.emitAudio(chunk);
      }
    } catch {
      // 单句合成失败 → 跳过该句,继续后续(有声尽力,不崩);被 abort 抛出也在此吞掉。
      if (signal.aborted) break;
    }
  }
  return spokenText;
}

// ───────────────────────────── 朗读:同会话流式喂(纯,§3.2) ─────────────────────────────

/**
 * 一条「同会话流式喂文本」会话的最小注入面(对应 providers 的 TtsStreamSession;此处解耦不直依赖)。
 * push 逐句喂、finish 正常收尾、abort 直接丢弃在途音频;chunks 产 TtsAudioChunk。
 */
export interface SpeakStreamSession {
  push(text: string): void;
  finish(): void;
  abort(): void;
  readonly chunks: AsyncIterable<TtsAudioChunk>;
}

/** 流式句切器最小面(对应 runtime SentenceSplitter:push 凑句、flush 吐残余)。 */
export interface SentenceFeed {
  /** 喂一段 token 文本,返回本次新凑成的整句(0..n)。 */
  push(text: string): readonly string[];
  /** 流结束时吐最后残余(无则 null)。 */
  flush(): string | null;
}

/** runStreamSpeakReply 注入面(headless 单测:不依赖真 TTS/electron)。 */
export interface StreamSpeakReplyPort {
  /** 句切器工厂(每次朗读新建一个,避免跨回合残留)。 */
  readonly newSplitter: () => SentenceFeed;
  /** 开一条同会话流式会话(吃合成语种,空=不下发)。仅 cosyvoice 等支持引擎提供;上层据此回落整段。 */
  readonly openSession: (ttsLang: string) => SpeakStreamSession;
  /** 翻译通道(needsTranslation 时调;返回 spokenText)。 */
  readonly translate: (displayText: string, targetLang: string) => Promise<string>;
  /** 向渲染层推一块音频。 */
  readonly emitAudio: (chunk: TtsAudioChunk) => void;
}

/**
 * 编排「朗读一条整段回复 —— 同会话流式喂」(纯,§3.2 流式优先;**第一步**:整段后句切流式喂)。
 *
 * 与 {@link runSpeakReply}(整段一次合成 / 逐句独立 session)的区别:**一条会话** push 多句 + finish,
 * 块边合边出 → 首句即出声、且复刻音色不漂移(同 session)。需翻译时先 translate 得整段 spokenText 再句切喂。
 *
 * ⚠️ 首音 ≈ 整段生成时间(speakReply 在整段 reply 后跑);真正解 R7 的「边生成边喂」见
 * {@link makeTokenStreamReadout}(同语种挂 onToken)。
 *
 * 收尾:正常 finish;signal abort → session.abort()(丢弃在途、不发 finish-task);任何错误吞掉(有声尽力)。
 * 返回实际朗读用的 spokenText(追溯/单测)。
 */
export async function runStreamSpeakReply(
  port: StreamSpeakReplyPort,
  displayText: string,
  displayLang: string,
  ttsLang: string,
  signal: AbortSignal,
): Promise<string> {
  const plan = resolveSpokenPlan(displayLang, ttsLang);
  const spokenText = plan.needsTranslation
    ? await port.translate(displayText, plan.ttsLang)
    : displayText;
  if (signal.aborted || spokenText.trim().length === 0) return spokenText;

  const session = port.openSession(plan.ttsLang);
  let onAbort: (() => void) | undefined;
  try {
    // 推送侧:句切整段 → 逐句 push;残余 flush;finish 收尾。
    const splitter = port.newSplitter();
    for (const sentence of splitter.push(spokenText)) {
      if (signal.aborted) break;
      if (sentence.trim().length > 0) session.push(sentence);
    }
    const tail = splitter.flush();
    if (tail !== null && !signal.aborted) session.push(tail);
    session.finish();

    // abort 在消费期间也要真停:挂 signal → session.abort()。
    onAbort = (): void => session.abort();
    if (signal.aborted) session.abort();
    else signal.addEventListener('abort', onAbort, { once: true });

    // 消费侧:边合边出。
    for await (const chunk of session.chunks) {
      if (signal.aborted) break;
      port.emitAudio(chunk);
    }
  } catch {
    // 同会话流式抛错(task-failed / WS):吞掉,由调用方决定是否降级整段(有声尽力,不崩)。
    session.abort();
    throw new Error('stream-readout-failed'); // 让上层 catch 据此回落整段一次合成。
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
  return spokenText;
}

/** makeTokenStreamReadout 注入面(同语种边生成边喂;翻译场景不走此路,回落整段后流式)。 */
export interface TokenStreamReadoutPort {
  readonly newSplitter: () => SentenceFeed;
  readonly openSession: (ttsLang: string) => SpeakStreamSession;
  readonly emitAudio: (chunk: TtsAudioChunk) => void;
}

/** 边生成边喂的句柄:把 onToken 接进回合流,done() 在回合结束冲刷残余 + finish,返回消费完成的 Promise。 */
export interface TokenStreamReadout {
  /** 接进 `convo.send` 的 onToken:每个 token 经句切,凑成整句即 push 进会话。 */
  readonly onToken: (token: string) => void;
  /** 回合结束(整段 reply 到齐):flush 残余 + finish 会话。 */
  readonly done: () => void;
  /** 音频消费完成(正常结束/出错/abort)的 Promise;上层可 await 以便降级判定。 */
  readonly consumed: Promise<void>;
}

/**
 * 「边生成边喂同会话」朗读(纯,§3.2 真解 R7 的**第二步**):
 * 把回复的 onToken 流经 {@link SentenceFeed} 句切,出一句即 push 进同一条流式会话,首句到齐即出声、
 * 远早于整段。仅**同语种(无翻译)**走此路;翻译场景翻译需整段,回落 {@link runStreamSpeakReply}。
 *
 * 立即开会话并启动 chunks 消费(后台 for-await → emitAudio);abort 经 signal → session.abort()。
 * 任何错误经 `consumed` 抛出(reject),上层据此决定降级。
 */
export function makeTokenStreamReadout(
  port: TokenStreamReadoutPort,
  ttsLang: string,
  signal: AbortSignal,
): TokenStreamReadout {
  const splitter = port.newSplitter();
  const session = port.openSession(ttsLang);
  const onAbort = (): void => session.abort();
  if (signal.aborted) session.abort();
  else signal.addEventListener('abort', onAbort, { once: true });

  const consumed = (async (): Promise<void> => {
    try {
      for await (const chunk of session.chunks) {
        if (signal.aborted) break;
        port.emitAudio(chunk);
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  })();

  return {
    onToken: (token: string): void => {
      if (signal.aborted) return;
      for (const sentence of splitter.push(token)) {
        if (sentence.trim().length > 0) session.push(sentence);
      }
    },
    done: (): void => {
      if (signal.aborted) return;
      const tail = splitter.flush();
      if (tail !== null && tail.trim().length > 0) session.push(tail);
      session.finish();
    },
    consumed,
  };
}

/**
 * 解析「朗读是否可用」(纯):TTS 配置 kind 为 'fake' 视为无真合成 → 不可用(朗读开关禁用、UI 提示)。
 * 其余 kind(qwen-tts/openai-compat/kokoro/gpt-sovits/edge)视为可用(真机有 key/服务时合成)。
 */
export function isSpeakAvailable(ttsKind: string): boolean {
  return ttsKind !== 'fake';
}

/** 朗读不可用的标准中文提示(单一真相源)。 */
export const SPEAK_UNAVAILABLE_REASON =
  '朗读需要可用的语音合成(TTS);请在项目根 .env.local 配置 CHAT_A_TTS_KIND/MODEL/KEY(如 qwen-tts)后重启。';
