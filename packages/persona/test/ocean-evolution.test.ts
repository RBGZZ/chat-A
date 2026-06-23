import { describe, it, expect } from 'vitest';
import {
  applyOceanDelta,
  buildDeltaSnapshot,
  clampOceanDelta,
  isZeroDelta,
  shouldEvolve,
  type Ocean,
  type OceanDelta,
} from '../src/index';

const ZERO: OceanDelta = {
  openness: 0,
  conscientiousness: 0,
  extraversion: 0,
  agreeableness: 0,
  neuroticism: 0,
};

const OCEAN: Ocean = {
  openness: 0.5,
  conscientiousness: 0.5,
  extraversion: 0.5,
  agreeableness: 0.5,
  neuroticism: 0.5,
};

describe('persona/ocean-evolution: delta 钳制(golden)', () => {
  it('越界 delta 被钳到 ±0.01 上限', () => {
    const raw: OceanDelta = {
      openness: 1, // 远超上限
      conscientiousness: -1,
      extraversion: 0.005, // 上限内,原样
      agreeableness: 0.01, // 恰好上限
      neuroticism: -0.02, // 超下限
    };
    const d = clampOceanDelta(raw, 0.01);
    expect(d.openness).toBe(0.01);
    expect(d.conscientiousness).toBe(-0.01);
    expect(d.extraversion).toBe(0.005);
    expect(d.agreeableness).toBe(0.01);
    expect(d.neuroticism).toBe(-0.01);
  });

  it('非有限 delta 维度视作 0', () => {
    const raw = {
      openness: Number.NaN,
      conscientiousness: Number.POSITIVE_INFINITY,
      extraversion: Number.NEGATIVE_INFINITY,
      agreeableness: 0.003,
      neuroticism: 0,
    } as OceanDelta;
    const d = clampOceanDelta(raw, 0.01);
    expect(d.openness).toBe(0);
    expect(d.conscientiousness).toBe(0);
    expect(d.extraversion).toBe(0);
    expect(d.agreeableness).toBe(0.003);
  });
});

describe('persona/ocean-evolution: applyOceanDelta(golden)', () => {
  it('逐维相加后钳回 [0,1]', () => {
    const after = applyOceanDelta(OCEAN, { ...ZERO, openness: 0.01, neuroticism: -0.01 });
    expect(after.openness).toBeCloseTo(0.51);
    expect(after.neuroticism).toBeCloseTo(0.49);
    expect(after.conscientiousness).toBe(0.5); // 未动
  });

  it('应用后越界被钳到 [0,1]', () => {
    const hi: Ocean = { ...OCEAN, openness: 1 };
    const lo: Ocean = { ...OCEAN, neuroticism: 0 };
    expect(applyOceanDelta(hi, { ...ZERO, openness: 0.01 }).openness).toBe(1);
    expect(applyOceanDelta(lo, { ...ZERO, neuroticism: -0.01 }).neuroticism).toBe(0);
  });
});

describe('persona/ocean-evolution: shouldEvolve 节拍(golden)', () => {
  it('第 20 轮触发,第 19/21/40 等符合周期判定', () => {
    expect(shouldEvolve(20, 20)).toBe(true);
    expect(shouldEvolve(40, 20)).toBe(true);
    expect(shouldEvolve(19, 20)).toBe(false);
    expect(shouldEvolve(21, 20)).toBe(false);
  });

  it('turn=0 与非正周期不触发', () => {
    expect(shouldEvolve(0, 20)).toBe(false);
    expect(shouldEvolve(20, 0)).toBe(false);
    expect(shouldEvolve(20, -5)).toBe(false);
  });
});

describe('persona/ocean-evolution: 快照与全零判定(golden)', () => {
  it('buildDeltaSnapshot 字段正确', () => {
    const before = OCEAN;
    const delta = { ...ZERO, extraversion: 0.005 };
    const after = applyOceanDelta(before, delta);
    const snap = buildDeltaSnapshot(before, after, delta, 20, '2026-06-23T00:00:00.000Z');
    expect(snap).toEqual({
      turn: 20,
      at: '2026-06-23T00:00:00.000Z',
      before,
      after,
      delta,
    });
  });

  it('isZeroDelta 区分全零与非零', () => {
    expect(isZeroDelta(ZERO)).toBe(true);
    expect(isZeroDelta({ ...ZERO, agreeableness: 0.001 })).toBe(false);
  });
});
