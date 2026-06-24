/**
 * `@chat-a/client` 公开入口:供其它前端(如 Electron 桌面 `@chat-a/desktop`)**复用**装配,
 * 而非重写。只导出**稳定公开面**:共享会话装配、env 加载纯函数、语音模式入口、原生音频设备。
 */
export { assembleApp, loadEnvLocal } from './assembly/app';
export type { AppHandle, AssembleAppOptions, MemoryInfo, LangSettings } from './assembly/app';
export { parseDotEnv, applyDotEnv } from './env-file';
export { startVoiceMode } from './cli-voice';
export type { VoiceModeHandle, VoiceModeDeps } from './cli-voice';
export { NodeAudioDevice } from './audio/node-audio-device';
export type { NodeAudioDeviceOptions } from './audio/node-audio-device';

// —— 主动陪伴(代理B):autonomy 主动消息通道装配 + 真候选源(persona/memory) ——
export {
  assembleProactiveBridge,
  loadProactiveIdleMs,
  DEFAULT_PROACTIVE_IDLE_MS,
  PROACTIVE_IDLE_SIGNAL_KIND,
} from './assembly/proactive-bridge';
export type {
  ProactiveBridgeDeps,
  ProactiveBridgeHandle,
} from './assembly/proactive-bridge';
export { assembleAutonomy, AUTONOMY_RUNNER_SKILL_ID } from './assembly/autonomy';
export type { ProactiveSpeech, AutonomyHandle } from './assembly/autonomy';
export { createCompanionCandidateSource, createPresencePort } from './assembly/memory-autonomy-ports';
export type { CompanionCandidateSourceDeps } from './assembly/memory-autonomy-ports';
