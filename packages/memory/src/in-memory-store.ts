import type {
  ChatMessage,
  MemoryInput,
  MemoryRecord,
  MemoryStore,
  MemorySubject,
  Person,
  StoredMessage,
} from './types';
import {
  decayFactor,
  makePrimaryPerson,
  recallScore,
  reinforceImportance,
  resolveAttribution,
  resolveMemoryConfig,
  tokenize,
  type MemoryConfig,
} from './config';

interface MutableRecord {
  id: number;
  text: string;
  normalized: string;
  kind: string | undefined;
  createdAtMs: number;
  lastSeenAtMs: number;
  hits: number;
  /** 主语(承 §5.3)。 */
  subject: MemorySubject;
  /** 人物归属(承 §5.3b);agent 主语为 undefined。 */
  personId: string | undefined;
  /** 重要性(承 §5.5);检索即强化随命中升高。 */
  importance: number;
  /** 累计被召回返回(被想起)次数(承 §5.5)。 */
  accessCount: number;
  /** 最近一次被召回返回的时间(承 §5.5 检索即强化审计)。 */
  lastAccessedAtMs: number;
  /** 是否核心记忆(承 §5);true 则免于时间衰减。 */
  pinned: boolean;
}

export interface InMemoryMemoryStoreOptions {
  readonly config?: Partial<MemoryConfig>;
  /** 注入时钟(确定性测试,§3.2)。 */
  readonly now?: () => number;
}

/**
 * 进程内记忆实现(承接旧 ConversationMemory 滑窗语义)。
 * 与 SqliteMemoryStore 满足同一 MemoryStore 契约;无持久化(重启即失忆,符合预期)。
 */
export class InMemoryMemoryStore implements MemoryStore {
  readonly #messages: StoredMessage[] = [];
  readonly #memories = new Map<string, MutableRecord>();
  readonly #state = new Map<string, string>();
  /** 人物花名册(镜像 SQLite people 表语义,承 §5.3b)。 */
  readonly #people = new Map<string, Person>();
  readonly #cfg: MemoryConfig;
  readonly #now: () => number;
  #seq = 0;

  constructor(opts: InMemoryMemoryStoreOptions = {}) {
    this.#cfg = resolveMemoryConfig(opts.config);
    this.#now = opts.now ?? Date.now;
    // 构造即 seed 主用户(镜像 SQLite v3 迁移 seed,P1 恰好一个;承 §5.3b)。
    const primary = makePrimaryPerson(this.#cfg);
    this.#people.set(primary.personId, primary);
  }

  appendMessage(msg: StoredMessage): void {
    this.#messages.push(msg);
  }

  snapshot(limit: number = this.#cfg.snapshotLimit): readonly ChatMessage[] {
    const start = Math.max(0, this.#messages.length - limit);
    return this.#messages.slice(start).map((m) => ({ role: m.role, content: m.content }));
  }

  messagesForSession(
    sessionId: string,
    limit: number = this.#cfg.reflectionMessageLimit,
  ): readonly ChatMessage[] {
    // 只取该会话消息(§6.1 沉淀),按时序取最近 N。
    const own = this.#messages.filter((m) => m.sessionId === sessionId);
    const start = Math.max(0, own.length - limit);
    return own.slice(start).map((m) => ({ role: m.role, content: m.content }));
  }

  addMemory(rec: MemoryInput): void {
    const normalized = this.#cfg.normalize(rec.text);
    if (normalized.length === 0) return;
    const at = rec.createdAtMs ?? this.#now();
    const existing = this.#memories.get(normalized);
    if (existing !== undefined) {
      existing.hits += 1;
      existing.lastSeenAtMs = at;
      return;
    }
    // 归属规则与 SQLite 共用单一权威 helper(承 §5.3 / §5.3b),避免两后端漂移。
    const { subject, personId } = resolveAttribution(rec, this.#cfg);
    this.#memories.set(normalized, {
      id: ++this.#seq,
      text: rec.text,
      normalized,
      kind: rec.kind,
      createdAtMs: at,
      lastSeenAtMs: at,
      hits: 1,
      subject,
      personId,
      // 评分列初值(承 §5.5):importance 缺省配置初值、access_count=0、last_accessed=创建时、pinned 缺省 false。
      importance: rec.importance ?? this.#cfg.initialImportance,
      accessCount: 0,
      lastAccessedAtMs: at,
      pinned: rec.pinned === true,
    });
  }

  recall(query: string, limit: number = this.#cfg.recallLimit): readonly MemoryRecord[] {
    const tokens = tokenize(query, this.#cfg.normalize);
    if (tokens.length === 0) return [];
    // 不按主语过滤:一次跨 person+agent+shared 召回(§5.3 末条),与 SQLite 行为一致。
    const hits = [...this.#memories.values()].filter((r) =>
      tokens.some((t) => r.normalized.includes(t)),
    );
    const now = this.#now();
    // 融合得分排序(承 §5.5):用 config.ts 单一权威公式算 score = importance × decay,与 SQLite 零漂移。
    // 衰减用强化前的值算,保证本次返回排序确定(强化只影响后续召回)。
    const scored = hits.map((r) => ({
      r,
      score: recallScore(r.importance, decayFactor(r.lastSeenAtMs, now, r.pinned, this.#cfg)),
    }));
    scored.sort((a, b) => b.score - a.score || b.r.hits - a.r.hits || b.r.id - a.r.id);
    const top = scored.slice(0, limit).map((s) => s.r);
    // 检索即强化:只对实际返回的 top-N 升 access_count/importance、更新 last_accessed(被想起→记得牢,§5.5)。
    const out = top.map((r) => ({
      id: r.id,
      text: r.text,
      kind: r.kind,
      createdAtMs: r.createdAtMs,
      lastSeenAtMs: r.lastSeenAtMs,
      hits: r.hits,
      subject: r.subject,
      personId: r.personId,
      importance: r.importance,
      accessCount: r.accessCount,
      pinned: r.pinned,
    }));
    for (const r of top) {
      r.accessCount += 1;
      r.importance = reinforceImportance(r.importance, this.#cfg);
      r.lastAccessedAtMs = now;
    }
    return out;
  }

  getState(key: string): string | undefined {
    return this.#state.get(key);
  }

  setState(key: string, value: string): void {
    this.#state.set(key, value);
  }

  close(): void {
    // 无资源可释放。
  }
}
