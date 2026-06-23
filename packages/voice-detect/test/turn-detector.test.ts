import { describe, it, expect } from 'vitest';
import { SAMPLE_RATE_HZ, CHANNELS, type PcmFrame } from '@chat-a/protocol';
import { StubEouModel, TurnDetector } from '../src/index';

const win: readonly PcmFrame[] = [
  { samples: new Int16Array(160), sampleRate: SAMPLE_RATE_HZ, channels: CHANNELS, timestampMs: 0 },
];

describe('voice-detect/TurnDetector(EouModel 桩 + 动态 endpointing 组合)', () => {
  it('桩高概率 + 足够静音 → Finished', () => {
    const td = new TurnDetector(new StubEouModel([0.9]));
    const dec = td.step({ window: win, silenceMs: 1000, lang: 'en' });
    expect(dec.state).toBe('Finished');
    expect(dec.shouldEndpoint).toBe(true);
  });

  it('桩低概率 → 钳 maxDelay → 静音不足 → Unfinished', () => {
    const td = new TurnDetector(new StubEouModel([0.1]));
    const dec = td.step({ window: win, silenceMs: 1000, lang: 'en' });
    expect(dec.state).toBe('Unfinished');
  });

  it('概率序列逐步推进:先没说完(低)后说完(高)', () => {
    const td = new TurnDetector(new StubEouModel([0.1, 0.95]));
    // 低概率(0.1<阈)→ 钳 max 4000,500ms 远不够 → Unfinished;
    // 高概率(0.95)→ 目标窗插值约 700ms,给足 1000ms 静音 → Finished。
    const first = td.step({ window: win, silenceMs: 500, lang: 'en' });
    const second = td.step({ window: win, silenceMs: 1000, lang: 'en' });
    expect(first.state).toBe('Unfinished');
    expect(second.state).toBe('Finished');
  });

  it('forceWait 透传 → Wait', () => {
    const td = new TurnDetector(new StubEouModel([0.99]));
    const dec = td.step({ window: win, silenceMs: 9999, lang: 'en', forceWait: true });
    expect(dec.state).toBe('Wait');
  });

  it('暴露 dynamic 供喂停顿样本做自校准', () => {
    const td = new TurnDetector(new StubEouModel([1, 1]));
    td.dynamic.observeTurnGap(1500);
    td.dynamic.observeTurnGap(1500);
    const dec = td.step({ window: win, silenceMs: 500, lang: 'en' });
    // 学到 1500ms 轮间停顿 → 目标窗抬高 → 500ms 静音不够 → 还没说完。
    expect(dec.shouldEndpoint).toBe(false);
  });

  it('reset 后 EOU 桩与 EMA 均归零', () => {
    const td = new TurnDetector(new StubEouModel([0.1, 0.9]));
    td.step({ window: win, silenceMs: 0, lang: 'en' }); // 消耗 0.1
    td.dynamic.observeTurnGap(2000);
    td.reset();
    // reset 后再取 → 回到序列首个 0.1;EMA 清空(无自校准)。
    const dec = td.step({ window: win, silenceMs: 5000, lang: 'en' });
    // prob 0.1 < 阈 → maxDelay 4000;silence 5000 ≥ 4000 → Finished(证明 EMA 已清,未抬窗到 >5000)。
    expect(dec.shouldEndpoint).toBe(true);
  });
});
