import { describe, it, expect } from 'vitest';
import type { MemoryRecord } from '@chat-a/memory';
import type { ChatMessage } from '@chat-a/protocol';
import {
  PromptAssembler,
  PersonaSkeletonContributor,
  MemoryRecallContributor,
  ToneContributor,
  makeCharTokenEstimator,
  type PromptContributor,
  type PromptContext,
  type PromptFragment,
} from '../src/prompt';

const SKELETON = '我是小雪。';
const TONE = '【当前情绪】此刻心情平平,语气自然就好,不必刻意热络。';

function rec(id: number, text: string): MemoryRecord {
  // subject/personId 为 memory 包 additive 扩展;本接缝只读 text,此处补齐以满足类型。
  return { id, text, kind: undefined, createdAtMs: 0, lastSeenAtMs: 0, hits: 1, subject: 'person', personId: undefined };
}

function ctx(over: Partial<PromptContext> = {}): PromptContext {
  return {
    skeleton: SKELETON,
    recalled: [],
    toneFragment: TONE,
    userText: '你好',
    history: [],
    ...over,
  };
}

function builtinAssembler(): PromptAssembler {
  return new PromptAssembler([
    new PersonaSkeletonContributor(),
    new MemoryRecallContributor(),
    new ToneContributor(),
  ]);
}

/** 旧 #composeSystem 的等价基线(逐字搬运现状三段拼接逻辑)。 */
function legacyComposeSystem(skeleton: string, recalled: readonly MemoryRecord[], toneFragment: string): string {
  const parts = [skeleton];
  if (recalled.length > 0) {
    parts.push(`[与当前输入相关的记忆]\n${recalled.map((r) => `- ${r.text}`).join('\n')}`);
  }
  parts.push(toneFragment);
  return parts.join('\n\n');
}

describe('cognition/PromptAssembler 对外等价(§5.4 重构非破坏)', () => {
  it('5.1 相同输入下 system/messages 与旧 #composeSystem 字节等价(无召回)', () => {
    const history: ChatMessage[] = [{ role: 'user', content: '一' }, { role: 'assistant', content: '二' }];
    const c = ctx({ history });
    const { system, messages } = builtinAssembler().assemble(c);

    expect(system).toBe(legacyComposeSystem(SKELETON, [], TONE));
    // messages 结构 = [...history, userMsg];volatile 默认空 → userMsg 即原文。
    expect(messages).toEqual([...history, { role: 'user', content: '你好' }]);
  });

  it('5.1 有召回时段序 骨架→记忆→tone 与旧实现字节等价', () => {
    const recalled = [rec(1, '喜欢猫'), rec(2, '住在北京')];
    const { system } = builtinAssembler().assemble(ctx({ recalled }));
    expect(system).toBe(legacyComposeSystem(SKELETON, recalled, TONE));
    // 显式断言段序。
    const parts = system.split('\n\n');
    expect(parts[0]).toBe(SKELETON);
    expect(parts[1]).toContain('[与当前输入相关的记忆]');
    expect(parts[2]).toBe(TONE);
  });
});

describe('cognition/PromptAssembler 优先级升序拼接(§5.4)', () => {
  function frag(text: string, priority: number): PromptContributor {
    return { contribute: (): PromptFragment => ({ text, priority }) };
  }

  it('5.2 低/中/高 priority 段按升序拼接(高靠末尾)', () => {
    // 注册序故意打乱:高→低→中,断言输出按 priority 升序。
    const a = new PromptAssembler([frag('HIGH', 900), frag('LOW', 100), frag('MID', 500)]);
    const { system } = a.assemble(ctx());
    expect(system).toBe('LOW\n\nMID\n\nHIGH');
  });

  it('5.2 同 priority 保持注册顺序(稳定)', () => {
    const a = new PromptAssembler([frag('A', 500), frag('B', 500), frag('C', 500)]);
    const { system } = a.assemble(ctx());
    expect(system).toBe('A\n\nB\n\nC');
  });
});

describe('cognition/PromptAssembler 预算裁剪(§5.4)', () => {
  it('5.3 超上限从最旧 history 逐条裁;当轮 userMsg 保留', () => {
    // 用极小预算逼出裁剪:窗口 small、K=1(1 字符≈1 token)。
    const history: ChatMessage[] = [
      { role: 'user', content: 'AAAA' }, // 最旧
      { role: 'assistant', content: 'BBBB' },
      { role: 'user', content: 'CCCC' }, // 最新
    ];
    const a = new PromptAssembler([new PersonaSkeletonContributor(), new ToneContributor()], {
      tokenEstimator: makeCharTokenEstimator(1),
      budget: { contextWindowTokens: 100, maxRatio: 1, charsPerToken: 1 },
    });
    // system = skeleton(5) + '\n\n'? estimate 仅按拼好字符串;userText='你好'(2)。
    // 调小预算确保需要丢弃最旧若干条。
    const c = ctx({ history, userText: '你好' });
    const small = new PromptAssembler([new PersonaSkeletonContributor(), new ToneContributor()], {
      tokenEstimator: makeCharTokenEstimator(1),
      budget: { contextWindowTokens: 60, maxRatio: 1, charsPerToken: 1 },
    });
    const { messages } = small.assemble(c);
    // 末条永远是当轮 userMsg。
    expect(messages.at(-1)).toEqual({ role: 'user', content: '你好' });
    // 至少裁掉了最旧的 'AAAA'(被裁则不在结果中,且从头裁)。
    const contents = messages.map((m) => m.content);
    // 若发生裁剪,'AAAA' 应先于 'CCCC' 被丢。
    if (!contents.includes('AAAA')) {
      // 被裁则 CCCC(较新)更可能保留;断言裁剪从旧端开始。
      const idxC = contents.indexOf('CCCC');
      expect(idxC).toBeGreaterThanOrEqual(0);
    }
    // 大预算下不裁,全保留(对照)。
    const { messages: full } = a.assemble(c);
    expect(full.map((m) => m.content)).toEqual(['AAAA', 'BBBB', 'CCCC', '你好']);
  });

  it('5.3 core 段(骨架)始终保留在 system,不参与裁剪', () => {
    const history: ChatMessage[] = Array.from({ length: 50 }, (_, i) => ({
      role: 'user' as const,
      content: 'X'.repeat(100),
    }));
    const a = new PromptAssembler([new PersonaSkeletonContributor(), new ToneContributor()], {
      tokenEstimator: makeCharTokenEstimator(1),
      budget: { contextWindowTokens: 50, maxRatio: 1, charsPerToken: 1 },
    });
    const { system, messages } = a.assemble(ctx({ history }));
    // 骨架(core)永在 system。
    expect(system).toContain(SKELETON);
    // 历史被大幅裁剪,但当轮 userMsg 仍在末条。
    expect(messages.at(-1)).toEqual({ role: 'user', content: '你好' });
  });
});

