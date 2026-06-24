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
import { StubVadDetector, TurnDetector, StubEouModel } from '@chat-a/voice-detect';
import { FakeStt, FakeTts, type PcmChunk } from '@chat-a/providers';
import { LightVoiceBus } from '../src/bus';
import { VoiceLoop } from '../src/voice-loop';
import type { VoiceLoopDeps, OmniAudioPort, VoiceOmniEvent } from '../src/voice-loop';

// ───────────────────────────── 测试夹具（与 voice-loop.test.ts 同风格）─────────────────────────────

/** 构造一个 16k mono Int16 的上行 audio:input AudioFrame（带显式时刻）。 */
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

function recorders(transport: InProcessAudioTransport, bus: LightVoiceBus) {
  const down: AudioFrame[] = [];
  transport.onAudio((f) => {
    if (f.type === 'tts:chunk') down.push(f);
  });
  const events: BusEvent[] = [];
  bus.onAny((e) => events.push(e));
  return { down, events };
}

/**
 * 一个 fake omni 端口（OmniAudioPort）：消费传入音频块（模拟送出），按序 yield 给定事件。
 * - signal 已 abort（或迭代中变 abort）→ 抛 AbortError（模拟真 provider 打断关 WS）。
 * - `gate`（可选）：在首个 `text` 事件后 await，模拟「回复尚未说完即被打断」。
 */
