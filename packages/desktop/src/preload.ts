/**
 * preload 安全桥(承 desktop-electron-frontend §4 / §3.1):在 `contextIsolation:true`、
 * `nodeIntegration:false` 下,用 `contextBridge.exposeInMainWorld` 只暴露**白名单最小** IPC API,
 * 绝不向渲染层泄漏 `ipcRenderer` 本体或任何 node 能力。channel 名对齐 ipc-contract 的 `IPC` 常量。
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AppInfo,
  type MoodSummary,
  type UiState,
  type VoiceStatus,
  type VoiceCloneInput,
  type VoiceCloneResult,
  type VoiceCloneStatus,
  // —— 代理B:主动消息类型 ——
  type ProactiveMessage,
} from './ipc-contract';

/** 包装一个主→渲染推送订阅,返回退订函数(不泄漏 ipcRenderer / event 对象)。 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

/** 暴露给渲染层的安全 API 形态(渲染层经 `window.xiaoxue` 访问)。 */
export interface XiaoxueApi {
  // 渲染 → 主
  send(text: string): Promise<void>;
  voiceStart(): Promise<void>;
  voiceStop(): Promise<void>;
  reset(): Promise<void>;
  getInfo(): Promise<AppInfo>;
  /** 一键复刻:给本地文件路径(优先)或字节(兜底);主进程调 createVoice + 持久化。 */
  voiceClone(input: VoiceCloneInput): Promise<void>;
  // 主 → 渲染(返回退订函数)
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
}

const api: XiaoxueApi = {
  send: (text) => ipcRenderer.invoke(IPC.send, text),
  voiceStart: () => ipcRenderer.invoke(IPC.voiceStart),
  voiceStop: () => ipcRenderer.invoke(IPC.voiceStop),
  reset: () => ipcRenderer.invoke(IPC.reset),
  getInfo: () => ipcRenderer.invoke(IPC.getInfo),
  voiceClone: (input) => ipcRenderer.invoke(IPC.voiceClone, input),
  onToken: (cb) => subscribe<string>(IPC.token, cb),
  onReply: (cb) => subscribe<string>(IPC.reply, cb),
  onError: (cb) => subscribe<{ text: string; detail: string }>(IPC.error, cb),
  onState: (cb) => subscribe<UiState>(IPC.state, cb),
  onMood: (cb) => subscribe<MoodSummary>(IPC.mood, cb),
  onTranscript: (cb) => subscribe<string>(IPC.transcript, cb),
  onVoiceStatus: (cb) => subscribe<VoiceStatus>(IPC.voiceStatus, cb),
  onCloneResult: (cb) => subscribe<VoiceCloneResult>(IPC.voiceCloneResult, cb),
  onCloneStatus: (cb) => subscribe<VoiceCloneStatus>(IPC.voiceCloneStatus, cb),
  // —— 代理B:主动消息订阅 ——
  onProactive: (cb) => subscribe<ProactiveMessage>(IPC.proactiveMessage, cb),
};

contextBridge.exposeInMainWorld('xiaoxue', api);
