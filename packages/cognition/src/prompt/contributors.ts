import { PROMPT_PRIORITY } from './config';
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
