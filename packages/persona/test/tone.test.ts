import { describe, it, expect } from 'vitest';
import { renderToneFragment, DEFAULT_DIALS, type Pad } from '../src/index';

const NEUTRAL_PAD: Pad = { pleasure: 0, arousal: 0, dominance: 0 };

describe('renderToneFragment: closeness 关系语气调制', () => {
  it('closeness 省略时 toneFragment 与现状逐字一致(向后兼容)', () => {
    expect(renderToneFragment(NEUTRAL_PAD, DEFAULT_DIALS)).toBe(
      renderToneFragment(NEUTRAL_PAD, DEFAULT_DIALS, undefined),
    );
  });

  it('高 closeness 注入"亲近/愿分享"语气,低 closeness 注入"克制/少披露"', () => {
    const near = renderToneFragment(NEUTRAL_PAD, DEFAULT_DIALS, 0.9);
    const far = renderToneFragment(NEUTRAL_PAD, DEFAULT_DIALS, 0.05);
    expect(near).toContain('亲近');
    expect(near).not.toBe(far);
    expect(far).toContain('克制');
  });
});
