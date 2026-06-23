/**
 * cli 语音模式入口(R2):把 {@link AudioDevice}(真/Fake)→ InProcessAudioTransport → VoiceLoop 接起来。
 *
 * 装配链(承任务交付 #4):
 *   - 设备:`CHAT_A_AUDIO_DEVICE=node` 用 {@link NodeAudioDevice}(动态加载原生库,装不上→明确报错并回落);
 *           缺省/`fake` 用 {@link FakeAudioDevice}(无原生依赖,可在任何环境跑;采集空,主要供冒烟)。
 *   - STT/TTS:`createStt(loadSttConfig(env))` / `createTts(loadTtsConfig(env))`(缺省 Fake)。
 *   - VAD/TurnDetector:voice-detect 目前仅有确定性桩(真 Silero / Smart-Turn v3 ONNX 是后续切片);
 *     此处用桩占位以便闭环装配 + typecheck,真模型接入后**零改 VoiceLoop**(实现同接口即换)。
 *   - send 注入 `conversation.send.bind(conversation)`(零改 Conversation,§VoiceLoop 设计)。
 *
 * 文字模式默认不变;`--voice` 或 `CHAT_A_VOICE=1` 才进本模式(见 cli.ts 分发)。
 */
import { stdout, env as procEnv } from 'node:process';
import { createStt, loadSttConfig, createTts, loadTtsConfig } from '@chat-a/providers';
import type { MemoryStore } from '@chat-a/memory';
import { StubVadDetector, TurnDetector, StubEouModel } from '@chat-a/voice-detect';
import type { LightVoiceBus } from '@chat-a/runtime';
import type { AudioDevice } from './audio/audio-device';
import { FakeAudioDevice } from './audio/fake-audio-device';
import { NodeAudioDevice } from './audio/node-audio-device';
import { runVoiceLoop } from './audio/voice-runner';

/** 语音模式所需的、由 cli.ts 已装配好的依赖(复用文字链路的 convo/memory/bus/session)。 */
export interface VoiceModeDeps {
  /** 想:吃用户文本 + onToken,resolve 完整回复(传 conversation.send.bind(conversation))。 */
  readonly send: (text: string, onToken: (t: string) => void) => Promise<string>;
  /** 半句写回只用到 appendMessage(VoiceLoop 最小面)。 */
  readonly memory: Pick<MemoryStore, 'appendMessage'>;
  /** 复用 cli 的总线(与文字链路共享 correlation/历史)。 */
  readonly bus: LightVoiceBus;
  /** 贯穿本会话的 sessionId(与 Conversation 一致,半句写回归属正确)。 */
  readonly sessionId: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** 语音模式运行句柄:停 = 收尾(停采集/loop/设备)。 */
export interface VoiceModeHandle {
  /** 设备/STT/TTS 的可读标识(状态行用)。 */
  readonly info: { readonly device: string; readonly stt: string; readonly tts: string };
  stop(): void;
}

/**
 * 按 env 选设备:`node` → NodeAudioDevice(先 init 动态加载原生库;失败抛错由调用方决定是否回落);
 * 其它 → FakeAudioDevice。返回设备 + 是否真实设备(供状态行/回落判断)。
 */
export async function createAudioDevice(
  env: NodeJS.ProcessEnv,
): Promise<{ device: AudioDevice; real: boolean }> {
  const mode = (env['CHAT_A_AUDIO_DEVICE'] ?? 'fake').toLowerCase();
  if (mode === 'node' || mode === 'naudiodon' || mode === 'real') {
    const nativeModule = env['CHAT_A_AUDIO_MODULE'];
    const device = new NodeAudioDevice({
      ...(nativeModule ? { nativeModule } : {}),
    });
    await device.init(); // 装不上 → 抛明确报错(调用方 catch 后回落 Fake)
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

  // STT / TTS 经配置工厂(缺省 Fake)。
  const sttCfg = loadSttConfig(env);
  const ttsCfg = loadTtsConfig(env);
  const stt = createStt(sttCfg);
  const tts = createTts(ttsCfg);

  // 设备:真设备装不上则回落 Fake(明确提示)。
  let device: AudioDevice;
  let real: boolean;
  try {
    const made = await createAudioDevice(env);
    device = made.device;
    real = made.real;
  } catch (err) {
    stdout.write(`[语音] 真实音频设备初始化失败,已回落 Fake 设备:${err instanceof Error ? err.message : String(err)}\n`);
    device = new FakeAudioDevice();
    real = false;
  }

  // VAD / TurnDetector:目前仅桩(真 Silero / Smart-Turn v3 是后续切片)。
  // 桩用「恒有声 + 高 EOU 概率」的占位序列:真设备接入后须换真模型,此处仅保证装配/类型闭环。
  const vad = new StubVadDetector([0.9]);
  const turnDetector = new TurnDetector(new StubEouModel([0.9]));

  const handle = runVoiceLoop({
    device,
    bus: deps.bus,
    loopDeps: {
      vad,
      turnDetector,
      stt,
      tts,
      send: deps.send,
      memory: deps.memory,
      sessionId: deps.sessionId,
    },
  });

  return {
    info: {
      device: `${device.id}${real ? '' : ' (占位/无真采集)'}`,
      stt: sttCfg.kind,
      tts: ttsCfg.kind,
    },
    stop: () => handle.stop(),
  };
}
