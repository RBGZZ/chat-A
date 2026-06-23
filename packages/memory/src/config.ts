import type { MemoryInput, MemorySubject, Pad, Person } from './types';

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
  /**
   * 关键词原始分归一 sigmoid 陡度 s(承 §5.5 混合召回 / §3.2):
   * `keywordScore = 1/(1+exp(-s·(raw-m)))`。s 越大越接近阶跃;默认 1.5(行为即配置,无 magic number)。
   */
  readonly keywordSigmoidSteepness: number;
  /**
   * 关键词归一 sigmoid 中点比例(承 §5.5):中点 `m = clamp(ceil(查询token数·此比例), 1, 查询token数)`。
   * 长查询要求命中更多 token 才算高分,随查询长度自适应;默认 0.5(过半命中即过中点)。
   */
  readonly keywordMidpointFraction: number;
  /**
   * 上下文窗口拼接的前后各取条数 N(承 §5.5「上下文窗口拼接」/ §3.2 行为即配置):
   * `recallWithContext` 把召回命中锚回 messages 时序后取前 N + 锚点 + 后 N 共至多 2N+1 条。
   * 默认 5(对齐 findings §4③「命中后额外取前后各 5 条」);无 magic number,可经 per-call 覆盖。
   */
  readonly contextWindowSize: number;
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
  // §5.5 混合召回打分归一参数(行为即配置,§3.2):关键词 sigmoid 陡度 1.5、中点比例 0.5(过半命中过中点)。
  keywordSigmoidSteepness: 1.5,
  keywordMidpointFraction: 0.5,
  // §5.5 上下文窗口前后各 N 条(行为即配置,§3.2):默认 5(对齐 findings §4③)。
  contextWindowSize: 5,
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
 * 记忆强度分(单一权威公式,承 §5.5):`score = importance × decay`。
 * 是混合召回里"记忆强度"那一路信号的值;importance∈[0,1]、decay∈(0,1] → 天然 ∈[0,1]。
 * P2 接入向量/FTS/情感分时在 `mixedRecallScore` 单点融合,本式与衰减/重要性式都不另起第二套。
 */
export function recallScore(importance: number, decay: number): number {
  return importance * decay;
}

// —— §5.5 混合召回:关键词归一 + 自适应分母混合 + 情感共振(单一权威,承 §3.2)——
// 全部纯函数,两 store 调用同一套,杜绝两后端各写一遍导致漂移。

/** [0,1] 夹取(局部小工具,避免散落)。 */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * 关键词原始分归一(单一权威公式,承 §5.5 mem0 `scoring.py` 思路):
 * 查询长度自适应 sigmoid `1/(1+exp(-s·(raw-m)))` 把无界命中数压到 [0,1]。
 * - `raw`:该候选命中的查询 token 去重数(本期 LIKE/includes;未来 FTS5 `bm25()` 同接入点)。
 * - 中点 `m = clamp(ceil(queryTokenCount·fraction), 1, queryTokenCount)`,随查询长度自适应:
 *   长查询要求命中更多 token 才算高分;单 token 查询 m=1,命中即过中点(>0.5)。
 * 向后兼容关键:单 token(或各候选命中数相同)时本分对所有候选恒定,排序仍由记忆强度驱动。
 */
export function keywordScore(
  raw: number,
  queryTokenCount: number,
  cfg: Pick<MemoryConfig, 'keywordSigmoidSteepness' | 'keywordMidpointFraction'>,
): number {
  if (queryTokenCount <= 0) return 0;
  const m = Math.min(
    Math.max(1, Math.ceil(queryTokenCount * cfg.keywordMidpointFraction)),
    queryTokenCount,
  );
  return 1 / (1 + Math.exp(-cfg.keywordSigmoidSteepness * (raw - m)));
}

/** 混合打分的一路信号:`present=false` 表示该路缺席(不计入自适应分母)。 */
export interface RecallSignal {
  /** 该路是否在场(缺席则不进分子也不进分母,自适应分母,承 §5.5)。 */
  readonly present: boolean;
  /** 信号值,约定 ∈[0,1](缺席时忽略)。 */
  readonly value: number;
}

/**
 * 混合召回得分(单一权威融合式,承 §5.5):自适应分母 `min(Σ在场信号 / 在场信号数, 1)`。
 * - **自适应分母**:只除以"在场信号数",某路缺席时分母自动缩 → 不被不存在的信号稀释。
 * - **零信号门控**:无任何在场信号、或全部在场信号为 0 → 返回 0(调用方据此可门控丢弃)。
 *   注意门控只对"零信号"生效;关键词/情感单路非零即把项拉进候选(别学 mem0 语义硬丢)。
 * - 每路值已 ∈[0,1],平均后仍 ∈[0,1],`min(·,1)` 仅防御性封顶。
 */
export function mixedRecallScore(signals: readonly RecallSignal[]): number {
  let sum = 0;
  let count = 0;
  for (const s of signals) {
    if (!s.present) continue;
    sum += s.value;
    count += 1;
  }
  if (count === 0) return 0;
  return Math.min(sum / count, 1);
}

// —— 情感共振:PAD/Russell 扇区常量矩阵(O(1) 查表,承 §5.5)——
// PAD 类型见 types.ts(memory 包本地定义,不跨包 import persona,§3.1)。

