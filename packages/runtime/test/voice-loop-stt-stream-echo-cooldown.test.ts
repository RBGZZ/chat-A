/**
 * stt-stream 推流分支 EchoGuard 冷却窗抑制（真机回归）：
 * 小雪说完切回 listening 的瞬间,扬声器仍在播的低能量混响尾被立刻 pushAudio 灌进云端 ASR
 * → 转写成「用户输入」→ 小雪自言自语(机内麦+扬声器无 AEC 时尤其明显)。
 *
 * 批式路 listening 分支早有 Tier2 冷却窗抑制(见 voice-loop-echo-guard.test.ts),
 * 但 stt-stream 持续推流分支漏了这条——本测试钉死该分支也复用 `#echoGuardSuppresses`:
 *   - cooldown 窗内低能量混响尾 → **不 pushAudio**(抑制该帧推流);
 *   - cooldown 窗内高能量真插话 → **仍 pushAudio**(不误抑制真用户);
 *   - cooldown 窗外低能量帧 → 正常 pushAudio(灵敏度回常态);
 *   - 未注入 EchoGuard → 逐字现状(低能量也照推,向后兼容)。
 *
 * 全程确定性 Stub VAD + 显式帧能量 + 帧时间戳驱动冷却窗,不触网。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  InProcessAudioTransport,
  makeDataFrame,
  SAMPLE_RATE_HZ,
  CHANNELS,
  type AudioFrame,
  type PcmFrame,
} from '@chat-a/protocol';
import { StubVadDetector, TurnDetector, StubEouModel, DEFAULT_FILLER_DENYLIST, type EchoGuardConfig } from '@chat-a/voice-detect';
import { FakeStt, FakeTts } from '@chat-a/providers';
import { LightVoiceBus } from '../src/bus';
import { VoiceLoop } from '../src/voice-loop';
import type {
  VoiceLoopDeps,
  StreamingSttPort,
  StreamingSttHandlers,
  StreamingSttSession,
} from '../src/voice-loop';

/** Int16 满量程(与 VoiceLoop 内部归一化分母一致),便于按目标归一化能量反推样本幅度。 */
const FULL_SCALE = 32_768;

