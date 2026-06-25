/**
 * EchoGuard(自打断防护)集成测试:验证 Tier1 硬门控压回声(agent 说话期低能量回声不打断)、
 * 真人足够响仍打得断、Tier2 冷却窗(低能量混响尾被挡 / 高能量放行)、冷却结束恢复常态、
 * 危机/硬打断豁免。全程确定性 Stub VAD + 显式帧能量,不触网。
 *
 * 关键时间轴:micFrame 的 `timestampMs` 同时驱动 VAD 去抖、endpointing 与 EchoGuard 冷却窗判定,
 * 故各帧时刻须刻意安排(说话→静音→冷却内/外)。回归硬线另见 voice-loop.test.ts(未注入 EchoGuard 即现状)。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  InProcessAudioTransport,
  makeDataFrame,
  SAMPLE_RATE_HZ,
  CHANNELS,
  type AudioFrame,
  type BusEvent,
  type PcmFrame,
} from '@chat-a/protocol';
import { StubVadDetector, TurnDetector, StubEouModel, type EchoGuardConfig } from '@chat-a/voice-detect';
import { FakeStt, FakeTts } from '@chat-a/providers';
import { LightVoiceBus } from '../src/bus';
import { VoiceLoop } from '../src/voice-loop';
import type { VoiceLoopDeps } from '../src/voice-loop';

/** Int16 满量程(与 VoiceLoop 内部归一化分母一致),便于按目标归一化能量反推样本幅度。 */
const FULL_SCALE = 32_768;

/**
 * 构造上行 audio:input 帧;`energy01`(0~1)指定**归一化 RMS 能量**:
 * 全样本取常量幅度 a 时 RMS=a,故 a = energy01*FULL_SCALE。energy01=0 → 全零(静音/无能量)。
 */
function micFrame(timestampMs: number, energy01 = 0): AudioFrame {
  const amp = Math.round(energy01 * FULL_SCALE);
  const samples = new Int16Array(160);
  if (amp > 0) samples.fill(amp);
  const pcm: PcmFrame = { samples, sampleRate: SAMPLE_RATE_HZ, channels: CHANNELS, timestampMs };
  return makeDataFrame('audio:input', {
    audio: pcm,
    format: { sampleRate: SAMPLE_RATE_HZ, channels: CHANNELS, sampleFormat: 's16le' },
  });
}

function fakeMemory(): { appendMessage: ReturnType<typeof vi.fn>; calls: unknown[] } {
  const calls: unknown[] = [];
  const appendMessage = vi.fn((m: unknown) => {
    calls.push(m);
  });
  return { appendMessage, calls };
}

function recorders(transport: InProcessAudioTransport, bus: LightVoiceBus) {
  const down: AudioFrame[] = [];
  transport.onAudio((f) => {
    if (f.type === 'tts:chunk') down.push(f);
  });
  const events: BusEvent[] = [];
  bus.onAny((e) => events.push(e));
  return { down, events };
}

/** 双层阈值显式的基础 EchoGuard 配置(cooldown 高阈 0.03,base 常态阈 0)。 */
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

function makeDeps(over: Partial<VoiceLoopDeps> = {}): {
  deps: VoiceLoopDeps;
  transport: InProcessAudioTransport;
  bus: LightVoiceBus;
} {
  const transport = new InProcessAudioTransport();
  const bus = new LightVoiceBus();
  const deps: VoiceLoopDeps = {
    transport,
    vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.0]),
    turnDetector: new TurnDetector(new StubEouModel([0.9])),
    stt: new FakeStt({ script: [{ text: '你好小雪', isFinal: true }] }),
    tts: new FakeTts({ samplesPerChar: 4 }),
    send: async (_text, onToken) => {
      onToken('你好。');
      onToken('很高兴见到你。');
      return '你好。很高兴见到你。';
    },
    memory: { appendMessage: vi.fn() },
    bus,
    sessionId: 's1',
    clock: () => 1000,
    ...over,
  };
  return { deps, transport, bus };
}

