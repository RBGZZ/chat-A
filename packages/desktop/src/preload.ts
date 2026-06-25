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
  type VoiceCloneProgress,
  // —— 代理B:主动消息类型 ——
  type ProactiveMessage,
  type PersonaForm, // 代理C
  type MemoryItem, // 代理D
  type LangForm, // 三语种 + 朗读
  type TtsAudioChunk, // 朗读 PCM 块
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
  /** 设置面板:写回语音输出语种(CHAT_A_VOICE_OUTPUT_LANG);resolve 规整后的最终值。 */
  setOutputLang(lang: string): Promise<string>;
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
  onCloneProgress(cb: (progress: VoiceCloneProgress) => void): () => void;
  // —— 代理B:订阅小雪主动消息(自发气泡);返回退订函数。
  onProactive(cb: (msg: ProactiveMessage) => void): () => void;
  // —— 人格自定义(代理C) ——
  /** 读当前可编辑人格(名字 + 三档),供人格面板初值。 */
  getPersona(): Promise<PersonaForm>;
  /** 应用人格修改(运行时生效 + 持久化);resolve 规整后的最终人格。 */
  updatePersona(form: PersonaForm): Promise<PersonaForm>;
  // —— 记忆查看(代理D)——
  /** 只读列出最近 N 条记忆(陪伴工具记忆面板;主进程绝不触发写/巩固)。 */
  listMemories(limit?: number): Promise<readonly MemoryItem[]>;
  // —— 三语种 + 朗读(本批次)——
  /** 读当前三语种 + 朗读开关 + 朗读是否可用(语言面板初值)。 */
  getLang(): Promise<LangForm>;
  /** 应用语种/朗读设置(运行时生效 + 持久化);resolve 规整后的最终设置。 */
  setLang(form: Partial<LangForm>): Promise<LangForm>;
  /** 订阅一块合成 PCM(Int16@sampleRate);渲染层 Web Audio 排队播放。返回退订函数。 */
  onTtsAudio(cb: (chunk: TtsAudioChunk) => void): () => void;
  /** 订阅停播信号(回合结束/被打断):立即停并清队列。返回退订函数。 */
  onTtsAudioStop(cb: () => void): () => void;
}

const api: XiaoxueApi = {
  send: (text) => ipcRenderer.invoke(IPC.send, text),
  voiceStart: () => ipcRenderer.invoke(IPC.voiceStart),
  voiceStop: () => ipcRenderer.invoke(IPC.voiceStop),
  reset: () => ipcRenderer.invoke(IPC.reset),
  getInfo: () => ipcRenderer.invoke(IPC.getInfo),
  voiceClone: (input) => ipcRenderer.invoke(IPC.voiceClone, input),
  setOutputLang: (lang) => ipcRenderer.invoke(IPC.settingsSetOutputLang, lang),
  onToken: (cb) => subscribe<string>(IPC.token, cb),
  onReply: (cb) => subscribe<string>(IPC.reply, cb),
  onError: (cb) => subscribe<{ text: string; detail: string }>(IPC.error, cb),
  onState: (cb) => subscribe<UiState>(IPC.state, cb),
  onMood: (cb) => subscribe<MoodSummary>(IPC.mood, cb),
  onTranscript: (cb) => subscribe<string>(IPC.transcript, cb),
  onVoiceStatus: (cb) => subscribe<VoiceStatus>(IPC.voiceStatus, cb),
  onCloneResult: (cb) => subscribe<VoiceCloneResult>(IPC.voiceCloneResult, cb),
  onCloneStatus: (cb) => subscribe<VoiceCloneStatus>(IPC.voiceCloneStatus, cb),
  onCloneProgress: (cb) => subscribe<VoiceCloneProgress>(IPC.voiceCloneProgress, cb),
  // —— 代理B:主动消息订阅 ——
  onProactive: (cb) => subscribe<ProactiveMessage>(IPC.proactiveMessage, cb),
  // —— 人格自定义(代理C) ——
  getPersona: () => ipcRenderer.invoke(IPC.personaGet),
  updatePersona: (form) => ipcRenderer.invoke(IPC.personaUpdate, form),
  // —— 记忆查看(代理D)——
  listMemories: (limit) => ipcRenderer.invoke(IPC.memoryList, limit),
  // —— 三语种 + 朗读(本批次)——
  getLang: () => ipcRenderer.invoke(IPC.langGet),
  setLang: (form) => ipcRenderer.invoke(IPC.langSet, form),
  onTtsAudio: (cb) => subscribe<TtsAudioChunk>(IPC.ttsAudio, cb),
  onTtsAudioStop: (cb) => subscribe<void>(IPC.ttsAudioStop, () => cb()),
};

contextBridge.exposeInMainWorld('xiaoxue', api);
