/**
 * 渲染层本地类型(承 §6):**只**声明 UI 需要的 IPC 形态,**不**从主进程侧模块(preload/ipc-contract)
 * import——那些模块依赖 node/electron,在渲染层(DOM lib)typecheck 会引入不相干的 node 类型问题。
 * 这里的形态与 `ipc-contract.ts` 的对应类型保持一致(由 IPC 契约约束;两侧字段同名同义)。
 */
export type UiState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface MoodSummary {
  readonly emotion: string;
  readonly pleasure: number;
  readonly arousal: number;
  readonly dominance: number;
}

export interface VoiceStatus {
  readonly available: boolean;
  readonly reason?: string;
  readonly path?: string;
  readonly device?: string;
}

/** 一键复刻请求载荷(渲染层给本地文件路径,或字节兜底)。 */
export interface VoiceCloneInput {
  readonly path?: string;
  readonly bytes?: Uint8Array;
  readonly mime?: string;
}

/** 复刻结果(主→渲染)。 */
export interface VoiceCloneResult {
  readonly ok: boolean;
  readonly voiceId?: string;
  readonly message: string;
}

/** 复刻区可用性(主→渲染);无 key 时禁用。 */
export interface VoiceCloneStatus {
  readonly available: boolean;
  readonly reason?: string;
}

export interface AppInfo {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly memory: string;
  readonly isFake: boolean;
  readonly warmth: number;
  readonly expressiveness: number;
  readonly volatility: number;
  /** 语音输出语种(CHAT_A_VOICE_OUTPUT_LANG;''=自动);设置面板可写下拉据此回填。 */
  readonly outputLang: string;
}

/** preload 经 `window.xiaoxue` 暴露的安全 API(与 preload.ts 的 XiaoxueApi 形态一致)。 */
export interface XiaoxueApi {
  send(text: string): Promise<void>;
  voiceStart(): Promise<void>;
  voiceStop(): Promise<void>;
  reset(): Promise<void>;
  getInfo(): Promise<AppInfo>;
  voiceClone(input: VoiceCloneInput): Promise<void>;
  /** 设置面板:写回语音输出语种(CHAT_A_VOICE_OUTPUT_LANG);resolve 规整后的最终值。 */
  setOutputLang(lang: string): Promise<string>;
  onToken(cb: (token: string) => void): () => void;
  onReply(cb: (reply: string) => void): () => void;
  onError(cb: (err: { text: string; detail: string }) => void): () => void;
  onState(cb: (state: UiState) => void): () => void;
  onMood(cb: (mood: MoodSummary) => void): () => void;
  onTranscript(cb: (text: string) => void): () => void;
  onVoiceStatus(cb: (status: VoiceStatus) => void): () => void;
  onCloneResult(cb: (result: VoiceCloneResult) => void): () => void;
  onCloneStatus(cb: (status: VoiceCloneStatus) => void): () => void;
  // —— 代理B:订阅小雪主动消息(自发气泡);返回退订函数。
  onProactive(cb: (msg: ProactiveMessage) => void): () => void;
  // —— 人格自定义(代理C) ——
  getPersona(): Promise<PersonaForm>;
  updatePersona(form: PersonaForm): Promise<PersonaForm>;
  // —— 记忆查看(代理D)——
  listMemories(limit?: number): Promise<readonly MemoryItem[]>;
  // —— 三语种 + 朗读(本批次)——
  getLang(): Promise<LangForm>;
  setLang(form: Partial<LangForm>): Promise<LangForm>;
  onTtsAudio(cb: (chunk: TtsAudioChunk) => void): () => void;
  onTtsAudioStop(cb: () => void): () => void;
}

// —— 代理B:主动消息形态(与 ipc-contract 的 ProactiveMessage 同名同义)。
export interface ProactiveMessage {
  readonly text: string;
  readonly signalKind: string;
  readonly preempted: boolean;
}

// —— 人格自定义(代理C) ——
/** 人格面板可编辑表单:名字 + 三档情绪旋钮([0,1]);**不含语种**(语种与人格 dials 正交)。 */
export interface PersonaForm {
  readonly name: string;
  readonly warmth: number;
  readonly expressiveness: number;
  readonly volatility: number;
}

// —— 记忆/设置(代理D) ——

/** 记忆面板展示条目(与 ipc-contract.ts 的 MemoryItem 形态一致;渲染层本地声明,不跨进程模块 import)。 */
export interface MemoryItem {
  readonly text: string;
  readonly kindLabel: string;
  readonly importance: number;
  readonly lastSeenAtMs: number;
  readonly createdAtMs: number;
}

// —— 三语种 + 朗读(本批次;与 ipc-contract 的 LangForm/TtsAudioChunk 形态一致) ——

/** 语言面板表单:三独立语种 + 朗读开关 + 朗读是否可用。 */
export interface LangForm {
  readonly displayLang: string;
  readonly ttsLang: string;
  readonly cloneRefLang: string;
  readonly speak: boolean;
  readonly speakAvailable: boolean;
}

/** 一块合成 PCM(Int16@sampleRate);渲染层 Web Audio 排队播放。 */
export interface TtsAudioChunk {
  readonly pcm: Int16Array;
  readonly sampleRate: number;
}