/**
 * Russell 2D(valence×arousal)情感扇区(承 §5.5):4 象限 + 中性。
 * 0=neutral(低唤起或近中性)、1=高兴(+V+A)、2=平静(+V-A)、3=愤怒/紧张(-V+A)、4=低落(-V-A)。
 */
export const EMOTION_SECTOR_COUNT = 5;

/**
 * 情感共振常量矩阵(承 §5.5,5×5,行=当前 PAD 扇区、列=记忆情感扇区):对角线(同扇区)高、
 * 邻接中、对立低;中性行/列居中。值 ∈[0,1],O(1) 查表。外置为常量,非散落 magic number。
 */
export const EMOTION_RESONANCE_MATRIX: readonly (readonly number[])[] = [
  //          neu   高兴   平静   愤怒   低落
  /* neu  */ [0.5, 0.5, 0.5, 0.5, 0.5],
  /* 高兴 */ [0.5, 1.0, 0.7, 0.3, 0.2],
  /* 平静 */ [0.5, 0.7, 1.0, 0.2, 0.4],
  /* 愤怒 */ [0.5, 0.3, 0.2, 1.0, 0.6],
  /* 低落 */ [0.5, 0.2, 0.4, 0.6, 1.0],
];

/**
 * 把一个 PAD/VA 投影到 Russell 扇区(单一权威映射,承 §5.5)。
 * 低唤起(|arousal| 小)或近中性(|pleasure| 小)归 neutral;否则按 (pleasure,arousal) 象限分。
 * 阈值用配置外置的"中性带半宽"——这里用固定的小常量 0.15 作为近中性带(行为即配置可后续提取)。
 */
export function emotionSector(va: Pick<Pad, 'pleasure' | 'arousal'>): number {
  const NEUTRAL_BAND = 0.15; // 近中性带半宽(§5.5;过小幅情感视作中性,免噪声扰动排序)。
  if (Math.abs(va.pleasure) < NEUTRAL_BAND && Math.abs(va.arousal) < NEUTRAL_BAND) return 0;
  if (Math.abs(va.arousal) < NEUTRAL_BAND) return 0; // 低唤起 → 视作中性扇区。
  if (va.pleasure >= 0) return va.arousal >= 0 ? 1 : 2; // +V:高唤起=高兴,低唤起=平静。
  return va.arousal >= 0 ? 3 : 4; // -V:高唤起=愤怒/紧张,低唤起=低落。
}

/**
 * 情感共振分(单一权威 O(1) 查表,承 §5.5):当前 PAD 扇区 × 记忆情感扇区 → 矩阵值 ∈[0,1]。
 * 记忆侧情感(`memoryEmotion`)本期可缺(v4 `emotion_snapshot` 列 P2 才落库)→ 缺省按中性扇区,
 * 取矩阵中性列(恒 0.5),不主导排序。P2 接入 `emotion_snapshot` 后同接缝增强,矩阵/公式不变。
 */
export function emotionResonance(pad: Pad, memoryEmotion?: Pick<Pad, 'pleasure' | 'arousal'>): number {
  const cur = emotionSector(pad);
  const mem = memoryEmotion === undefined ? 0 : emotionSector(memoryEmotion);
  const row = EMOTION_RESONANCE_MATRIX[cur] ?? EMOTION_RESONANCE_MATRIX[0]!;
  return clamp01(row[mem] ?? 0.5);
}

// —— §5.5 上下文窗口拼接:时间戳就近锚定 + 取窗区间(单一权威纯函数,两实现共用,§3.2)——
// 内存与 SQLite 两实现都调用这两个纯函数把召回命中锚回 messages 时序并切窗,杜绝两后端各写一遍。

/**
 * 时间戳就近锚点(单一权威,承 §5.5):在按时序升序排列的消息时间戳数组里,
 * 返回与记忆 `createdAtMs` 距离最小的那条的下标(记忆形成时所处的对话时刻)。
 * **同距取较早**(较小下标)做确定性兜底;空数组返回 -1。
 * 入参 `timestamps` 约定已按对话时序升序(调用方保证:内存即写入序、SQLite `ORDER BY id`)。
 */
export function anchorIndex(timestamps: readonly number[], memoryCreatedAtMs: number): number {
  if (timestamps.length === 0) return -1;
  let best = 0;
  let bestDist = Math.abs((timestamps[0] ?? 0) - memoryCreatedAtMs);
  for (let i = 1; i < timestamps.length; i++) {
    const dist = Math.abs((timestamps[i] ?? 0) - memoryCreatedAtMs);
    // 严格小于才更新:同距保留更早(更小)下标(确定性兜底)。
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * 取窗区间(单一权威,承 §5.5):锚点下标 `anchor` 前后各 N 条 → 半开区间 `[start, end)`。
 * `start = max(0, anchor − n)`、`end = min(total, anchor + n + 1)`,越界自然夹取(边界收窄)。
 * `anchor < 0`(无锚点)返回空区间 `[0, 0)`;`n` 取非负(负数视作 0,窗口只含锚点)。
 */
export function windowRange(
  anchor: number,
  total: number,
  n: number,
): { readonly start: number; readonly end: number } {
  if (anchor < 0 || total <= 0) return { start: 0, end: 0 };
  const radius = Math.max(0, n);
  const start = Math.max(0, anchor - radius);
  const end = Math.min(total, anchor + radius + 1);
  return { start, end };
}
