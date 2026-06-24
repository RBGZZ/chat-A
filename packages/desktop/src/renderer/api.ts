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

/** preload 经 `window.xiaoxue` 暴露的安全 API(与 preload.ts 的 XiaoxueApi 形态一致)。 */
export interface XiaoxueApi {
  send(text: string): Promise<void>;
  voiceStart(): Promise<void>;
  voiceStop(): Promise<void>;
  reset(): Promise<void>;
  getInfo(): Promise<AppInfo>;
  onToken(cb: (token: string) => void): () => void;
  onReply(cb: (reply: string) => void): () => void;
  onError(cb: (err: { text: string; detail: string }) => void): () => void;
  onState(cb: (state: UiState) => void): () => void;
  onMood(cb: (mood: MoodSummary) => void): () => void;
  onTranscript(cb: (text: string) => void): () => void;
  onVoiceStatus(cb: (status: VoiceStatus) => void): () => void;
}
