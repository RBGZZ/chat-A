import { describe, it, expect } from 'vitest';
import {
  oceanToPadBaseline,
  stepPad,
  padToEmotion,
  DEFAULT_DIALS,
  DEFAULT_PERSONA_CONFIG,
  type Ocean,
  type Pad,
} from '../src/index';

const NEUTRAL_OCEAN: Ocean = {
  openness: 0.5,
  conscientiousness: 0.5,
  extraversion: 0.5,
  agreeableness: 0.5,
  neuroticism: 0.5,
};
const ZERO_PULL: Pad = { pleasure: 0, arousal: 0, dominance: 0 };

describe('persona/numeric: OCEAN→PAD 基线', () => {
  it('相同 OCEAN 恒定映射,落合法区间', () => {
    const a = oceanToPadBaseline(NEUTRAL_OCEAN, DEFAULT_DIALS);
    const b = oceanToPadBaseline(NEUTRAL_OCEAN, DEFAULT_DIALS);
    expect(a).toEqual(b);
    for (const v of [a.pleasure, a.arousal, a.dominance]) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('高宜人 + 高外向抬高 Pleasure 基线', () => {
    const warm: Ocean = { ...NEUTRAL_OCEAN, extraversion: 0.9, agreeableness: 0.9 };
    const base = oceanToPadBaseline(NEUTRAL_OCEAN, DEFAULT_DIALS);
    const hi = oceanToPadBaseline(warm, DEFAULT_DIALS);
    expect(hi.pleasure).toBeGreaterThan(base.pleasure);
  });

  it('baseline_warmth 抬高 Pleasure 基线', () => {
    const cold = oceanToPadBaseline(NEUTRAL_OCEAN, { ...DEFAULT_DIALS, baselineWarmth: 0.1 });
    const warm = oceanToPadBaseline(NEUTRAL_OCEAN, { ...DEFAULT_DIALS, baselineWarmth: 0.9 });
    expect(warm.pleasure).toBeGreaterThan(cold.pleasure);
  });
});

describe('persona/numeric: PAD 弹簧步进', () => {
  const baseline: Pad = { pleasure: 0, arousal: 0, dominance: 0 };
  const afterColdStart = DEFAULT_PERSONA_CONFIG.coldStartTurns + 1;

  it('无 pull 时向基线收敛(不越过)', () => {
    let pad: Pad = { pleasure: 0.8, arousal: 0, dominance: 0 };
    const prev = pad.pleasure;
    pad = stepPad({ pad, pull: ZERO_PULL, baseline, dials: DEFAULT_DIALS, turn: afterColdStart, config: DEFAULT_PERSONA_CONFIG });
    expect(pad.pleasure).toBeLessThan(prev); // 朝 0 靠近
    expect(pad.pleasure).toBeGreaterThan(0); // 未越过基线
  });

  it('正向 pull 抬高当前情绪', () => {
    const pad = stepPad({
      pad: baseline,
      pull: { pleasure: 0.6, arousal: 0, dominance: 0 },
      baseline,
      dials: DEFAULT_DIALS,
      turn: afterColdStart,
      config: DEFAULT_PERSONA_CONFIG,
    });
    expect(pad.pleasure).toBeGreaterThan(0);
  });

  it('冷启动期幅度减半(偏移更小)', () => {
    const pull: Pad = { pleasure: 0.8, arousal: 0, dominance: 0 };
    const inCold = stepPad({ pad: baseline, pull, baseline, dials: DEFAULT_DIALS, turn: 1, config: DEFAULT_PERSONA_CONFIG });
    const outCold = stepPad({ pad: baseline, pull, baseline, dials: DEFAULT_DIALS, turn: afterColdStart, config: DEFAULT_PERSONA_CONFIG });
    expect(inCold.pleasure).toBeLessThan(outCold.pleasure); // 冷启动内反应更弱
  });

  it('emotional_volatility 改变回归速率(高波动→阻尼更小→偏离更大)', () => {
    const pad: Pad = { pleasure: 0.8, arousal: 0, dominance: 0 };
    const stable = stepPad({ pad, pull: ZERO_PULL, baseline, dials: { ...DEFAULT_DIALS, emotionalVolatility: 0.1 }, turn: afterColdStart, config: DEFAULT_PERSONA_CONFIG });
    const volatile = stepPad({ pad, pull: ZERO_PULL, baseline, dials: { ...DEFAULT_DIALS, emotionalVolatility: 0.9 }, turn: afterColdStart, config: DEFAULT_PERSONA_CONFIG });
    // 高波动阻尼小 → 回归慢 → 仍更靠近原值(更高)
    expect(volatile.pleasure).toBeGreaterThan(stable.pleasure);
  });
});

describe('persona/numeric: PAD→离散情绪', () => {
  it('高愉悦高唤醒=joyful;低愉悦低唤醒=down;中性=neutral', () => {
    expect(padToEmotion({ pleasure: 0.6, arousal: 0.4, dominance: 0 })).toBe('joyful');
    expect(padToEmotion({ pleasure: 0.6, arousal: -0.1, dominance: 0 })).toBe('content');
    expect(padToEmotion({ pleasure: 0, arousal: 0, dominance: 0 })).toBe('neutral');
    expect(padToEmotion({ pleasure: -0.6, arousal: -0.1, dominance: 0 })).toBe('down');
    expect(padToEmotion({ pleasure: -0.6, arousal: 0.4, dominance: 0 })).toBe('irritated');
  });
});
