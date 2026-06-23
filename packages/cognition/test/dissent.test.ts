import { describe, it, expect } from 'vitest';
import { DissentContributor, PROMPT_PRIORITY, type PromptContext } from '../src/index';

/** 造一个最小 PromptContext,只填 DissentContributor 关心的 stance(其余字段给空)。 */
function ctx(stance?: PromptContext['stance']): PromptContext {
  return { skeleton: '', recalled: [], toneFragment: '', userText: 'x', history: [], ...(stance ? { stance } : {}) };
}

describe('cognition/DissentContributor (§7#3)', () => {
  const c = new DissentContributor();

  it('有观点 + 高 assertiveness → 强基线 + 观点段,priority=dissent', () => {
    const f = c.contribute(ctx({ assertiveness: 0.8, notions: ['手冲比速溶值得。'] }));
    expect(f).not.toBeNull();
    expect(f!.priority).toBe(PROMPT_PRIORITY.dissent);
    expect(f!.text).toContain('手冲比速溶值得。');
    expect(f!.text).toContain('别为迎合改立场');
    expect(f!.text).toContain('直接说出来'); // 强档措辞
  });

  it('无观点 + 中等 assertiveness → 仅基线(委婉),无观点段', () => {
    const f = c.contribute(ctx({ assertiveness: 0.4, notions: [] }));
    expect(f).not.toBeNull();
    expect(f!.text).toContain('委婉');
    expect(f!.text).not.toContain('关于这些');
  });

  it('最低档(温和顺从)+ 无观点 → null', () => {
    expect(c.contribute(ctx({ assertiveness: 0.1, notions: [] }))).toBeNull();
  });

  it('温和顺从档即便有观点也克制(null)', () => {
    expect(c.contribute(ctx({ assertiveness: 0.1, notions: ['某观点'] }))).toBeNull();
  });

  it('无 stance → null', () => {
    expect(c.contribute(ctx(undefined))).toBeNull();
  });

  it('措辞随 assertiveness 档位可观测变化(中 vs 高)', () => {
    const mid = c.contribute(ctx({ assertiveness: 0.4, notions: [] }))!.text;
    const high = c.contribute(ctx({ assertiveness: 0.9, notions: [] }))!.text;
    expect(mid).not.toBe(high);
  });
});
