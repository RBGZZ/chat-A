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
// 低唤起 + 高支配 → cold(掌控感强、克制疏远)。
const NEG_LOW_AROUSAL_HIGH_DOM: Pad = { pleasure: -0.6, arousal: -0.4, dominance: 0.6 };
const POSITIVE: Pad = { pleasure: 0.5, arousal: 0.2, dominance: 0 };

describe('resolveNegativePosture: 门控 + 分型', () => {
  it('负面 + 高 arousal → sulking', () => {
    expect(resolveNegativePosture(NEG_HIGH_AROUSAL, dials(0.6))).toBe('sulking');
  });

  it('负面 + 低 arousal + 低支配 → withdrawn', () => {
    expect(resolveNegativePosture(NEG_LOW_AROUSAL, dials(0.6))).toBe('withdrawn');
  });

  it('负面 + 低 arousal + 高支配 → cold', () => {
    expect(resolveNegativePosture(NEG_LOW_AROUSAL_HIGH_DOM, dials(0.6))).toBe('cold');
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

describe('negativeAffectExpression 门控触发阈值(旋钮接线①)', () => {
  // 一个"轻度负面"心情:旋钮高时该摆姿态,旋钮低(但≥floor)时阈值更严 → 压住。
  const MILD_NEG: Pad = { pleasure: -0.45, arousal: 0.4, dominance: 0 };

  it('=0(<floor)→ 即便深度负面也完全压制(亲社会)', () => {
    expect(resolveNegativePosture(NEG_HIGH_AROUSAL, dials(0))).toBeNull();
    expect(resolveNegativePosture(NEG_LOW_AROUSAL, dials(0))).toBeNull();
    expect(resolveNegativePosture(NEG_LOW_AROUSAL_HIGH_DOM, dials(0))).toBeNull();
  });

  it('=1 → 完整表达:轻度负面也触发姿态', () => {
    expect(resolveNegativePosture(MILD_NEG, dials(1))).toBe('sulking');
  });

  it('旋钮越高触发阈值越宽松:同一轻度负面,低档压住、高档触发', () => {
    expect(resolveNegativePosture(MILD_NEG, dials(0.25))).toBeNull(); // 阈值更严(需更深负面)
    expect(resolveNegativePosture(MILD_NEG, dials(0.95))).toBe('sulking'); // 阈值宽松
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

  it('cold 姿态注入 → 含【姿态】行且为冷硬措辞', () => {
    const t = renderToneFragment(NEG_LOW_AROUSAL_HIGH_DOM, dials(0.8));
    expect(t).toContain('【姿态】');
    expect(t).toContain('冷'); // 冷硬措辞
  });

  it('tone fragment 强度随旋钮变化(克制档 vs 强档不同)', () => {
    // 深度负面 PAD(pleasure 足够低,低档也过触发阈值),旋钮强度不同 → 姿态措辞不同(克制 vs 完整表达)。
    const DEEP_NEG: Pad = { pleasure: -0.9, arousal: 0.4, dominance: 0 };
    const mild = renderToneFragment(DEEP_NEG, dials(0.3));
    const strong = renderToneFragment(DEEP_NEG, dials(0.9));
    expect(mild).toContain('【姿态】');
    expect(strong).toContain('【姿态】');
    expect(mild).not.toBe(strong);
  });
});
