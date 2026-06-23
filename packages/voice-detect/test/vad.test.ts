import { describe, it, expect } from 'vitest';
import { SAMPLE_RATE_HZ, CHANNELS, type PcmFrame } from '@chat-a/protocol';
import { StubVadDetector, type VadEvent } from '../src/index';

/** 造一帧 16k mono 静默 PCM,仅 timestampMs 有意义(VAD 桩按注入概率走,不看样本)。 */
const frame = (timestampMs: number): PcmFrame => ({
  samples: new Int16Array(160),
  sampleRate: SAMPLE_RATE_HZ,
  channels: CHANNELS,
  timestampMs,
});

/** 把一串概率喂给桩,收集所有触发的事件(每帧 +10ms)。 */
function runProbs(probs: readonly number[], cfg?: ConstructorParameters<typeof StubVadDetector>[1]): VadEvent[] {
  const vad = new StubVadDetector(probs, cfg);
  const events: VadEvent[] = [];
  for (let i = 0; i < probs.length; i++) {
    const r = vad.pushFrame(frame(i * 10));
    if (r.event) events.push(r.event);
  }
  return events;
}

describe('voice-detect/VAD 桩(按概率序列产 speech_start/end)', () => {
  it('低→高→低 产出 speech_start 然后 speech_end(默认 2 帧去抖)', () => {
    // 帧:0.1, 0.1, 0.9, 0.9(start), 0.9, 0.1, 0.1(end)
    const events = runProbs([0.1, 0.1, 0.9, 0.9, 0.9, 0.1, 0.1]);
    expect(events.map((e) => e.type)).toEqual(['speech_start', 'speech_end']);
    // start 在第 4 帧(index 3 → 30ms,连续 2 帧达标);end 在第 7 帧(index 6 → 60ms)。
    expect(events[0]!.atMs).toBe(30);
    expect(events[1]!.atMs).toBe(60);
  });

  it('单帧毛刺被去抖吞掉,不产 start', () => {
    // 只有 1 帧达标(默认需连续 2 帧)→ 无事件。
    const events = runProbs([0.1, 0.9, 0.1, 0.1]);
    expect(events).toEqual([]);
  });

  it('全静音 → 无事件', () => {
    expect(runProbs([0, 0, 0, 0])).toEqual([]);
  });

  it('概率序列耗尽后按静音处理(可触发 speech_end)', () => {
    // 起始达标进入说话;序列只给 3 帧,后续 pushFrame 概率回落 0 → 去抖后 end。
    const vad = new StubVadDetector([0.9, 0.9, 0.9]);
    vad.pushFrame(frame(0));
    vad.pushFrame(frame(10)); // start 在此(连续 2 帧)
    vad.pushFrame(frame(20));
    const r1 = vad.pushFrame(frame(30)); // prob 用尽 → 0
    const r2 = vad.pushFrame(frame(40)); // 连续 2 帧静音 → end
    expect(r1.event).toBeUndefined();
    expect(r2.event?.type).toBe('speech_end');
  });

  it('reset 后状态归零,可重跑同序列得同结果', () => {
    const vad = new StubVadDetector([0.9, 0.9, 0.1, 0.1]);
    const run = () => {
      const evs: VadEvent[] = [];
      for (let i = 0; i < 4; i++) {
        const r = vad.pushFrame(frame(i * 10));
        if (r.event) evs.push(r.event);
      }
      return evs.map((e) => e.type);
    };
    const a = run();
    vad.reset();
    const b = run();
    expect(a).toEqual(b);
    expect(a).toEqual(['speech_start', 'speech_end']);
  });
});