function fakeOmni(opts: {
  events: VoiceOmniEvent[];
  gate?: Promise<void>;
  throwBeforeYield?: boolean;
}): { port: OmniAudioPort; capturedSignal: () => AbortSignal | undefined; consumedChunks: () => number } {
  let capturedSignal: AbortSignal | undefined;
  let consumed = 0;
  const port: OmniAudioPort = {
    async *respondToAudio(
      audio: AsyncIterable<PcmChunk>,
      _o?: Record<string, never>,
      signal?: AbortSignal,
    ): AsyncIterable<VoiceOmniEvent> {
      capturedSignal = signal;
      // 每次读取「当前是否已 abort」（用闭包避免 TS 把 signal.aborted 错误窄化为常量 false）。
      const isAborted = (): boolean => signal?.aborted === true;
      const abortErr = (): DOMException => new DOMException('aborted', 'AbortError');
      for await (const _chunk of audio) consumed++; // 消费攒好的音频（模拟 input_audio_buffer.append）
      if (opts.throwBeforeYield) throw new Error('omni 连接失败(模拟)');
      let firstTextSeen = false;
      for (const ev of opts.events) {
        if (isAborted()) throw abortErr();
        yield ev;
        if (ev.type === 'text' && !firstTextSeen && opts.gate !== undefined) {
          firstTextSeen = true;
          await opts.gate; // 卡住,模拟回复未说完即被打断
          if (isAborted()) throw abortErr();
        }
      }
    },
  };
  return { port, capturedSignal: () => capturedSignal, consumedChunks: () => consumed };
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

async function driveSpeechThenSilence(transport: InProcessAudioTransport): Promise<void> {
  transport.sendAudio(micFrame(0));
  transport.sendAudio(micFrame(10));
  transport.sendAudio(micFrame(20));
  transport.sendAudio(micFrame(30));
  transport.sendAudio(micFrame(40));
  transport.sendAudio(micFrame(50));
  transport.sendAudio(micFrame(10_050));
  await flush();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

// ───────────────────────────── 测试 ─────────────────────────────

describe('runtime/VoiceLoop omni audio-in 直路（path B）', () => {
  it('① 直路闭环：transcript 写记忆(role:user) + text→TTS + stt:final/tts:first_audio/turn:end + 回 listening', async () => {
    const mem = fakeMemory();
    const omni = fakeOmni({
      events: [
        { type: 'transcript', text: '你好小雪' },
        { type: 'text', text: '你好。' },
        { type: 'text', text: '很高兴见到你。' },
        { type: 'end' },
      ],
    });
    const { deps, transport, bus } = makeDeps({
      memory: { appendMessage: mem.appendMessage },
      omni: omni.port,
      voicePath: 'omni',
    });
    const { down, events } = recorders(transport, bus);
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveSpeechThenSilence(transport);
    await flush();

    expect(loop.state).toBe('listening');

    // transcript 写记忆：role:'user'，content=转写文本
    expect(mem.appendMessage).toHaveBeenCalled();
    const written = mem.calls[0] as { role: string; content: string };
    expect(written.role).toBe('user');
    expect(written.content).toBe('你好小雪');

    // BusEvent 序列：含 stt:final（携真转写）/ tts:first_audio / turn:end
    const actions = events.map((e) => e.action).filter((a) => a !== 'turn:start');
    expect(actions).toEqual(['vad:speech_start', 'stt:final', 'tts:first_audio', 'turn:end']);
    const sttFinal = events.find((e) => e.action === 'stt:final');
    expect(sttFinal && (sttFinal.data as { text: string }).text).toBe('你好小雪');

    // text 增量分句下行为 tts:chunk
    expect(down.length).toBeGreaterThan(0);
    expect(down.every((f) => f.type === 'tts:chunk')).toBe(true);

    // omni 端口确实消费了攒好的音频帧
    expect(omni.consumedChunks()).toBeGreaterThan(0);
  });

  it('② 打断：omni 回合 signal 变 aborted + 半句写回带[被用户打断] + 回 listening + 旧帧不再下行', async () => {
    const mem = fakeMemory();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const omni = fakeOmni({
      events: [
        { type: 'transcript', text: '你好小雪' },
        { type: 'text', text: '我正在说一句话。' }, // 整句 → 触发 speaking，进 #replyAccum
        { type: 'text', text: '后面还没说完。' }, // 打断后 gen 变 → no-op
        { type: 'end' },
      ],
      gate,
    });
    const { deps, transport, bus } = makeDeps({
      memory: { appendMessage: mem.appendMessage },
      omni: omni.port,
      voicePath: 'omni',
      // 索引 7~8 供 barge-in 两帧(高→speech_start)
      vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9]),
    });
    const { down } = recorders(transport, bus);
    const clearSpy = vi.spyOn(transport, 'clearBuffer');
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveSpeechThenSilence(transport);
    await flush();
    expect(loop.state).toBe('speaking');
    expect(omni.capturedSignal()).toBeInstanceOf(AbortSignal);
    expect(omni.capturedSignal()?.aborted).toBe(false);
    const downBeforeInterrupt = down.length;
    expect(downBeforeInterrupt).toBeGreaterThan(0);

    // speaking 中再来语音 → 打断
    transport.sendAudio(micFrame(20_000));
    transport.sendAudio(micFrame(20_010));
    await flush();

    expect(loop.state).toBe('listening');
    expect(clearSpy).toHaveBeenCalled();
    // 真取消：omni 回合 signal 已 aborted（底层 WS 流真停）
    expect(omni.capturedSignal()?.aborted).toBe(true);

    // 半句写回（assistant + [被用户打断]）；mem.calls[0] 是 transcript(user)，写回是 assistant 那条
    const assistantWrite = mem.calls.find(
      (m) => (m as { role: string }).role === 'assistant',
    ) as { content: string } | undefined;
    expect(assistantWrite).toBeDefined();
    expect(assistantWrite?.content).toContain('[被用户打断]');
    expect(assistantWrite?.content).toContain('我正在说一句话。');

    // 放行被卡的 omni：打断后旧 gen 帧不再下行
    release();
    await flush();
    expect(down.length).toBe(downBeforeInterrupt);
  });

  it('③ 降级(a)：omni respondToAudio 抛错 → 干净回 listening 不崩', async () => {
    const omni = fakeOmni({ events: [], throwBeforeYield: true });
    const { deps, transport } = makeDeps({ omni: omni.port, voicePath: 'omni' });
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveSpeechThenSilence(transport);
    await flush();
    expect(loop.state).toBe('listening');
  });

  it('③ 降级(b)：voicePath=omni 但 omni 端口缺失 → 走 STT 路径正常闭环', async () => {
    const { deps, transport, bus } = makeDeps({ voicePath: 'omni' /* 不注入 omni */ });
    const { events } = recorders(transport, bus);
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveSpeechThenSilence(transport);
    await flush();
    expect(loop.state).toBe('listening');
    // 走的是 STT 路径（FakeStt 出 '你好小雪'）
    const sttFinal = events.find((e) => e.action === 'stt:final');
    expect(sttFinal && (sttFinal.data as { text: string }).text).toBe('你好小雪');
  });

  it('④ 默认 STT 回归：不设 voicePath（缺省 stt）→ 既有 STT 闭环逐字绿', async () => {
    const omni = fakeOmni({ events: [{ type: 'transcript', text: '不该被用到' }, { type: 'end' }] });
    // 即便注入了 omni 端口，但 voicePath 缺省(stt) → 仍走 STT 路径，omni 不被调用。
    const { deps, transport, bus } = makeDeps({ omni: omni.port /* voicePath 缺省 */ });
    const { events } = recorders(transport, bus);
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveSpeechThenSilence(transport);
    await flush();
    expect(loop.state).toBe('listening');
    const sttFinal = events.find((e) => e.action === 'stt:final');
    expect(sttFinal && (sttFinal.data as { text: string }).text).toBe('你好小雪');
    // omni 端口未被触达（缺省 stt 路径不调用它）
    expect(omni.capturedSignal()).toBeUndefined();
  });
});
