import { describe, it, expect } from 'vitest';
import {
  applyPersonaPatch,
  personaViewOf,
  XIAOXUE_SEED,
  type PersonaSeed,
} from '../src/index';

describe('personaViewOf:从种子摘可编辑视图', () => {
  it('取名字 + 三档(warmth/expressiveness/volatility)', () => {
    const v = personaViewOf(XIAOXUE_SEED);
    expect(v.name).toBe('小雪');
    expect(v.warmth).toBe(XIAOXUE_SEED.dials.baselineWarmth);
    expect(v.expressiveness).toBe(XIAOXUE_SEED.dials.expressiveness);
    expect(v.volatility).toBe(XIAOXUE_SEED.dials.emotionalVolatility);
  });
});

describe('applyPersonaPatch:夹取 + 应用(纯,不改原种子)', () => {
  it('改名字 + 三档,其余 dials/identity/ocean 原样保留', () => {
    const next = applyPersonaPatch(XIAOXUE_SEED, {
      name: '阿狸',
      warmth: 0.9,
      expressiveness: 0.2,
      volatility: 0.7,
    });
    expect(next.name).toBe('阿狸');
    expect(next.dials.baselineWarmth).toBe(0.9);
    expect(next.dials.expressiveness).toBe(0.2);
    expect(next.dials.emotionalVolatility).toBe(0.7);
    // 其它 dials 原样
    expect(next.dials.assertiveness).toBe(XIAOXUE_SEED.dials.assertiveness);
    expect(next.dials.emotionalIntensity).toBe(XIAOXUE_SEED.dials.emotionalIntensity);
    // identity/ocean/selfNotions 原样
    expect(next.identity).toBe(XIAOXUE_SEED.identity);
    expect(next.ocean).toEqual(XIAOXUE_SEED.ocean);
    expect(next.selfNotions).toEqual(XIAOXUE_SEED.selfNotions);
    // 不改原种子
    expect(XIAOXUE_SEED.name).toBe('小雪');
    expect(XIAOXUE_SEED.dials.baselineWarmth).toBe(0.6);
  });

  it('超界数值夹取到 [0,1]', () => {
    const next = applyPersonaPatch(XIAOXUE_SEED, {
      warmth: 1.5,
      expressiveness: -0.3,
      volatility: 2,
    });
    expect(next.dials.baselineWarmth).toBe(1);
    expect(next.dials.expressiveness).toBe(0);
    expect(next.dials.emotionalVolatility).toBe(1);
  });

  it('缺省/非有限/空白字段回落原值', () => {
    const next = applyPersonaPatch(XIAOXUE_SEED, {
      name: '   ',
      warmth: Number.NaN,
      // expressiveness / volatility 缺省
    });
    expect(next.name).toBe('小雪');
    expect(next.dials.baselineWarmth).toBe(XIAOXUE_SEED.dials.baselineWarmth);
    expect(next.dials.expressiveness).toBe(XIAOXUE_SEED.dials.expressiveness);
    expect(next.dials.emotionalVolatility).toBe(XIAOXUE_SEED.dials.emotionalVolatility);
  });

  it('空补丁 → 各字段全等价原种子', () => {
    const next = applyPersonaPatch(XIAOXUE_SEED, {});
    expect(personaViewOf(next)).toEqual(personaViewOf(XIAOXUE_SEED));
  });

  it('round-trip:apply 后 view 反映新值', () => {
    const base: PersonaSeed = { ...XIAOXUE_SEED };
    const next = applyPersonaPatch(base, { name: '小冬', warmth: 0.33 });
    const v = personaViewOf(next);
    expect(v.name).toBe('小冬');
    expect(v.warmth).toBeCloseTo(0.33);
  });
});
