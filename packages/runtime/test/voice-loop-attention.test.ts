import { describe, it, expect, vi } from 'vitest';
import {
  InProcessAudioTransport,
  makeDataFrame,
  SAMPLE_RATE_HZ,
  CHANNELS,
  type AudioFrame,
  type PcmFrame,
} from '@chat-a/protocol';
import { StubVadDetector, TurnDetector, StubEouModel } from '@chat-a/voice-detect';
import { FakeStt, FakeTts } from '@chat-a/providers';
import { LightVoiceBus } from '../src/bus';
import { VoiceLoop } from '../src/voice-loop';
import type { VoiceLoopDeps, VoiceLoopAttentionConfig } from '../src/voice-loop';
import type { AttentionMode, UserVoiceSignal } from '../src/attention';

function micFrame(timestampMs: number): AudioFrame {
  const pcm: PcmFrame = {
    samples: new Int16Array(160),
    sampleRate: SAMPLE_RATE_HZ,
    channels: CHANNELS,
    timestampMs,
  };
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

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** 组装 deps;send 先吐整句触发 speaking,再卡门(模拟在飞 autonomy/动作未说完)。 */
function makeAttentionDeps(
  attention: VoiceLoopAttentionConfig,
  vadProbs: number[],
): {
  deps: VoiceLoopDeps;
  transport: InProcessAudioTransport;
  mem: ReturnType<typeof fakeMemory>;
  release: () => void;
} {
  const transport = new InProcessAudioTransport();
  const bus = new LightVoiceBus();
  const mem = fakeMemory();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const deps: VoiceLoopDeps = {
    transport,
    vad: new StubVadDetector(vadProbs),
    turnDetector: new TurnDetector(new StubEouModel([0.9])),
    stt: new FakeStt({ script: [{ text: '你好小雪', isFinal: true }] }),
    tts: new FakeTts({ samplesPerChar: 4 }),
    send: async (_t, onToken) => {
      onToken('我正在主动说一句话。');
      await gate;
      onToken('后面还没说完。');
      return '我正在主动说一句话。后面还没说完。';
    },
    memory: { appendMessage: mem.appendMessage },
    bus,
    sessionId: 's1',
    clock: () => 1000,
    attention,
  };
  return { deps, transport, mem, release };
}

/** 驱动语音→长静音进 thinking/speaking。 */
async function driveToSpeaking(transport: InProcessAudioTransport): Promise<void> {
  transport.sendAudio(micFrame(0));
  transport.sendAudio(micFrame(10));
  transport.sendAudio(micFrame(20));
  transport.sendAudio(micFrame(30));
  transport.sendAudio(micFrame(40));
  transport.sendAudio(micFrame(50));
  transport.sendAudio(micFrame(10_050));
  await flush();
}

describe('runtime/VoiceLoop 关注闸接线(§7 软反转)', () => {
  it('companion:用户开口 → 在飞输出被打断 + 半句写回(标 interrupted)', async () => {
    const { deps, transport, mem, release } = makeAttentionDeps(
      { mode: 'companion' },
      [0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9],
    );
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveToSpeaking(transport);
    expect(loop.state).toBe('speaking');

    // 用户开口
    transport.sendAudio(micFrame(20_000));
    transport.sendAudio(micFrame(20_010));
    await flush();

    expect(loop.state).toBe('listening'); // 被打断回 listening
    expect(mem.appendMessage).toHaveBeenCalled();
    const written = mem.calls[0] as { role: string; turnId: string; content: string };
    expect(written.role).toBe('assistant');
    expect(written.turnId).toBe('interrupted'); // 标 interrupted
    expect(written.content).toContain('[被用户打断]');
    expect(written.content).toContain('我正在主动说一句话。');
    release();
    await flush();
  });

  it('focus:短促出声不打断(仍在 speaking,绝不装聋)', async () => {
    // 单帧 speech_start(sustainedMs=0 < 门槛)→ focus 不打断
    const { deps, transport, release } = makeAttentionDeps(
      { mode: 'focus' },
      [0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.0],
    );
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveToSpeaking(transport);
    expect(loop.state).toBe('speaking');

    // 用户短促出声一帧(随即静音)→ 不达坚持门槛
    transport.sendAudio(micFrame(20_000));
    transport.sendAudio(micFrame(20_010));
    await flush();
    expect(loop.state).toBe('speaking'); // 未被打断
    release();
    await flush();
  });

  it('focus:坚持够门槛 → 打断', async () => {
    // 持续有声多帧,时间戳跨度 > 600ms → 达坚持门槛
    const { deps, transport, release } = makeAttentionDeps(
      { mode: 'focus' },
      [0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9, 0.9, 0.9],
    );
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveToSpeaking(transport);
    expect(loop.state).toBe('speaking');

    transport.sendAudio(micFrame(20_000)); // speech_start(起点)
    transport.sendAudio(micFrame(20_010));
    transport.sendAudio(micFrame(20_400));
    transport.sendAudio(micFrame(20_800)); // sustainedMs=800 ≥ 600 → 打断
    await flush();
    expect(loop.state).toBe('listening');
    release();
    await flush();
  });

  it('不可配底线:focus 下危机信号立即打断(buildSignal 注入 crisis)', async () => {
    const attention: VoiceLoopAttentionConfig = {
      mode: 'focus',
      buildSignal: (ctx): UserVoiceSignal => ({ sustainedMs: ctx.sustainedMs, crisis: true }),
    };
    const { deps, transport, release } = makeAttentionDeps(
      attention,
      [0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9],
    );
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveToSpeaking(transport);
    expect(loop.state).toBe('speaking');

    // 2 帧高去抖触发 speech_start;sustainedMs≈0,但 crisis 无视门槛立即打断
    transport.sendAudio(micFrame(20_000));
    transport.sendAudio(micFrame(20_010));
    await flush();
    expect(loop.state).toBe('listening'); // 危机立即打断
    release();
    await flush();
  });

  it('mode 为函数:热读 attention_mode(改值下次检出生效)', async () => {
    let mode: AttentionMode = 'focus';
    // 7,8 高去抖触发 speech_start(focus 短促不打断);随后持续高帧重判(切 companion 后即打断)。
    const { deps, transport, release } = makeAttentionDeps(
      { mode: () => mode },
      [0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9, 0.9, 0.9],
    );
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveToSpeaking(transport);
    expect(loop.state).toBe('speaking');

    // focus 下短促出声(2 帧触发 speech_start,sustainedMs≈10ms < 600)不打断
    transport.sendAudio(micFrame(20_000));
    transport.sendAudio(micFrame(20_010));
    await flush();
    expect(loop.state).toBe('speaking');

    // 切到 companion:下一持续语音帧重判即打断(companion 不看坚持门槛)
    mode = 'companion';
    transport.sendAudio(micFrame(20_020)); // result.speaking=true,已记起点 → 重判
    await flush();
    expect(loop.state).toBe('listening');
    release();
    await flush();
  });
});
