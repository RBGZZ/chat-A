import { describe, it, expect } from 'vitest';
import {
  StyleDisciplineContributor,
  PROMPT_PRIORITY,
  STYLE_EXPRESSIVENESS,
  type PromptContext,
} from '../src/index';

/** 最小 PromptContext,只填 StyleDisciplineContributor 关心的 expressiveness(其余给空)。 */
function ctx(expressiveness?: number): PromptContext {
  return {
    skeleton: '',
    recalled: [],
    toneFragment: '',
    userText: 'x',
    history: [],
    ...(expressiveness !== undefined ? { expressiveness } : {}),
  };
}

describe('cognition/StyleDisciplineContributor (§7#4)', () => {
  const c = new StyleDisciplineContributor();

  it('每轮注入风格硬纪律,priority=style,tier=peripheral', () => {
    const f = c.contribute(ctx());
    expect(f).not.toBeNull();
    expect(f!.priority).toBe(PROMPT_PRIORITY.style);
    expect(f!.tier).toBe('peripheral');
    // 硬纪律关键句(禁自称AI / 别像写文章 / 别过度解释)。
    expect(f!.text).toContain('作为AI');
    expect(f!.text).toContain('像写文章');
    expect(f!.text).toContain('过度解释');
  });

  it('priority 落在 tone 之后、dissent 之前(高注意力区)', () => {
    expect(PROMPT_PRIORITY.style).toBeGreaterThan(PROMPT_PRIORITY.tone);
    expect(PROMPT_PRIORITY.style).toBeLessThan(PROMPT_PRIORITY.dissent);
  });

  it('expressiveness 三档文本互不相同,且硬纪律恒守', () => {
    const reserved = c.contribute(ctx(0.1))!.text; // < reservedCeil
    const neutral = c.contribute(ctx(0.5))!.text; // 中性
    const expressive = c.contribute(ctx(0.9))!.text; // >= expressiveFloor
    expect(reserved).not.toBe(neutral);
    expect(neutral).not.toBe(expressive);
    expect(reserved).not.toBe(expressive);
    // 硬纪律三档均在。
    for (const t of [reserved, neutral, expressive]) {
      expect(t).toContain('作为AI');
      expect(t).toContain('像写文章');
    }
  });

  it('外放档放开口头禅/语气词,含蓄档收敛(可观测差异)', () => {
    const reserved = c.contribute(ctx(STYLE_EXPRESSIVENESS.reservedCeil - 0.01))!.text;
    const expressive = c.contribute(ctx(STYLE_EXPRESSIVENESS.expressiveFloor + 0.01))!.text;
    expect(reserved).toContain('克制');
    expect(expressive).toContain('外放');
  });

  it('缺省 expressiveness → 回落中性档(等同显式中性区值)', () => {
    const def = c.contribute(ctx())!.text;
    const mid = (STYLE_EXPRESSIVENESS.reservedCeil + STYLE_EXPRESSIVENESS.expressiveFloor) / 2;
    const neutral = c.contribute(ctx(mid))!.text;
    expect(def).toBe(neutral);
  });
});
