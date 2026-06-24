import { describe, it, expect } from 'vitest';
import { ReAnchorContributor, PROMPT_PRIORITY, type PromptContext } from '../src/index';

/** 最小 PromptContext,只填 ReAnchorContributor 关心的 anchor。 */
function ctx(anchor?: PromptContext['anchor']): PromptContext {
  return { skeleton: '', recalled: [], toneFragment: '', userText: 'x', history: [], ...(anchor ? { anchor } : {}) };
}

describe('cognition/ReAnchorContributor (§6.1 自我一致性重锚)', () => {
  const c = new ReAnchorContributor();

  it('drift=true → 注入重锚段,priority=reAnchor,含锚点 + 保留个性语义', () => {
    const f = c.contribute(ctx({ drift: true, anchorText: '我叫小雪' }));
    expect(f).not.toBeNull();
    expect(f!.priority).toBe(PROMPT_PRIORITY.reAnchor);
    expect(f!.text).toContain('我叫小雪');
    expect(f!.text).toContain('自我一致性');
    // 放宽阈值的核心:重锚明确保留个性偏离。
    expect(f!.text).toContain('可以改主意');
    expect(f!.text).toContain('不同观点');
  });

  it('drift=true 但无 anchorText → 仍注入(无锚点行)', () => {
    const f = c.contribute(ctx({ drift: true }));
    expect(f).not.toBeNull();
    expect(f!.text).toContain('自我一致性');
  });

  it('drift=false → null(默认路径零注入)', () => {
    expect(c.contribute(ctx({ drift: false }))).toBeNull();
  });

  it('无 anchor → null', () => {
    expect(c.contribute(ctx(undefined))).toBeNull();
  });
});
