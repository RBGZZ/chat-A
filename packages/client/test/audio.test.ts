import { describe, it, expect, vi } from 'vitest';
import {
  SAMPLE_RATE_HZ,
  CHANNELS,
  type PcmFrame,
} from '@chat-a/protocol';
import { StubVadDetector, TurnDetector, StubEouModel } from '@chat-a/voice-detect';
import { FakeStt, FakeTts } from '@chat-a/providers';
import { FakeAudioDevice } from '../src/audio/fake-audio-device';
import { runVoiceLoop } from '../src/audio/voice-runner';
import { startVoiceMode } from '../src/cli-voice';

// ───────────────────────────── 夹具 ─────────────────────────────

/** 16k mono Int16 的一帧麦克风音频(带显式时刻)。 */
function micFrame(timestampMs: number): PcmFrame {
  return {
    samples: new Int16Array(160), // 10ms @16k
    sampleRate: SAMPLE_RATE_HZ,
    channels: CHANNELS,
    timestampMs,
  };
}

/** 一段「N 帧有声 → 长静音」脚本:驱动 VAD speech_start → endpointing → 长静音 → Finished。 */
function speechThenSilenceScript(): PcmFrame[] {
  return [
    micFrame(0),
    micFrame(10),
    micFrame(20),
    micFrame(30),
    micFrame(40),
    micFrame(50),
    micFrame(10_050), // 时间戳大幅前跳 → silenceMs≈10s ≫ endpointing 窗 → 必判说完
  ];
}

/** 放行挂起的微任务(FakeStt/FakeTts/send 同步即时,多轮确保链式 await 跑透)。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

// ───────────────────────────── 测试 ─────────────────────────────

describe('client/FakeAudioDevice', () => {
  it('capture 回放注入帧;play 记录收到的块', () => {
    const dev = new FakeAudioDevice({ script: [micFrame(0), micFrame(10)] });
    const got: PcmFrame[] = [];
    dev.captureStart((f) => got.push(f));
    expect(got).toHaveLength(2);
    expect(got[0]?.sampleRate).toBe(SAMPLE_RATE_HZ);

    dev.play({ samples: new Int16Array([1, 2, 3]), sampleRate: 24_000, channels: 1 });
    expect(dev.played).toHaveLength(1);
    expect(dev.played[0]?.sampleRate).toBe(24_000);

    dev.playStop();
    expect(dev.playStopCount).toBe(1);
  });

  it('close 后 capture/play 均为安全 no-op', () => {
    const dev = new FakeAudioDevice({ script: [micFrame(0)] });
    dev.close();
    const got: PcmFrame[] = [];
    dev.captureStart((f) => got.push(f));
    dev.play({ samples: new Int16Array([1]), sampleRate: 24_000, channels: 1 });
    expect(got).toHaveLength(0);
    expect(dev.played).toHaveLength(0);
  });
});

describe('client/runVoiceLoop(FakeAudioDevice ↔ VoiceLoop)', () => {
  it('设备采集帧 → VoiceLoop 收上行;下行 tts:chunk → 设备 play 收到', async () => {
    const device = new FakeAudioDevice(); // 先不回放,用 emit 精确控时序
    const handle = runVoiceLoop({
      device,
      loopDeps: {
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
        sessionId: 's1',
        clock: () => 1000,
      },
    });

    expect(handle.loop.state).toBe('listening');

    // 经设备喂上行帧(模拟麦克风采集)。
    for (const f of speechThenSilenceScript()) device.emit(f);
    await flush();

    // 终态回 listening(走完闭环)。
    expect(handle.loop.state).toBe('listening');
    // 下行 TTS 块经 transport 回环到达设备扬声器。
    expect(device.played.length).toBeGreaterThan(0);
    expect(device.played[0]?.sampleRate).toBe(24_000); // FakeTts 默认 24kHz

    handle.stop();
  });

  it('打断:speaking 中再来语音 → 设备 playStop 被触发', async () => {
    const device = new FakeAudioDevice();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const handle = runVoiceLoop({
      device,
      loopDeps: {
        vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9]),
        turnDetector: new TurnDetector(new StubEouModel([0.9])),
        stt: new FakeStt({ script: [{ text: '你好小雪', isFinal: true }] }),
        tts: new FakeTts({ samplesPerChar: 4 }),
        send: async (_t, onToken) => {
          onToken('我正在说一句话。'); // 整句 → 触发 speaking
          await gate; // 卡住,模拟未说完被打断
          onToken('后面还没说完。');
          return '我正在说一句话。后面还没说完。';
        },
        memory: { appendMessage: vi.fn() },
        sessionId: 's1',
        clock: () => 1000,
      },
    });

    for (const f of speechThenSilenceScript()) device.emit(f);
    await flush();
    expect(handle.loop.state).toBe('speaking');

    // speaking 中再来语音 → 打断 → bus turn:interrupt → 设备 playStop。
    device.emit(micFrame(20_000));
    device.emit(micFrame(20_010));
    await flush();

    expect(handle.loop.state).toBe('listening');
    expect(device.playStopCount).toBeGreaterThan(0);

    release();
    await flush();
    handle.stop();
  });
});

describe('client/startVoiceMode(cli 语音装配)', () => {
  it('用 Fake 设备 + Fake STT/TTS 装配一轮「喂音频→出音频」闭环不崩', async () => {
    // 强制 Fake 设备 + Fake STT/TTS(空 env → loadStt/TtsConfig 默认 fake)。
    const env: NodeJS.ProcessEnv = { CHAT_A_AUDIO_DEVICE: 'fake' };
    // 复用一个真实 bus(startVoiceMode 不自建总线,需调用方传)。
    const { LightVoiceBus } = await import('@chat-a/runtime');
    const bus = new LightVoiceBus();

    const sent: string[] = [];
    const handle = await startVoiceMode({
      send: async (text, onToken) => {
        sent.push(text);
        onToken('收到。');
        return '收到。';
      },
      memory: { appendMessage: vi.fn() },
      bus,
      sessionId: 'voice-1',
      env,
    });

    expect(handle.info.device).toContain('fake');
    expect(handle.info.stt).toBe('fake');
    expect(handle.info.tts).toBe('fake');

    handle.stop(); // 装配 + 收尾不崩即通过(Fake 设备无真采集,主要验装配链)
  });
});