/** 驱动「4 帧有声(均带能量,触 speech_start)→ 3 帧静音(长时跳)→ endpointing 判说完进 thinking」。 */
async function driveSpeechThenSilence(transport: InProcessAudioTransport): Promise<void> {
  transport.sendAudio(micFrame(0, 0.5));
  transport.sendAudio(micFrame(10, 0.5));
  transport.sendAudio(micFrame(20, 0.5));
  transport.sendAudio(micFrame(30, 0.5));
  transport.sendAudio(micFrame(40, 0));
  transport.sendAudio(micFrame(50, 0));
  transport.sendAudio(micFrame(10_050, 0));
  await flush();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

// ───────────────────────────── 测试 ─────────────────────────────

describe('runtime/VoiceLoop EchoGuard 硬门控 + RMS 双层冷却', () => {
  it('Tier1:agent 说话期低能量回声帧被丢 → 不打断、不 clearBuffer、不写半句', async () => {
    const mem = fakeMemory();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // speaking 期回声帧:VAD 高概率(被当有声)但**能量 0.01 < cooldownRms 0.03** → Tier1 挡。
    const { deps, transport, bus } = makeDeps({
      memory: { appendMessage: mem.appendMessage },
      vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9]),
      echoGuard: guard({ confirmFrames: 1, cooldownRmsThreshold: 0.03 }),
      send: async (_t, onToken) => {
        onToken('我正在说一句话。');
        await gate;
        return '我正在说一句话。';
      },
    });
    const { down } = recorders(transport, bus);
    const clearSpy = vi.spyOn(transport, 'clearBuffer');
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveSpeechThenSilence(transport);
    await flush();
    expect(loop.state).toBe('speaking');
    const downBefore = down.length;

    // 连续低能量回声帧(0.01 < 0.03)→ Tier1 全挡
    for (let i = 0; i < 6; i++) transport.sendAudio(micFrame(20_000 + i * 10, 0.01));
    await flush();

    expect(loop.state).toBe('speaking');
    expect(clearSpy).not.toHaveBeenCalled();
    expect(mem.appendMessage).not.toHaveBeenCalled();
    expect(down.length).toBe(downBefore);

    release();
    await flush();
  });

  it('Tier1:真人足够响 + 连续 N 帧仍能打断 → 回 listening + clearBuffer + 半句写回(证打得断)', async () => {
    const mem = fakeMemory();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // speaking 期连续 6 帧高能量(0.5 ≥ 0.03)+ 高概率 → 达 N=3 必打断。
    const { deps, transport, bus } = makeDeps({
      memory: { appendMessage: mem.appendMessage },
      vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9]),
      echoGuard: guard({ confirmFrames: 3, cooldownRmsThreshold: 0.03 }),
      send: async (_t, onToken) => {
        onToken('我正在说一句话。');
        await gate;
        onToken('后面还没说完。');
        return '我正在说一句话。后面还没说完。';
      },
    });
    recorders(transport, bus);
    const clearSpy = vi.spyOn(transport, 'clearBuffer');
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveSpeechThenSilence(transport);
    await flush();
    expect(loop.state).toBe('speaking');

    for (let i = 0; i < 6; i++) transport.sendAudio(micFrame(20_000 + i * 10, 0.5));
    await flush();

    expect(loop.state).toBe('listening'); // 打得断
    expect(clearSpy).toHaveBeenCalled();
    const written = mem.calls[0] as { role: string; content: string };
    expect(written.role).toBe('assistant');
    expect(written.content).toContain('[被用户打断]');

    release();
    await flush();
  });

  it('Tier1 去抖(confirmFrames=3):说话期高能量但连续帧仅 2(< N)不打断 → 保持 speaking', async () => {
    // barge-in-polish:聚焦验「连续帧数」去抖本身(而非能量)——帧能量全部高(0.5 ≥ cooldownRms 0.03,
    // 过能量门),唯连续帧数不足 N=3 时**不打断**。仅喂 2 帧 → 远不足 N → 保持 speaking、不 clearBuffer、不写半句。
    const mem = fakeMemory();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { deps, transport, bus } = makeDeps({
      memory: { appendMessage: mem.appendMessage },
      vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9]),
      echoGuard: guard({ confirmFrames: 3, cooldownRmsThreshold: 0.03 }),
      send: async (_t, onToken) => {
        onToken('我正在说一句话。');
        await gate;
        return '我正在说一句话。';
      },
    });
    const { down } = recorders(transport, bus);
    const clearSpy = vi.spyOn(transport, 'clearBuffer');
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveSpeechThenSilence(transport);
    await flush();
    expect(loop.state).toBe('speaking');
    const downBefore = down.length;

    // 仅 2 帧高能量(< N=3)→ 连续帧不足 → 不打断
    transport.sendAudio(micFrame(20_000, 0.5));
    transport.sendAudio(micFrame(20_010, 0.5));
    await flush();

    expect(loop.state).toBe('speaking'); // 帧数去抖:不足 N 不打断
    expect(clearSpy).not.toHaveBeenCalled();
    expect(mem.appendMessage).not.toHaveBeenCalled();
    expect(down.length).toBe(downBefore);

    release();
    await flush();
  });

  it('Tier1 去抖(confirmFrames=3):同样高能量帧连续足够多(≥N)则打断 → 回 listening(对照上例,证非「打不断」)', async () => {
    // barge-in-polish:与上例同配置(N=3、高能量),区别仅连续帧数足够 → 必打断。
    // 与上例构成「不足 N 不打断 / 足 N 打断」对照,钉死帧数去抖是真正生效的门槛(不会因去抖变「打不断」)。
    const mem = fakeMemory();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { deps, transport, bus } = makeDeps({
      memory: { appendMessage: mem.appendMessage },
      vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9]),
      echoGuard: guard({ confirmFrames: 3, cooldownRmsThreshold: 0.03 }),
      send: async (_t, onToken) => {
        onToken('我正在说一句话。');
        await gate;
        onToken('后面还没说完。');
        return '我正在说一句话。后面还没说完。';
      },
    });
    recorders(transport, bus);
    const clearSpy = vi.spyOn(transport, 'clearBuffer');
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveSpeechThenSilence(transport);
    await flush();
    expect(loop.state).toBe('speaking');

    // 连续 6 帧高能量(足够覆盖 VAD speaking 翻真 + 连续达 N=3)→ 打断
    for (let i = 0; i < 6; i++) transport.sendAudio(micFrame(20_000 + i * 10, 0.5));
    await flush();

    expect(loop.state).toBe('listening'); // 足 N → 打得断
    expect(clearSpy).toHaveBeenCalled();
    const written = mem.calls[0] as { content: string };
    expect(written.content).toContain('[被用户打断]');

    release();
    await flush();
  });

  it('Tier2 冷却窗:agent 说完 1.5s 内低能量混响尾被挡(不开启虚假回合)', async () => {
    // send 同步出尽 → speaking→listening(turn:end 时以最近帧时刻 50ms 开冷却窗到 1550ms)。
    // 7 帧闭环 + 2 帧高概率:若无 EchoGuard 抑制,这 2 帧会触 speech_start 进 endpointing;
    // 故「仍 listening」证明是冷却窗低能量抑制起了作用(而非 VAD 没检出)。
    const { deps, transport, bus } = makeDeps({
      vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9]),
      echoGuard: guard({ confirmFrames: 1, cooldownMs: 1500, cooldownRmsThreshold: 0.03 }),
    });
    const { events } = recorders(transport, bus);
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveSpeechThenSilence(transport);
    await flush();
    expect(loop.state).toBe('listening'); // 回合走完

    const before = events.length;
    // 冷却窗起点 = turn:end 时最近帧时刻(10_050ms)→ 窗到 11_550ms;取窗内帧(1000ms < 11_550)。
    // 低能量混响尾(0.01 < 0.03)→ 被挡,不进 endpointing。
    transport.sendAudio(micFrame(1000, 0.01));
    transport.sendAudio(micFrame(1010, 0.01));
    await flush();

    expect(loop.state).toBe('listening'); // 未被混响尾带进 endpointing
    expect(events.length).toBe(before); // 无新 vad:speech_start 事件
  });

  it('Tier2 冷却窗:窗内高能量真语音放行 → 进 endpointing(允许用户立刻回话)', async () => {
    const { deps, transport, bus } = makeDeps({
      // 7 帧闭环 + 2 帧高概率(供窗内 speech_start)。
      vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9]),
      echoGuard: guard({ confirmFrames: 1, cooldownMs: 1500, cooldownRmsThreshold: 0.03 }),
    });
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveSpeechThenSilence(transport);
    await flush();
    expect(loop.state).toBe('listening');

    // 冷却窗内(1000ms < 11_550ms)高能量(0.5 ≥ 0.03)+ 连续 2 帧触 VAD speech_start → 放行进 endpointing。
    transport.sendAudio(micFrame(1000, 0.5));
    transport.sendAudio(micFrame(1010, 0.5));
    await flush();

    expect(loop.state).toBe('endpointing'); // 高能量真语音放行
  });

  it('Tier2→常态:冷却窗结束后恢复 base 阈,低能量也放行(灵敏度回常态)', async () => {
    // base=0 → 冷却窗外任何被 VAD 判有声的帧都放行(常态灵敏度)。
    const { deps, transport, bus } = makeDeps({
      // 7 帧闭环 + 2 帧高概率(供冷却窗外 speech_start)。
      vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9]),
      echoGuard: guard({ confirmFrames: 1, cooldownMs: 1500, baseRmsThreshold: 0, cooldownRmsThreshold: 0.03 }),
    });
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveSpeechThenSilence(transport);
    await flush();
    expect(loop.state).toBe('listening');

    // 冷却窗起点 = turn:end 时最近帧时刻(10_050ms)→ 窗到 11_550ms。
    // 取窗外帧时刻(13_000ms > 11_550ms)低能量(0.01)但 base=0 → 放行;连续 2 帧触 speech_start 进 endpointing。
    transport.sendAudio(micFrame(13_000, 0.01));
    transport.sendAudio(micFrame(13_010, 0.01));
    await flush();

    expect(loop.state).toBe('endpointing'); // 冷却结束恢复常态,低能量也放行
  });

  it('非说话期常态(未注入冷却影响):注入 EchoGuard 后正常闭环仍走通', async () => {
    const { deps, transport, bus } = makeDeps({
      echoGuard: guard({ confirmFrames: 1, baseRmsThreshold: 0 }),
    });
    const { down, events } = recorders(transport, bus);
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveSpeechThenSilence(transport);
    await flush();

    expect(loop.state).toBe('listening');
    const actions = events.map((e) => e.action).filter((a) => a !== 'turn:start');
    expect(actions).toEqual(['vad:speech_start', 'stt:final', 'tts:first_audio', 'turn:end']);
    expect(down.length).toBeGreaterThan(0);
  });

  it('危机/硬打断豁免:hardInterrupt 标注下低能量单帧即打断(不被 RMS/N 帧拖延)', async () => {
    const mem = fakeMemory();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { deps, transport, bus } = makeDeps({
      memory: { appendMessage: mem.appendMessage },
      vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9]),
      // 高阈 + 高 N + 低能量帧:唯豁免才能打断。
      echoGuard: guard({ confirmFrames: 10, cooldownRmsThreshold: 0.9 }),
      attention: {
        mode: 'companion',
        buildSignal: () => ({ sustainedMs: 0, hardInterrupt: true }),
      },
      send: async (_t, onToken) => {
        onToken('我正在说一句话。');
        await gate;
        onToken('后面还没说完。');
        return '我正在说一句话。后面还没说完。';
      },
    });
    recorders(transport, bus);
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveSpeechThenSilence(transport);
    await flush();
    expect(loop.state).toBe('speaking');

    // 仅一帧低能量(0.01),因 hardInterrupt 豁免绕过 RMS/N 帧去抖,首帧即打断。
    transport.sendAudio(micFrame(20_000, 0.01));
    await flush();

    expect(loop.state).toBe('listening');
    const written = mem.calls[0] as { content: string };
    expect(written.content).toContain('[被用户打断]');

    release();
    await flush();
  });

  it('可观测:注入 echoGuardObserver → speaking 期每帧决策(tier/rms/pass)经回调抛出(day1 RMS 日志)', async () => {
    const decisions: { tier: string; pass: boolean; energy01: number }[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { deps, transport, bus } = makeDeps({
      vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9, 0.9]),
      echoGuard: guard({ confirmFrames: 1, cooldownRmsThreshold: 0.03 }),
      echoGuardObserver: (d) => decisions.push({ tier: d.tier, pass: d.pass, energy01: d.energy01 }),
      send: async (_t, onToken) => {
        onToken('我正在说一句话。');
        await gate;
        return '我正在说一句话。';
      },
    });
    recorders(transport, bus);
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveSpeechThenSilence(transport);
    await flush();
    expect(loop.state).toBe('speaking');

    transport.sendAudio(micFrame(20_000, 0.01)); // speaking 期低能量回声 → 挡
    await flush();

    const speakingDecisions = decisions.filter((d) => d.tier === 'speaking');
    expect(speakingDecisions.length).toBeGreaterThan(0);
    expect(speakingDecisions.every((d) => d.pass === false)).toBe(true);
    expect(speakingDecisions[0]!.energy01).toBeCloseTo(0.01, 2);

    release();
    await flush();
  });
});
