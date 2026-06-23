import type { MemoryInput, MemorySubject, Person } from './types';

/**
 * 记忆行为配置(行为即配置,§3.2):召回上限/滑窗大小/规范化规则全外置,无 magic number。
 */
export interface MemoryConfig {
  /** snapshot 默认条数(滑窗大小)。 */
  readonly snapshotLimit: number;
  /** recall 默认返回上限。 */
  readonly recallLimit: number;
  /** messagesForSession 默认返回上限(会话级沉淀读取本会话消息时用,§6.1)。 */
  readonly reflectionMessageLimit: number;
  /** 去重 / 关键词匹配的文本规范化(单一权威规则,勿引入多套漂移)。 */
  readonly normalize: (text: string) => string;
  /**
   * 主用户稳定标识(承 §5.3b / §3.2 行为即配置):seed 花名册与 person/shared
   * 记忆默认归属都用它;勿硬编码进迁移 SQL,经此注入保证确定性测试可固定。
   */
  readonly primaryPersonId: string;
  /** 主用户名(承 §5.3b):seed 花名册时写入,未配置用内置默认。 */
  readonly primaryPersonName: string;
  /**
   * 时间衰减半衰期(天,承 §5.5):衰减 `0.5^(days/H)` 的 H。
   * 行为即配置,无 magic number;默认 30 天(§5.5)。pinned 记忆免衰不受此影响。
   */
  readonly halfLifeDays: number;
  /**
   * 检索即强化系数 k(承 §5.5):命中升 importance `i += k·(1-i)`。
   * 单调趋近 1 但不超过 1;默认 0.18(OpenMemory `sal+=0.18·(1-sal)`)。
   */
  readonly reinforceK: number;
  /**
   * 新记忆的重要性初值(承 §5.5 / §3.2):写入与旧库 backfill 都用它。
   * 落在 [0,1];默认 0.5。
   */
  readonly initialImportance: number;
}

/** 默认规范化:去首尾空白、小写、空白折叠。去重与召回共用此规则。 */
export function defaultNormalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  snapshotLimit: 20,
  recallLimit: 5,
  // 沉淀读取本会话消息的上限:大于滑窗,尽量覆盖整段会话又不至失控(行为即配置,§3.2)。
  reflectionMessageLimit: 200,
  normalize: defaultNormalize,
  primaryPersonId: 'primary',
  primaryPersonName: '主人',
  // §5.5 单一权威衰减/强化参数:半衰期 30 天、强化系数 0.18、重要性初值 0.5(行为即配置,§3.2)。
  halfLifeDays: 30,
  reinforceK: 0.18,
  initialImportance: 0.5,
};

/** 合并用户覆盖与默认值。 */
export function resolveMemoryConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
  return { ...DEFAULT_MEMORY_CONFIG, ...overrides };
}

/**
 * 写入归属规则(单一权威,承 §5.3 / §5.3b):主语缺省 person;person/shared 缺省主用户,
 * agent 不关联人。两个 MemoryStore 实现共用此规则,避免规则在多后端间漂移(§3.1)。
 * 返回 personId 为 `string | undefined`;SQLite 绑定参数时自行 `?? null`。
 */
export function resolveAttribution(
  rec: Pick<MemoryInput, 'subject' | 'personId'>,
  cfg: MemoryConfig,
): { subject: MemorySubject; personId: string | undefined } {
  const subject: MemorySubject = rec.subject ?? 'person';
  const personId = subject === 'agent' ? undefined : (rec.personId ?? cfg.primaryPersonId);
  return { subject, personId };
}

/**
 * 构造主用户花名册条目(单一权威,承 §5.3b):`is_primary/status/added_by` 不变式集中于此,
 * 供 SQLite v3 迁移 seed 与 InMemory 构造共用,避免 TS 对象与 SQL 字面量两处各写一遍。
 */
export function makePrimaryPerson(cfg: MemoryConfig): Person {
  return {
    personId: cfg.primaryPersonId,
    name: cfg.primaryPersonName,
    isPrimary: true,
    status: 'primary',
    addedBy: 'user',
  };
}

/** 将查询切成关键词 token(规范化后按空白切;CJK 无空白时整串即一个 token)。 */
export function tokenize(query: string, normalize: (t: string) => string): string[] {
  const norm = normalize(query);
  if (norm.length === 0) return [];
  return norm.split(' ').filter((t) => t.length > 0);
}

// —— 衰减 / 重要性 / 检索即强化:单一权威公式(承 §5.5)——
// SQLite 与 InMemory 两实现都调用这些纯函数,杜绝两后端各写一遍导致漂移(§3.2 单一权威公式)。

/** 一天的毫秒数(衰减 days 换算的唯一来源,杜绝散落 magic number)。 */
export const MS_PER_DAY = 86_400_000;

/**
 * 时间衰减因子(单一权威公式,承 §5.5):`0.5^(days/H)`,惰性实时算、不写回。
 * pinned 记忆免衰(恒 1,承 §5 核心永不忘);days 取非负(时钟回拨/未来时间不致放大)。
 */
export function decayFactor(
  lastSeenAtMs: number,
  now: number,
  pinned: boolean,
  cfg: Pick<MemoryConfig, 'halfLifeDays'>,
): number {
  if (pinned) return 1;
  const days = Math.max(0, (now - lastSeenAtMs) / MS_PER_DAY);
  return 0.5 ** (days / cfg.halfLifeDays);
}

/**
 * 检索即强化:`importance := importance + k·(1 - importance)`(单一权威公式,承 §5.5)。
 * 单调趋近 1 但不超过 1(`1-importance` 随接近 1 衰减增量),天然封顶无需 clamp。
 */
export function reinforceImportance(
  importance: number,
  cfg: Pick<MemoryConfig, 'reinforceK'>,
): number {
  return importance + cfg.reinforceK * (1 - importance);
}

/**
 * 召回融合得分(单一权威融合式,承 §5.5):`score = importance × decay`。
 * P1 只含重要性 × 时间衰减;P2 接入向量/FTS/情感分时在此单点扩展,不另起第二套。
 */
export function recallScore(importance: number, decay: number): number {
  return importance * decay;
}
