import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MEMORY_CONFIG,
  EMOTION_RESONANCE_MATRIX,
  emotionResonance,
  emotionSector,
  keywordScore,
  mixedRecallScore,
  recallScore,
  resolveMemoryConfig,
  type Pad,
  type RecallSignal,
} from '../src/index';

/**
 * §5.5 混合召回单一权威公式 golden:锁住关键词归一(自适应中点)、自适应分母混合、
 * 零信号门控、情感共振扇区矩阵。确定性内核,无 LLM(§3.2)。
 */
describe('§5.5 混合召回打分归一(单一权威公式 golden)', () => {
  const cfg = DEFAULT_MEMORY_CONFIG;

  describe('keywordScore:查询长度自适应 sigmoid 归一', () => {
    it('值落在 (0,1) 开区间', () => {
      expect(keywordScore(1, 1, cfg)).toBeGreaterThan(0);
      expect(keywordScore(1, 1, cfg)).toBeLessThan(1);
      expect(keywordScore(5, 5, cfg)).toBeLessThan(1);
    });

    it('单 token 查询:命中即过中点(raw=1,m=1 → 0.5)', () => {
      // m = clamp(ceil(1·0.5),1,1) = 1;raw-m=0 → sigmoid(0)=0.5,与陡度无关。
      expect(keywordScore(1, 1, cfg)).toBeCloseTo(0.5, 6);
    });

    it('命中更多 token → 分更高(单调)', () => {
      const one = keywordScore(1, 3, cfg);
      const two = keywordScore(2, 3, cfg);
      const three = keywordScore(3, 3, cfg);
      expect(two).toBeGreaterThan(one);
      expect(three).toBeGreaterThan(two);
    });

    it('中点随查询长度自适应:长查询要求命中更多才过半分', () => {
      // 4-token 查询 m=clamp(ceil(4·0.5),1,4)=2;命中 1 个 < 中点 → <0.5,命中 2 个 = 中点 → =0.5。
      expect(keywordScore(1, 4, cfg)).toBeLessThan(0.5);
      expect(keywordScore(2, 4, cfg)).toBeCloseTo(0.5, 6);
    });

    it('陡度可配置(行为即配置,无 magic number)', () => {
      const steep = resolveMemoryConfig({ keywordSigmoidSteepness: 10 });
      const flat = resolveMemoryConfig({ keywordSigmoidSteepness: 0.5 });
      // 同 raw 偏离中点时,陡度大的更接近极值。
      expect(keywordScore(3, 3, steep)).toBeGreaterThan(keywordScore(3, 3, flat));
    });

    it('queryTokenCount<=0 → 0(防御)', () => {
      expect(keywordScore(0, 0, cfg)).toBe(0);
    });
  });

  describe('mixedRecallScore:自适应分母 + 零信号门控', () => {
    it('两路在场:取平均(自适应分母=2)', () => {
      const signals: RecallSignal[] = [
        { present: true, value: 0.8 },
        { present: true, value: 0.4 },
      ];
      expect(mixedRecallScore(signals)).toBeCloseTo(0.6, 6);
    });

    it('缺席信号不计入分母(不稀释)', () => {
      // 同样两个在场值 0.8/0.4,但额外挂一个缺席信号 → 仍 /2,不被稀释为 /3。
      const signals: RecallSignal[] = [
        { present: true, value: 0.8 },
        { present: true, value: 0.4 },
        { present: false, value: 0 }, // 缺席:不进分子也不进分母。
      ];
      expect(mixedRecallScore(signals)).toBeCloseTo(0.6, 6);
    });

    it('三路在场:分母自动扩到 3', () => {
      const signals: RecallSignal[] = [
        { present: true, value: 0.9 },
        { present: true, value: 0.6 },
        { present: true, value: 0.3 },
      ];
      expect(mixedRecallScore(signals)).toBeCloseTo(0.6, 6);
    });

    it('零信号门控:无在场信号 → 0', () => {
      expect(mixedRecallScore([{ present: false, value: 0.9 }])).toBe(0);
      expect(mixedRecallScore([])).toBe(0);
    });

    it('零信号门控:全部在场信号为 0 → 0(可被调用方丢弃)', () => {
      expect(
        mixedRecallScore([
          { present: true, value: 0 },
          { present: true, value: 0 },
        ]),
      ).toBe(0);
    });

    it('单路非零即非零(不学 mem0 硬丢)', () => {
      // 关键词为 0 但情感共振非零 → 仍得正分,不被门控丢。
      const score = mixedRecallScore([
        { present: true, value: 0 },
        { present: true, value: 0.7 },
      ]);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeCloseTo(0.35, 6);
    });

    it('min(·,1) 防御性封顶', () => {
      expect(
        mixedRecallScore([
          { present: true, value: 1 },
          { present: true, value: 1 },
        ]),
      ).toBe(1);
    });
  });

  describe('emotionSector / emotionResonance:Russell 扇区常量矩阵 O(1)', () => {
    it('近中性 / 低唤起归中性扇区 0', () => {
      expect(emotionSector({ pleasure: 0.05, arousal: 0.05 })).toBe(0);
      expect(emotionSector({ pleasure: 0.9, arousal: 0.05 })).toBe(0); // 低唤起 → 中性。
    });

    it('四象限映射(高兴/平静/愤怒/低落)', () => {
      expect(emotionSector({ pleasure: 0.8, arousal: 0.8 })).toBe(1); // +V+A 高兴
      expect(emotionSector({ pleasure: 0.8, arousal: -0.8 })).toBe(2); // +V-A 平静
      expect(emotionSector({ pleasure: -0.8, arousal: 0.8 })).toBe(3); // -V+A 愤怒
      expect(emotionSector({ pleasure: -0.8, arousal: -0.8 })).toBe(4); // -V-A 低落
    });

    it('矩阵对角线(同扇区)最高,值确定查表', () => {
      const happy: Pad = { pleasure: 0.8, arousal: 0.8, dominance: 0 };
      // 记忆侧也高兴 → 对角线 1.0。
      expect(emotionResonance(happy, { pleasure: 0.8, arousal: 0.8 })).toBeCloseTo(1.0, 6);
      // 记忆侧低落(对立)→ 矩阵[1][4]=0.2。
      expect(emotionResonance(happy, { pleasure: -0.8, arousal: -0.8 })).toBeCloseTo(0.2, 6);
    });

    it('记忆侧情感缺省 → 中性列(恒 0.5,本期 emotion_snapshot 未落库)', () => {
      const pad: Pad = { pleasure: -0.7, arousal: 0.6, dominance: 0 };
      // 记忆侧 emotion 缺省 → 扇区 0(中性列),矩阵任一行的第 0 列均 0.5。
      expect(emotionResonance(pad)).toBeCloseTo(0.5, 6);
    });

    it('矩阵形状 5×5、值域 [0,1]、对称对角线为 1', () => {
      expect(EMOTION_RESONANCE_MATRIX.length).toBe(5);
      for (let i = 0; i < 5; i++) {
        const row = EMOTION_RESONANCE_MATRIX[i]!;
        expect(row.length).toBe(5);
        for (const v of row) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
      // 非中性扇区对角线=1(同扇区最强共振)。
      for (let i = 1; i < 5; i++) expect(EMOTION_RESONANCE_MATRIX[i]![i]).toBe(1);
    });
  });

  describe('recallScore 仍是单一权威记忆强度路(未被改写)', () => {
    it('= importance × decay', () => {
      expect(recallScore(0.6, 0.5)).toBeCloseTo(0.3, 6);
    });
  });
});