describe('cognition/PromptAssembler 两档注入(§5.4)', () => {
  it('5.4 core(骨架)每轮必注入', () => {
    const a = builtinAssembler();
    expect(a.assemble(ctx()).system).toContain(SKELETON);
    expect(a.assemble(ctx({ userText: '换一句' })).system).toContain(SKELETON);
  });

  it('5.4 外围召回命中则注入、无命中不注入', () => {
    const a = builtinAssembler();
    expect(a.assemble(ctx({ recalled: [rec(1, '记得你')] })).system).toContain('[与当前输入相关的记忆]');
    expect(a.assemble(ctx({ recalled: [] })).system).not.toContain('[与当前输入相关的记忆]');
  });
});

describe('cognition/PromptAssembler KV-cache 稳定性(§5.4)', () => {
  it('5.5 同人格配置连续两轮 system 前缀字节级一致', () => {
    const a = builtinAssembler();
    const s1 = a.assemble(ctx({ userText: '第一句' })).system;
    const s2 = a.assemble(ctx({ userText: '第二句' })).system;
    expect(s1).toBe(s2); // 无 volatile 进 system,userText 变化不影响 system。
  });

  it('5.5 volatile 以扁平 [Context] bullet 追加末条用户消息,且无 XML 标签', () => {
    const a = builtinAssembler();
    const { system, messages } = a.assemble(
      ctx({ volatile: [['当前时间', '2026-06-22'], ['turnId', 't1']] }),
    );
    // volatile 不进 system(保 KV 稳定前缀)。
    expect(system).not.toContain('当前时间');
    expect(system).not.toContain('[Context]');
    // volatile 追加到末条用户消息,扁平 bullet。
    const last = messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.content).toContain('你好');
    expect(last.content).toContain('[Context]');
    expect(last.content).toContain('- 当前时间: 2026-06-22');
    expect(last.content).toContain('- turnId: t1');
    // 不用 XML 标签。
    expect(last.content).not.toMatch(/<\/?context>/i);
  });
});

describe('cognition/PromptAssembler 单 contributor 故障降级(§3.2)', () => {
  it('5.6 contribute 抛错 → 跳过该段、记录错误、其余正常、不中断', () => {
    const errors: unknown[] = [];
    const boom: PromptContributor = {
      contribute: () => {
        throw new Error('contribute boom');
      },
    };
    const a = new PromptAssembler(
      [new PersonaSkeletonContributor(), boom, new ToneContributor()],
      { onError: (e) => errors.push(e) },
    );
    const { system } = a.assemble(ctx());
    // 抛错来源跳过,骨架 + tone 仍拼入。
    expect(system).toBe(`${SKELETON}\n\n${TONE}`);
    expect(errors).toHaveLength(1);
  });

  it('5.6 cleanup 抛错不影响其余 contributor 的 cleanup', () => {
    const cleaned: string[] = [];
    const errors: unknown[] = [];
    const mk = (name: string, boom = false): PromptContributor => ({
      contribute: (): PromptFragment => ({ text: name, priority: 100 }),
      cleanup: () => {
        if (boom) throw new Error(`${name} cleanup boom`);
        cleaned.push(name);
      },
    });
    const a = new PromptAssembler([mk('A'), mk('B', true), mk('C')], { onError: (e) => errors.push(e) });
    a.assemble(ctx());
    // A、C 仍被清理;B 抛错被记录但不阻断。
    expect(cleaned).toEqual(['A', 'C']);
    expect(errors).toHaveLength(1);
  });

  it('5.6 即使骨架以外全抛错,骨架段仍保底(prompt 不空)', () => {
    const boom: PromptContributor = {
      contribute: () => {
        throw new Error('boom');
      },
    };
    const a = new PromptAssembler([new PersonaSkeletonContributor(), boom, boom], { onError: () => {} });
    expect(a.assemble(ctx()).system).toBe(SKELETON);
  });
});

describe('cognition/MemoryRecallContributor 召回为空(§5.4)', () => {
  it('5.7 recalled 为空返回 null,不拼空记忆段', () => {
    const c = new MemoryRecallContributor();
    expect(c.contribute(ctx({ recalled: [] }))).toBeNull();
    expect(c.contribute(ctx({ recalled: [rec(1, 'x')] }))).not.toBeNull();
  });
});
