/**
 * open-thread 主动跟进端口与领域类型(承 canonical §7#2「主动跟进未了话题 open threads」)。
 *
 * "你昨天说要面试,今天怎么样?"——比记住一百条事实更像伴侣。本切片 **standalone**:
 * 只定义最小端口接口 + 领域类型,**不依赖 `@chat-a/memory`**(§3.1 依赖倒置:技能只认接口,
 * 真实现以后由接线层用 memory 适配,不在本切片)。
 */

/**
 * 一条"未了话题"(open thread):用户提过、尚未闭合、值得日后回扣的事。
 * 字段保持最小且与 memory 解耦(以后接线层把 memory 记录映射成此形状):
 * - `id`:话题唯一标识(用于 cadence 现读"上次何时跟进过它"、去重、追溯)。
 * - `topic`:主题摘要(模板渲染用,如"面试")。
 * - `personId`:相关人物 id(文案主语用 person,承 §5.3 记忆带主语+花名册)。
 * - `personName`:相关人物花名册名(可选;有则文案直接称呼,无则回退到中性主语)。
 * - `lastMentionedAtMs`:用户上次提及此话题的时刻(毫秒;新鲜度/间隔判定用)。
 * - `dueAtMs`:可选的"到点该问了"时刻(毫秒;如面试约在明天 → 明天之后到 due)。
 */
export interface OpenThread {
  readonly id: string;
  readonly topic: string;
  readonly personId: string;
  readonly personName?: string;
  readonly lastMentionedAtMs: number;
  readonly dueAtMs?: number;
}

/**
 * open-thread 端口(承 §3.1 依赖倒置):技能经此读取候选未了话题。
 * 真实现以后由接线层用 `@chat-a/memory` 适配(查"未闭合事"记录);本切片用假实现单测。
 */
export interface OpenThreadPort {
  /** 列出当前所有候选未了话题(顺序不约束;技能内部自行排序/筛选)。 */
  listOpenThreads(): Promise<OpenThread[]>;
}
