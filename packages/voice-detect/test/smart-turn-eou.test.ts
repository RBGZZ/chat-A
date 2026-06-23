import { describe, it, expect } from 'vitest';
import { SAMPLE_RATE_HZ, CHANNELS, type PcmFrame } from '@chat-a/protocol';
import {
  SmartTurnEouModel,
  FakeEouInferenceSession,
  TurnDetector,
} from '../src/index';

/** 造 N 帧音频窗(每帧 160 样本=10ms@16k,全填 1000)。 */
function window(frames: number): PcmFrame[] {
  return Array.from({ length: frames }, (_, i) => ({
    samples: new Int16Array(160).fill(1000),
    sampleRate: SAMPLE_RATE_HZ,
    channels: CHANNELS,
    timestampMs: i * 10,
  }));
}

describe('SmartTurnEouModel(拼音频窗 + 截最近窗 + 复用 DynamicEndpointing)', () => {
  it('非空窗调用 infer 一次并返回其概率', () => {
    const session = new FakeEouInferenceSession([0.8]);
    const model = new SmartTurnEouModel({ session });
    const p = model.predict(window(10));
    expect(session.inferCount).toBe(1);
    expect(p).toBe(0.8);
  });

  it('空窗返回 0 且不调用 infer', () => {
    const session = new FakeEouInferenceSession([0.9]);
    const model = new SmartTurnEouModel({ session });
    const p = model.predict([]);
    expect(p).toBe(0);
    expect(session.inferCount).toBe(0);
  });

  it('窗超过 maxWindowMs 时只截取最近一段喂模型', () => {
    const session = new FakeEouInferenceSession([0.5]);
    // maxWindowMs=100ms @16k = 1600 样本上限
    const model = new SmartTurnEouModel({
      session,
      inference: { maxWindowMs: 100, sampleRate: 16_000, normalize: false },
    });
    // 喂 50 帧 = 500ms = 8000 样本,远超 1600
    model.predict(window(50));
    expect(session.lastWindowLen).toBe(1600); // 截到最近 100ms
  });

  it('infer 抛错时返回 0(未说完),不向上抛', () => {
    const session = new FakeEouInferenceSession([0.9], { throwAt: 1 });
    const model = new SmartTurnEouModel({ session });
    let p: number | undefined;
    expect(() => {
      p = model.predict(window(10));
    }).not.toThrow();
    expect(p).toBe(0);
  });

  it('reset 调用端口 reset', () => {
    const session = new FakeEouInferenceSession([0.9]);
    const model = new SmartTurnEouModel({ session });
    model.reset();
    expect(session.resetCount).toBe(1);
  });

  it('概率经 TurnDetector/DynamicEndpointing:高概率+足够静音 → Finished', () => {
    const session = new FakeEouInferenceSession([0.95]);
    const model = new SmartTurnEouModel({ session });
    const td = new TurnDetector(model);
    // 高 EOU 概率 + 大静音(超过 min 窗)→ 该接话
    const decision = td.step({ window: window(10), silenceMs: 5000, lang: 'en' });
    expect(decision.state).toBe('Finished');
    expect(decision.shouldEndpoint).toBe(true);
  });

  it('缺 session 端口构造即 fail-fast', () => {
    expect(
      () => new SmartTurnEouModel({ session: undefined as unknown as FakeEouInferenceSession }),
    ).toThrow(/session/);
  });
});
