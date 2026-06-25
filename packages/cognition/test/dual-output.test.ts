import { describe, it, expect } from 'vitest';
import {
  DualOutputContributor,
  DUAL_OUTPUT_SENTINEL,
  extractDisplaySegment,
  PROMPT_PRIORITY,
  type PromptContext,
} from '../src/index';

/** 最小 PromptContext,只填 DualOutputContributor 关心的 dualOutput(其余给空)。 */
function ctx(dualOutput?: { displayLang: string; spokenLang: string }): PromptContext {
  return {
    skeleton: '',
    recalled: [],
    toneFragment: '',
    userText: 'x',
    history: [],
    ...(dualOutput !== undefined ? { dualOutput } : {}),
  };
}

describe('cognition/DualOutputContributor (§4.1 双语原生输出)', () => {
  const c = new DualOutputContributor();

  it('dualOutput 非空 → 注入双语格式指令(含哨兵、两语种),priority=dualOutput,tier=peripheral', () => {
    const f = c.contribute(ctx({ displayLang: 'zh', spokenLang: 'ja' }));
    expect(f).not.toBeNull();
    expect(f!.priority).toBe(PROMPT_PRIORITY.dualOutput);
    expect(f!.tier).toBe('peripheral');
    expect(f!.text).toContain(DUAL_OUTPUT_SENTINEL);
    expect(f!.text).toContain('zh');
    expect(f!.text).toContain('ja');
  });

  it('dualOutput 缺省 → null(零注入,回归绿)', () => {
    expect(c.contribute(ctx())).toBeNull();
  });

  it('任一语种为空 → null(零注入,安全降级)', () => {
    expect(c.contribute(ctx({ displayLang: '', spokenLang: 'ja' }))).toBeNull();
    expect(c.contribute(ctx({ displayLang: 'zh', spokenLang: '  ' }))).toBeNull();
  });

  it('priority 放最末(>reAnchor,格式指令注意力最近)', () => {
    expect(PROMPT_PRIORITY.dualOutput).toBeGreaterThan(PROMPT_PRIORITY.reAnchor);
  });
});

describe('cognition/extractDisplaySegment (取显示段=哨兵后,音频优先排序,§4.1 / 🔴-2)', () => {
  it('有哨兵 → 取哨兵**后**并 trim(口语在前、显示在后)', () => {
    expect(extractDisplaySegment(`こんにちは\n${DUAL_OUTPUT_SENTINEL}\n你好呀`)).toBe('你好呀');
  });
  it('哨兵在同一行内', () => {
    expect(extractDisplaySegment(`口语段${DUAL_OUTPUT_SENTINEL}显示段`)).toBe('显示段');
  });
  it('无哨兵(模型没按格式)→ 原文 trim(等价不拆,降级安全)', () => {
    expect(extractDisplaySegment('  普通整段回复  ')).toBe('普通整段回复');
  });
});
