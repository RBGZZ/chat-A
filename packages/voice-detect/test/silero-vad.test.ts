import { describe, it, expect } from 'vitest';
import { SAMPLE_RATE_HZ, CHANNELS, type PcmFrame } from '@chat-a/protocol';
import {
  SileroVadDetector,
  FakeVadInferenceSession,
  type VadEvent,
} from '../src/index';

/** 造一帧 16k mono PCM,samples 全为给定值(SileroVadDetector 会解码累积成窗;默认 160 样本/帧)。 */
const frame = (timestampMs: number, fill = 0, len = 160): PcmFrame => ({
  samples: new Int16Array(len).fill(fill),
  sampleRate: SAMPLE_RATE_HZ,
  channels: CHANNELS,
  timestampMs,
});

/** 喂一串帧(每帧 +10ms),收集触发的事件。 */
function runFrames(
  vad: SileroVadDetector,
  count: number,
  opts?: { framLen?: number },
): VadEvent[] {
  const events: VadEvent[] = [];
  for (let i = 0; i < count; i++) {
    const r = vad.pushFrame(frame(i * 10, 1000, opts?.framLen ?? 160));
    if (r.event) events.push(r.event);
  }
  return events;
}

describe('SileroVadDetector(帧→512窗缓冲 + 注入端口推理 + 复用 VadGate)', () => {
  it('攒满一个推理窗(512样本=4帧×160→需第4帧)才调用一次 infer', () => {
    const session = new FakeVadInferenceSession([0.9]);
    const vad = new SileroVadDetector({ session });
    // 帧 1~3:累积 480 样本 < 512 → 不推理
    vad.pushFrame(frame(0, 1000));
    vad.pushFrame(frame(10, 1000));
    vad.pushFrame(frame(20, 1000));
    expect(session.inferCount).toBe(0);
    // 帧 4:累积 640 ≥ 512 → 推理一次(剩 128 样本留存)
    vad.pushFrame(frame(30, 1000));
    expect(session.inferCount).toBe(1);
  });

  it('未攒满下一窗时复用上一窗概率,不重复推理', () => {
    const session = new FakeVadInferenceSession([0.9]);
    const vad = new SileroVadDetector({ session });
    runFrames(vad, 4); // 第4帧推理一次
    expect(session.inferCount).toBe(1);
    // 第5帧:128+160=288 < 512 → 复用,不推理
    vad.pushFrame(frame(40, 1000));
    expect(session.inferCount).toBe(1);
  });

  it('低→持续高→持续低 概率经 VadGate 产出 speech_start 然后 speech_end', () => {
    // 端口序列:首窗低,之后高若干窗,再低若干窗(默认去抖 2 帧/窗)
    const session = new FakeVadInferenceSession([0.1, 0.9, 0.9, 0.9, 0.1, 0.1, 0.1]);
    const vad = new SileroVadDetector({ session });
    // 每帧 160 样本,512 窗 → 大约每 3~4 帧一窗;喂足够多帧覆盖整个序列
    const events = runFrames(vad, 40);
    expect(events.map((e) => e.type)).toEqual(['speech_start', 'speech_end']);
  });

  it('infer 抛错时该窗视作静音(概率0),不误触发 speech_start,不向上抛', () => {
    // 端口恒抛错
    const session = new FakeVadInferenceSession([0.9], { throwAt: 1 });
    // throwAt=1 只第一次抛;让它每次都抛:用始终抛错的端口
    const alwaysThrow = {
      infer() {
        throw new Error('boom');
      },
      reset() {},
    };
    const vad = new SileroVadDetector({ session: alwaysThrow });
    expect(() => runFrames(vad, 40)).not.toThrow();
    const events = runFrames(vad, 40);
    expect(events).toEqual([]); // 恒静音 → 无事件
    void session;
  });

  it('reset 清缓冲、复位 VadGate、调用端口 reset', () => {
    const session = new FakeVadInferenceSession([0.9]);
    const vad = new SileroVadDetector({ session });
    runFrames(vad, 4);
    vad.reset();
    expect(session.resetCount).toBe(1);
    // reset 后重新攒窗:再喂 3 帧(<512)不应推理(缓冲已清,从 0 重新攒)
    const before = session.inferCount;
    vad.pushFrame(frame(0, 1000));
    vad.pushFrame(frame(10, 1000));
    vad.pushFrame(frame(20, 1000));
    expect(session.inferCount).toBe(before); // 480<512,未推理
  });

  it('缺 session 端口构造即 fail-fast', () => {
    expect(
      () => new SileroVadDetector({ session: undefined as unknown as FakeVadInferenceSession }),
    ).toThrow(/session/);
  });
});