/** 构造上行帧;`energy01`(0~1)= 归一化 RMS 能量(常量幅度 a 时 RMS=a → a=energy01*FULL_SCALE)。 */
function micFrame(timestampMs: number, energy01 = 0): AudioFrame {
  const amp = Math.round(energy01 * FULL_SCALE);
  const samples = new Int16Array(160); // 10ms @16k
  if (amp > 0) samples.fill(amp);
  const pcm: PcmFrame = { samples, sampleRate: SAMPLE_RATE_HZ, channels: CHANNELS, timestampMs };
  return makeDataFrame('audio:input', {
    audio: pcm,
    format: { sampleRate: SAMPLE_RATE_HZ, channels: CHANNELS, sampleFormat: 's16le' },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** 流式端口 fake;`pushAudio` 是可断言的 spy。 */
function fakeStreamPort(): {
  port: StreamingSttPort;
  handlers(): StreamingSttHandlers | null;
  pushAudio: ReturnType<typeof vi.fn>;
} {
  let handlers: StreamingSttHandlers | null = null;
  const pushAudio = vi.fn();
  const port: StreamingSttPort = {
    openSession(h): StreamingSttSession {
      handlers = h;
      return { pushAudio, close: () => {} };
    },
  };
  return { port, handlers: () => handlers, pushAudio };
}

/** 双层阈值显式的基础 EchoGuard 配置(cooldown 高阈 0.03,base 常态阈 0,窗 1500ms)。 */
function guard(over: Partial<EchoGuardConfig> = {}): EchoGuardConfig {
  return {
    enabled: true,
    confirmFrames: 1,
    minSpeechProb: 0.5,
    minEnergy: 0,
    cooldownMs: 1500,
    baseRmsThreshold: 0,
    cooldownRmsThreshold: 0.03,
    ...over,
  };
}

function makeStreamDeps(over: Partial<VoiceLoopDeps> = {}): {
  deps: VoiceLoopDeps;
  transport: InProcessAudioTransport;
} {
  const transport = new InProcessAudioTransport();
  const bus = new LightVoiceBus();
  const deps: VoiceLoopDeps = {
    transport,
    vad: new StubVadDetector([0, 0, 0, 0, 0, 0, 0, 0]),
    turnDetector: new TurnDetector(new StubEouModel([0.9])),
    stt: new FakeStt({ script: [{ text: '（未用到）', isFinal: true }] }),
    tts: new FakeTts({ samplesPerChar: 4 }),
    send: async (_text, onToken) => {
      onToken('你好呀。');
      return '你好呀。';
    },
    memory: { appendMessage: vi.fn() },
    bus,
    sessionId: 's-echo-cd',
    clock: () => 1000,
    voicePath: 'stt-stream',
    ...over,
  };
  return { deps, transport };
}

/**
 * 驱动一次完整 stt-stream 回合:listening 段(高能量帧,确立 #lastFrameAtMs)→ onFinal 起回合
 * → thinking → speaking(TTS)→ turn:end 回 listening(此刻以最近帧时刻开 EchoGuard 冷却窗)。
 * 末帧时刻 = 30ms → 冷却窗到 30+1500=1530ms。
 */
async function runOneTurn(transport: InProcessAudioTransport, h: StreamingSttHandlers): Promise<void> {
  h.onSpeechStarted();
  transport.sendAudio(micFrame(0, 0.5));
  transport.sendAudio(micFrame(10, 0.5));
  transport.sendAudio(micFrame(20, 0.5));
  transport.sendAudio(micFrame(30, 0.5));
  await flush();
  h.onSpeechStopped();
  h.onFinal('你好小雪'); // 内容词,非黑名单 → 放行起回合
  await flush();
}

describe('VoiceLoop stt-stream 推流分支 EchoGuard 冷却窗抑制(防小雪尾音回灌自言自语)', () => {
  it('冷却窗内低能量混响尾→不 pushAudio;窗内高能量真插话→仍 pushAudio;窗外低能量→正常 pushAudio', async () => {
    const fake = fakeStreamPort();
    const { deps, transport } = makeStreamDeps({
      streamingStt: fake.port,
      fillerDenylist: DEFAULT_FILLER_DENYLIST,
      echoGuard: guard(),
    });
    const loop = new VoiceLoop(deps);
    loop.start();

    await runOneTurn(transport, fake.handlers()!);
    expect(loop.state).toBe('listening'); // 回合走完,冷却窗已开(末帧 30ms → 到 1530ms)

    // ── 阶段1:冷却窗内(<1530ms)低能量混响尾(0.01 < 0.03)→ 应被抑制,不 pushAudio ──
    fake.pushAudio.mockClear();
    transport.sendAudio(micFrame(100, 0.01));
    transport.sendAudio(micFrame(110, 0.01));
    await flush();
    expect(fake.pushAudio).not.toHaveBeenCalled(); // 尾音不灌进云端 ASR
    expect(loop.state).toBe('listening');

    // ── 阶段2:冷却窗内高能量真插话(0.5 ≥ 0.03)→ 不误抑制,仍 pushAudio ──
    fake.pushAudio.mockClear();
    transport.sendAudio(micFrame(200, 0.5));
    transport.sendAudio(micFrame(210, 0.5));
    await flush();
    expect(fake.pushAudio).toHaveBeenCalledTimes(2); // 真用户被推流(不漏)

    // ── 阶段3:冷却窗外(>1530ms)低能量帧 → 灵敏度回常态,正常 pushAudio ──
    fake.pushAudio.mockClear();
    transport.sendAudio(micFrame(2000, 0.01));
    transport.sendAudio(micFrame(2010, 0.01));
    await flush();
    expect(fake.pushAudio).toHaveBeenCalledTimes(2); // 窗外照推
  });

  it('未注入 EchoGuard → 冷却窗内低能量帧仍 pushAudio(逐字现状/向后兼容)', async () => {
    const fake = fakeStreamPort();
    const { deps, transport } = makeStreamDeps({
      streamingStt: fake.port,
      fillerDenylist: DEFAULT_FILLER_DENYLIST,
      // 不注入 echoGuard → 抑制门为 no-op
    });
    const loop = new VoiceLoop(deps);
    loop.start();

    await runOneTurn(transport, fake.handlers()!);
    expect(loop.state).toBe('listening');

    fake.pushAudio.mockClear();
    transport.sendAudio(micFrame(100, 0.01));
    transport.sendAudio(micFrame(110, 0.01));
    await flush();
    expect(fake.pushAudio).toHaveBeenCalledTimes(2); // 未注入 → 不抑制,逐字推流
  });
});
