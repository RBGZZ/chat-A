/**
 * cli 语音模式入口(R2):把 {@link AudioDevice}(真/Fake)→ InProcessAudioTransport → VoiceLoop 接起来。
 *
 * 装配链(承任务交付 #4):
 *   - 设备:`CHAT_A_AUDIO_DEVICE=node` 用 {@link NodeAudioDevice}(动态加载原生库,装不上→明确报错并回落);
 *           缺省/`fake` 用 {@link FakeAudioDevice}(无原生依赖,可在任何环境跑;采集空,主要供冒烟)。
 *   - STT/TTS:`createStt(loadSttConfig(env))` / `createTts(loadTtsConfig(env))`(缺省 Fake)。
 *   - VAD/TurnDetector:按 `CHAT_A_VAD` 选真/桩——`silero`(/`real`/`sherpa`)注入真
 *     {@link SileroVadDetector} + {@link SmartTurnEouModel}(经 sherpa session 工厂动态加载真推理端口);
 *     缺省/其它/`stub` 用确定性桩。真路径加载/构造失败 → **打印明确中文提示并回落桩**
 *     (沿用真设备回落范式,绝不崩);真模型接入后**零改 VoiceLoop**(实现同接口即换)。
 *   - send 注入 `conversation.send.bind(conversation)`(零改 Conversation,§VoiceLoop 设计)。
 *
 * 文字模式默认不变;`--voice` 或 `CHAT_A_VOICE=1` 才进本模式(见 cli.ts 分发)。
 */
import { stdout, env as procEnv } from 'node:process';
import { createStt, loadSttConfig, createTts, loadTtsConfig } from '@chat-a/providers';
import type { MemoryStore } from '@chat-a/memory';
import {
  StubVadDetector,
  TurnDetector,
  StubEouModel,
  SileroVadDetector,
  SmartTurnEouModel,
  type VadDetector,
} from '@chat-a/voice-detect';
import type { LightVoiceBus } from '@chat-a/runtime';
import type { AudioDevice } from './audio/audio-device';
import { FakeAudioDevice } from './audio/fake-audio-device';
import { NodeAudioDevice } from './audio/node-audio-device';
import { createSherpaVadSession, createSherpaEouSession } from './audio/sherpa-vad-session';
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
  /** 设备/STT/TTS/VAD/EOU 的可读标识(状态行用;vad/eou 反映回落后的实际实现)。 */
  readonly info: {
    readonly device: string;
    readonly stt: string;
    readonly tts: string;
    readonly vad: string;
    readonly eou: string;
  };
  stop(): void;
}

/** 端点检测装配结果:VAD + TurnDetector + 实际生效的实现标识(真/桩,供状态行)。 */
interface Detectors {
  readonly vad: VadDetector;
  readonly turnDetector: TurnDetector;
  /** 实际生效的 VAD 实现标识(回落后)。 */
  readonly vadKind: string;
  /** 实际生效的 EOU 实现标识(回落后)。 */
  readonly eouKind: string;
}

/** 桩端点检测:与历史行为逐字一致的「恒有声 + 高 EOU」占位序列。 */
function createStubDetectors(): Detectors {
  return {
    vad: new StubVadDetector([0.9]),
    turnDetector: new TurnDetector(new StubEouModel([0.9])),
    vadKind: 'stub',
    eouKind: 'stub',
  };
}

/**
 * 按 env 选端点检测实现(承本切片目标):
 *   - `CHAT_A_VAD=silero`(/`real`/`sherpa`)→ 真 {@link SileroVadDetector} + {@link SmartTurnEouModel}
 *     (经 sherpa session 工厂动态加载真推理端口;模块名可经 `CHAT_A_SHERPA_MODULE` 覆盖)。
 *   - 缺省/空/其它/`stub` → 确定性桩(CI/冒烟默认,文字模式与现状逐字不变)。
 * 真路径动态加载/构造**任一步抛错** → 打印明确中文提示并**回落桩**,绝不崩(§3.2,沿用真设备回落范式)。
 */
async function createDetectors(env: NodeJS.ProcessEnv): Promise<Detectors> {
  const mode = (env['CHAT_A_VAD'] ?? 'stub').toLowerCase();
  const wantReal = mode === 'silero' || mode === 'real' || mode === 'sherpa';
  if (!wantReal) return createStubDetectors();

  try {
    // 真路径:动态加载 sherpa 同步推理端口,注入既有真适配器(零改 VoiceLoop)。
    const vadSession = await createSherpaVadSession({ env });
    const eouSession = await createSherpaEouSession({ env });
    const vad = new SileroVadDetector({ session: vadSession });
    const turnDetector = new TurnDetector(new SmartTurnEouModel({ session: eouSession }));
    return { vad, turnDetector, vadKind: 'silero', eouKind: 'silero' };
  } catch (err) {
    stdout.write(
      `[语音] 真 VAD/EOU(sherpa)初始化失败,已回落确定性桩:${err instanceof Error ? err.message : String(err)}\n`,
    );
    return createStubDetectors();
  }
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

  // VAD / TurnDetector:按 CHAT_A_VAD 选真/桩;真路径加载/构造失败回落桩(明确提示,绝不崩)。
  const detectors = await createDetectors(env);

  const handle = runVoiceLoop({
    device,
    bus: deps.bus,
    loopDeps: {
      vad: detectors.vad,
      turnDetector: detectors.turnDetector,
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
      vad: detectors.vadKind,
      eou: detectors.eouKind,
    },
    stop: () => handle.stop(),
  };
}
