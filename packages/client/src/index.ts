/**
 * `@chat-a/client` 公开入口:供其它前端(如 Electron 桌面 `@chat-a/desktop`)**复用**装配,
 * 而非重写。只导出**稳定公开面**:共享会话装配、env 加载纯函数、语音模式入口、原生音频设备。
 */
export { assembleApp, loadEnvLocal } from './assembly/app';
export type { AppHandle, AssembleAppOptions, MemoryInfo } from './assembly/app';
export { parseDotEnv, applyDotEnv } from './env-file';
export { startVoiceMode } from './cli-voice';
export type { VoiceModeHandle, VoiceModeDeps } from './cli-voice';
export { NodeAudioDevice } from './audio/node-audio-device';
export type { NodeAudioDeviceOptions } from './audio/node-audio-device';
