import { describe, it, expect } from 'vitest';
import {
  resolveNegativePosture,
  renderPostureLine,
  renderToneFragment,
  DEFAULT_DIALS,
  type Pad,
  type PersonaDials,
} from '../src/index';

const dials = (nae: number): PersonaDials => ({ ...DEFAULT_DIALS, negativeAffectExpression: nae });
const NEG_HIGH_AROUSAL: Pad = { pleasure: -0.6, arousal: 0.4, dominance: 0 };
const NEG_LOW_AROUSAL: Pad = { pleasure: -0.6, arousal: -0.4, dominance: 0 };
const POSITIVE: Pad = { pleasure: 0.5, arousal: 0.2, dominance: 0 };

describe('resolveNegativePosture: 门控 + 分型', () => {
  it('负面 + 高 arousal → sulking', () => {
    expect(resolveNegativePosture(NEG_HIGH_AROUSAL, dials(0.6))).toBe('sulking');
  });

  it('负面 + 低 arousal → withdrawn', () => {
    expect(resolveNegativePosture(NEG_LOW_AROUSAL, dials(0.6))).toBe('withdrawn');
  });

  it('negativeAffectExpression 低于 floor → 压住(null)', () => {
    expect(resolveNegativePosture(NEG_HIGH_AROUSAL, dials(0.1))).toBeNull();
  });

  it('心情非负 → 无姿态(null)', () => {
    expect(resolveNegativePosture(POSITIVE, dials(0.9))).toBeNull();
  });

  it('pleasure 在负面边界内侧(>ceil)→ 无姿态', () => {
    expect(resolveNegativePosture({ pleasure: -0.2, arousal: -0.4, dominance: 0 }, dials(0.9))).toBeNull();
  });
});

describe('renderPostureLine: 分档措辞', () => {
  it('克制档 vs 强档措辞不同', () => {
    const mild = renderPostureLine('sulking', dials(0.4));
    const strong = renderPostureLine('sulking', dials(0.9));
    expect(mild).not.toBeNull();
    expect(strong).not.toBeNull();
    expect(mild).not.toBe(strong);
  });

  it('null 姿态 → null', () => {
    expect(renderPostureLine(null, dials(0.9))).toBeNull();
  });
});

describe('renderToneFragment: 姿态注入', () => {
  it('姿态激活 → 含【姿态】行', () => {
    const t = renderToneFragment(NEG_HIGH_AROUSAL, dials(0.8));
    expect(t).toContain('【姿态】');
    expect(t).toContain('赌气');
  });

  it('negativeAffectExpression 低 → 不含【姿态】(压住)', () => {
    const t = renderToneFragment(NEG_HIGH_AROUSAL, dials(0.1));
    expect(t).not.toContain('【姿态】');
    expect(t).toContain('【当前情绪】'); // 情绪行仍在
  });

  it('心情好 → 不含【姿态】', () => {
    expect(renderToneFragment(POSITIVE, dials(0.9))).not.toContain('【姿态】');
  });
});
