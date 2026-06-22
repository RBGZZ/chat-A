import type { MemoryInput, MemorySubject, Person } from './types';

/**
 * 记忆行为配置(行为即配置,§3.2):召回上限/滑窗大小/规范化规则全外置,无 magic number。
 */
export interface MemoryConfig {
  /** snapshot 默认条数(滑窗大小)。 */
  readonly snapshotLimit: number;
  /** recall 默认返回上限。 */
  readonly recallLimit: number;
  /** 去重 / 关键词匹配的文本规范化(单一权威规则,勿引入多套漂移)。 */
  readonly normalize: (text: string) => string;
  /**
   * 主用户稳定标识(承 §5.3b / §3.2 行为即配置):seed 花名册与 person/shared
   * 记忆默认归属都用它;勿硬编码进迁移 SQL,经此注入保证确定性测试可固定。
   */
  readonly primaryPersonId: string;
  /** 主用户名(承 §5.3b):seed 花名册时写入,未配置用内置默认。 */
  readonly primaryPersonName: string;
}

/** 默认规范化:去首尾空白、小写、空白折叠。去重与召回共用此规则。 */
export function defaultNormalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  snapshotLimit: 20,
  recallLimit: 5,
  normalize: defaultNormalize,
  primaryPersonId: 'primary',
  primaryPersonName: '主人',
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
