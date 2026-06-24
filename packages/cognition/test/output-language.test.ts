import { describe, it, expect } from 'vitest';
import { OutputLanguageContributor, PROMPT_PRIORITY, type PromptContext } from '../src/index';

/** 最小 PromptContext,只填 OutputLanguageContributor 关心的 outputLang(其余给空)。 */
function ctx(outputLang?: string): PromptContext {
  return {
    skeleton: '',
    recalled: [],
    toneFragment: '',
    userText: 'x',
    history: [],
    ...(outputLang !== undefined ? { outputLang } : {}),
  };
}

describe('cognition/OutputLanguageContributor (§4.1 输出语种)', () => {
  const c = new OutputLanguageContributor();

  it('outputLang 非空 → 注入目标语种指令,priority=outputLanguage,tier=peripheral', () => {
    const f = c.contribute(ctx('zh'));
    expect(f).not.toBeNull();
    expect(f!.priority).toBe(PROMPT_PRIORITY.outputLanguage);
    expect(f!.tier).toBe('peripheral');
    expect(f!.text).toContain('zh');
    expect(f!.text).toContain('回复');
  });

  it('outputLang 缺省 → null(零注入,回归绿)', () => {
    expect(c.contribute(ctx())).toBeNull();
  });

  it('outputLang 为空/纯空白 → null(零注入)', () => {
    expect(c.contribute(ctx(''))).toBeNull();
    expect(c.contribute(ctx('   '))).toBeNull();
  });

  it('priority 介于 style 与 dissent 之间(高注意力区、立场压轴)', () => {
    expect(PROMPT_PRIORITY.outputLanguage).toBeGreaterThan(PROMPT_PRIORITY.style);
    expect(PROMPT_PRIORITY.outputLanguage).toBeLessThan(PROMPT_PRIORITY.dissent);
  });
});
