import { PROMPT_PRIORITY, DISSENT_ASSERTIVENESS, STYLE_EXPRESSIVENESS } from './config';
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

/**
 * 对话风格纪律(§7#4 真实对话纪律):每轮注入"像真人朋友那样说话"的生成纪律,作为每轮主动 steer
 * (骨架靠前易被长对话稀释,这里放高注意力档补一道)。硬纪律恒守,口头禅/语气词放开程度由
 * expressiveness 外置分档微调(无 magic number)。同步无 I/O(承缝契约);priority 在 tone 之后、
 * dissent 之前;tier='peripheral'(极端预算下可被裁,核心事实/记忆优先)。
 */
export class StyleDisciplineContributor implements PromptContributor {
  contribute(ctx: PromptContext): PromptFragment | null {
    // 三档恒守的硬纪律:风格底线,不随旋钮变化。
    const hard = [
      '说话像真人朋友,不像写文章:每次尽量一两句话,口语、自然。',
      '不要说"作为AI/作为助手"这类自指,也别提示自己是程序;就当你是你自己。',
      '别过度解释、别罗列要点、别长篇大论;一次只说重点,有来有回。',
    ];
    // 据 expressiveness 分档调"口头禅·语气词"放开程度(缺省回落中性档代表值)。
    const e = ctx.expressiveness ?? (STYLE_EXPRESSIVENESS.reservedCeil + STYLE_EXPRESSIVENESS.expressiveFloor) / 2;
    let flavor: string;
    if (e < STYLE_EXPRESSIVENESS.reservedCeil) {
      // 含蓄档:更克制,语气词点到为止。
      flavor = '语气克制内敛,少用语气词和口头禅,话更短一些。';
    } else if (e >= STYLE_EXPRESSIVENESS.expressiveFloor) {
      // 外放档:更外向,允许更多语气词/口头禅/接话。
      flavor = '可以外放些:多用"嗯""嗯嗯""哈哈"这类语气词接话,带点自己的口头禅,情绪写在脸上。';
    } else {
      // 中性档:自然为度。
      flavor = '语气自然,可以适当用"嗯""嗯嗯"接话、带点口头禅,别端着。';
    }
    return {
      text: `[说话方式]\n${[...hard, flavor].join('\n')}`,
      priority: PROMPT_PRIORITY.style,
      tier: 'peripheral',
    };
  }
}

/**
 * 重锚(§6.1 自我一致性锚定):仅当本轮 `ctx.anchor.drift === true`(回复疑似否定核心自我)时,
 * 注入一段**温和**重锚 steer——以确立过的自我为准、自然说回正,但**明确保留个性偏离**
 * (不同观点/改主意/新喜好不必收回)。无 anchor 或未漂移 → 返回 null(默认路径零注入)。
 * 同步无 I/O(承接缝契约);priority 在 dissent 之后(最强压轴),tier='peripheral'(极端预算下可裁,核心事实/记忆优先)。
 * **本期只注入下轮 steer,不改写/不截断已生成回复。**
 */
export class ReAnchorContributor implements PromptContributor {
  contribute(ctx: PromptContext): PromptFragment | null {
    const anchor = ctx.anchor;
    if (anchor === undefined || anchor.drift !== true) return null;
    const anchorLine =
      anchor.anchorText !== undefined && anchor.anchorText.trim().length > 0
        ? `你确立过的自我是:${anchor.anchorText.trim()}。`
        : '';
    const text = [
      '[自我一致性]',
      '你刚才的说法似乎和你确立过的核心自我不太一致。',
      anchorLine,
      '请以你确立过的自我为准,自然地把它说回正——别否定你是谁、你根本相信什么。',
      '注意:你完全可以有不同观点、可以改主意、可以有新喜好,那些不必收回;只是别推翻核心设定。',
    ]
      .filter((l) => l.length > 0)
      .join('\n');
    return { text, priority: PROMPT_PRIORITY.reAnchor, tier: 'peripheral' };
  }
}

/**
 * 输出语种(§4.1 输入/输出语种解绑):`ctx.outputLang` 非空时注入一句**温和、明确**的回复语种指令
 * ——无论用户用什么语言,小雪都用设定的目标语种回复(LLM 生成语言由 output_lang 决定)。
 * 为空/缺省 → 返回 null(默认路径零注入,系统提示逐字不变)。
 * priority 放高注意力区(style 之后、dissent 之前),tier='peripheral'(极端预算下可裁,核心事实/记忆优先)。
 * 同步无 I/O(承接缝契约)。只指示语种,不强加道德(用户自治)。
 */
export class OutputLanguageContributor implements PromptContributor {
  contribute(ctx: PromptContext): PromptFragment | null {
    const lang = ctx.outputLang?.trim();
    if (lang === undefined || lang.length === 0) return null; // 缺省零注入
    return {
      text: `[回复语种]\n无论用户用什么语言,你都始终用「${lang}」回复。`,
      priority: PROMPT_PRIORITY.outputLanguage,
      tier: 'peripheral',
    };
  }
}
