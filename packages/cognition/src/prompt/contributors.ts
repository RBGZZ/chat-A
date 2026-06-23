import { PROMPT_PRIORITY, DISSENT_ASSERTIVENESS } from './config';
import type { PromptContributor, PromptFragment, PromptContext } from './types';

/**
 * 三个内置 contributor(§5.4 / design D4):把现状 #composeSystem 三段拼接映射为接缝来源。
 * 升序拼接后顺序 = 骨架 → 记忆 → tone,与现状 parts 顺序、字面一致(对外等价基础)。
 */

/** 人格骨架:取 ctx.skeleton,priority 最小(靠前/最稳定),tier 'core'(每轮必注入、不参与裁剪)。 */
export class PersonaSkeletonContributor implements PromptContributor {
  contribute(ctx: PromptContext): PromptFragment | null {
    return { text: ctx.skeleton, priority: PROMPT_PRIORITY.personaSkeleton, tier: 'core' };
  }
}

/**
 * 记忆召回:ctx.recalled 非空时拼 `[与当前输入相关的记忆]\n- ...`(与现状字面一致),
 * 空则返回 null(等价现状"无召回不拼块");priority 中,外围档。
 */
export class MemoryRecallContributor implements PromptContributor {
  contribute(ctx: PromptContext): PromptFragment | null {
    if (ctx.recalled.length === 0) return null;
    const text = `[与当前输入相关的记忆]\n${ctx.recalled.map((r) => `- ${r.text}`).join('\n')}`;
    return { text, priority: PROMPT_PRIORITY.memoryRecall, tier: 'peripheral' };
  }
}

/** tone:取 ctx.toneFragment,priority 最大(靠近末尾/最近注意力),外围档。 */
export class ToneContributor implements PromptContributor {
  contribute(ctx: PromptContext): PromptFragment | null {
    return { text: ctx.toneFragment, priority: PROMPT_PRIORITY.tone, tier: 'peripheral' };
  }
}

/**
 * 异议(§7#3 会反对):据 ctx.stance(assertiveness + 命中观点)注入——
 * ① 反谄媚基线(由 assertiveness 分档:温和顺从档不注入,中等委婉,高档直接);
 * ② 命中观点时附"她的立场 + 不为迎合改立场"。无 stance 或温和顺从档无观点 → null。
 * 同步无 I/O(承接缝契约);priority 在 tone 之后,作为本轮最强 steer。
 */
export class DissentContributor implements PromptContributor {
  contribute(ctx: PromptContext): PromptFragment | null {
    const stance = ctx.stance;
    if (stance === undefined) return null;
    const a = stance.assertiveness;
    // 温和顺从档:不主动表达异议(即便话题命中也克制)。
    if (a < DISSENT_ASSERTIVENESS.submissiveCeil) return null;
    const strong = a >= DISSENT_ASSERTIVENESS.assertiveFloor;
    const baseline = strong
      ? '你有主见,别无脑同意。不认同就直接说出来并给出理由,不必怕扫兴——这是有自我,不是缺点。'
      : '你有自己的判断,不必为了迎合而附和;如果不认同,可以委婉但坦诚地说出你的看法。';
    const parts = [baseline];
    if (stance.notions.length > 0) {
      const list = stance.notions.join('；');
      parts.push(
        `关于这些你有自己的立场:${list}。若用户看法与你不同,坦诚表态、讲出理由,别为迎合改立场。`,
      );
    }
    return { text: `[立场]\n${parts.join('\n')}`, priority: PROMPT_PRIORITY.dissent, tier: 'peripheral' };
  }
}
