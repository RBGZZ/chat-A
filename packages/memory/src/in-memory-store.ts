import type {
  ChatMessage,
  MemoryInput,
  MemoryKind,
  MemoryRecord,
  MemoryStore,
  MemorySubject,
  Pad,
  Person,
  RecallByVectorOptions,
  RecallContextOptions,
  RecallHybridOptions,
  RecallKindOptions,
  RecallWithContext,
  RecalledMemory,
  StoredMessage,
} from './types';
import {
  anchorIndex,
  bumpClosenessValue,
  cosineSimilarity,
  decayCloseness,
  decayFactor,
  emotionResonance,
  entityKeys,
  hopDecay,
  makePrimaryPerson,
  memoryKindWeight,
  normalizeAndFuse,
  recallScore,
  reciprocalRankFusion,
  reinforceImportance,
  resolveAttribution,
  resolveMemoryConfig,
  resolveMemoryKind,
  tokenize,
  windowRange,
  type MemoryConfig,
  type RawRecallSignals,
  type RecallSignalWeights,
} from './config';

interface MutableRecord {
  id: number;
  text: string;
  normalized: string;
  kind: string | undefined;
  /** 情景/语义分层(承 §5.9 缺口④):episodic / semantic / core。 */
  memoryKind: MemoryKind;
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
  /** 是否标记为未闭合话题(承 §7#2);与是否已闭合(closedAtMs)正交。 */
  openThread: boolean;
  /** 闭合时间戳(承 §7#2);undefined=尚未闭合。镜像 SQLite closed_at 语义。 */
  closedAtMs: number | undefined;
  /**
   * 记忆向量(承 §5.6 接缝 7):调用方经 setEmbedding 传入的 number[];undefined=尚未嵌入(镜像 SQLite embedding NULL)。
   * 镜像"不透明存储"语义:in-memory 直接存数组(无需 BLOB 编解码),KNN 时按长度=dim 比对。
   */
  embedding: number[] | undefined;
}

/** 一条召回候选:可变记忆 + 其归一前多路原始信号(recall/recallHybrid 共用,承 §5.9 缺口③)。 */
type Cand = {
  readonly r: MutableRecord;
  readonly raw: RawRecallSignals;
};

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
  /** id → 记忆(镜像 SQLite 主键索引;供 setEmbedding 按 id 定位,承 §5.6)。 */
  readonly #byIdIndex = new Map<number, MutableRecord>();
  readonly #state = new Map<string, string>();
  /** 人物花名册(镜像 SQLite people 表语义,承 §5.3b)。 */
  readonly #people = new Map<string, Person>();
  /** 实体键 → 拥有该键的记忆 id 集合(镜像 SQLite memory_entities,承 §5.9 缺口①)。 */
  readonly #entityIndex = new Map<string, Set<number>>();
  /** 无向邻接边:`min:max` → 权重(镜像 SQLite memory_edges,承 §5.9 缺口①)。 */
  readonly #edgeWeight = new Map<string, number>();
  /** 记忆 id → 邻居 id 集合(扩散遍历用;镜像 SQLite 双向索引)。 */
  readonly #adjacency = new Map<number, Set<number>>();
  /**
   * 关系亲密度状态:personId → `{closeness, updatedAtMs}`(镜像 SQLite people.relationship_state JSON,承 §6/§5.3b)。
   * 无条目 = 尚无互动记录(getCloseness 落到 initialCloseness);存数值快照,惰性衰减读时实时算、不写回。
   */
  readonly #closeness = new Map<string, { closeness: number; updatedAtMs: number }>();
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

  addMemory(rec: MemoryInput): number {
    const normalized = this.#cfg.normalize(rec.text);
    if (normalized.length === 0) return -1;
    const at = rec.createdAtMs ?? this.#now();
    const existing = this.#memories.get(normalized);
    if (existing !== undefined) {
      existing.hits += 1;
      existing.lastSeenAtMs = at;
      // 去重命中:返回被强化的那条 id(承 §5.6;镜像 SQLite 语义,补嵌复用既有向量)。
      return existing.id;
    }
    // 归属规则与 SQLite 共用单一权威 helper(承 §5.3 / §5.3b),避免两后端漂移。
    const { subject, personId } = resolveAttribution(rec, this.#cfg);
    // 情景/语义分层(承 §5.9 缺口④):缺省 episodic;core ⟹ pinned(永不衰减,承 §5.4)。与 SQLite 共用单一权威。
    const { memoryKind, pinned } = resolveMemoryKind(rec, this.#cfg);
    const id = ++this.#seq;
    const record: MutableRecord = {
      id,
      text: rec.text,
      normalized,
      kind: rec.kind,
      memoryKind,
      createdAtMs: at,
      lastSeenAtMs: at,
      hits: 1,
      subject,
      personId,
      // 评分列初值(承 §5.5):importance 缺省配置初值、access_count=0、last_accessed=创建时。
      importance: rec.importance ?? this.#cfg.initialImportance,
      accessCount: 0,
      lastAccessedAtMs: at,
      pinned,
      // 未闭合话题(承 §7#2):缺省非未了事、未闭合(镜像 SQLite open_thread=0 / closed_at=NULL)。
      openThread: rec.openThread === true,
      closedAtMs: undefined,
      // 向量缺省 undefined(尚未嵌入,镜像 SQLite embedding NULL,承 §5.6)。
      embedding: undefined,
    };
    this.#memories.set(normalized, record);
    this.#byIdIndex.set(id, record);
    // 联想扩散地基(承 §5.9 缺口①):建实体索引 + 与共享实体的旧记忆增建无向邻接边。
    this.#linkEntitiesAndEdges(id, rec.text, personId);
    // 返回新建记忆 id(承 §5.6:供编排层随后 setEmbedding 补嵌)。
    return id;
  }

  /**
   * 建实体索引 + 邻接边(承 §5.9 缺口①):与 SQLite linkEntitiesAndEdges 同一权威规则(零漂移)。
   * 共享实体(非主用户的 person_id + 规范化 token)的记忆对之间,边权按共享键数累加。
   */
  #linkEntitiesAndEdges(memoryId: number, text: string, personId: string | undefined): void {
    const keys = entityKeys(text, personId, this.#cfg.normalize, this.#cfg.primaryPersonId);
    for (const key of keys) {
      let owners = this.#entityIndex.get(key);
      if (owners === undefined) {
        owners = new Set<number>();
        this.#entityIndex.set(key, owners);
      }
      // 对已挂该键的旧记忆逐一增建/增强无向边(自反跳过)。
      for (const other of owners) {
        if (other === memoryId) continue;
        const a = Math.min(memoryId, other);
        const b = Math.max(memoryId, other);
        const edgeKey = `${a}:${b}`;
        this.#edgeWeight.set(edgeKey, (this.#edgeWeight.get(edgeKey) ?? 0) + 1);
        this.#addAdjacency(a, b);
        this.#addAdjacency(b, a);
      }
      owners.add(memoryId);
    }
  }

  #addAdjacency(from: number, to: number): void {
    let set = this.#adjacency.get(from);
    if (set === undefined) {
      set = new Set<number>();
      this.#adjacency.set(from, set);
    }
    set.add(to);
  }

  /**
   * 沿邻接图扩散(承 §5.9 缺口①):从一阶命中 id 出发 1..maxHops 跳 BFS,
   * 返回每个被联想到的额外记忆 id → 其最小跳数(BFS 先到即最小)。一阶种子(hop=0)不计入。
   * 与 SQLite #spread 同一权威遍历语义(两实现零漂移)。
   */
  #spread(seedIds: readonly number[], maxHops: number): Map<number, number> {
    const hopOf = new Map<number, number>();
    if (maxHops <= 0 || seedIds.length === 0) return hopOf;
    const seed = new Set(seedIds);
    let frontier: number[] = [...seedIds];
    for (let hop = 1; hop <= maxHops; hop++) {
      const next: number[] = [];
      for (const id of frontier) {
        const neighbors = this.#adjacency.get(id);
        if (neighbors === undefined) continue;
        for (const other of neighbors) {
          if (seed.has(other)) continue;
          if (hopOf.has(other)) continue;
          hopOf.set(other, hop);
          next.push(other);
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    return hopOf;
  }

  recall(
    query: string,
    limit: number = this.#cfg.recallLimit,
    pad?: Pad,
    kindOptions?: RecallKindOptions,
  ): readonly MemoryRecord[] {
    const tokens = tokenize(query, this.#cfg.normalize);
    if (tokens.length === 0) return [];
    const now = this.#now();
    // 按 kind 分路过滤集(承 §5.9 缺口④):空 / 省略 = 不过滤(全 kind),与 SQLite 同一语义。
    const kindFilter =
      kindOptions?.kinds !== undefined && kindOptions.kinds.length > 0
        ? new Set<MemoryKind>(kindOptions.kinds)
        : undefined;
    // 不按主语过滤:一次跨 person+agent+shared 召回(§5.3 末条),与 SQLite 行为一致。
    // 候选过滤:逐 token 命中(includes);命中去重 token 数作关键词原始命中数 raw(与 SQLite 同规则,零漂移)。

    // —— 一阶候选(关键词命中)+ 原始信号(承 §5.5 / §5.9 缺口③)——
    const candById = new Map<number, Cand>();
    for (const r of this.#memories.values()) {
      // 按 kind 分路(承 §5.9 缺口④):不在过滤集内的候选跳过(也不当扩散种子);与 SQLite 一致。
      if (kindFilter !== undefined && !kindFilter.has(r.memoryKind)) continue;
      const rawHits = tokens.reduce((n, t) => (r.normalized.includes(t) ? n + 1 : n), 0);
      if (rawHits === 0) continue; // 关键词无命中 → 不进一阶候选池。
      // 一阶命中关键词必在场;情感按 pad;强度恒在场;无联想/向量分(种子)。复用 #baseSignals 与 SQLite 零漂移。
      candById.set(r.id, {
        r,
        raw: this.#baseSignals(r, now, pad, { keyword: { present: true, value: rawHits } }),
      });
    }

    // —— 联想扩散 + 归一融合 + kind 调制 + 排序 + 检索即强化(承 §5.9 缺口①③④ / §5.5)——
    // 复用单一权威 finalize 流程(与 recallHybrid 共用,不另起第二套打分;与 SQLite 零漂移)。
    return this.#finalizeCandidates(candById, tokens, kindFilter, pad, now, limit);
  }

  /**
   * 构造一条候选的原始多路信号(单一权威,承 §5.5 / §5.9 缺口③;与 SQLite #baseSignals 零漂移):
   * 强度恒在场、情感按 pad 在场;关键词/联想/向量路由调用方以 `overrides` 注入(缺省缺席)。
   */
  #baseSignals(
    r: MutableRecord,
    now: number,
    pad: Pad | undefined,
    overrides: Partial<RawRecallSignals>,
  ): RawRecallSignals {
    return {
      keyword: { present: false, value: 0 },
      strength: {
        present: true,
        value: recallScore(r.importance, decayFactor(r.lastSeenAtMs, now, r.pinned, this.#cfg)),
      },
      emotion:
        pad !== undefined
          ? { present: true, value: emotionResonance(pad) }
          : { present: false, value: 0 },
      association: { present: false, value: 0 },
      vector: { present: false, value: 0 },
      ...overrides,
    };
  }

  /** 把可变记忆映射为召回返回记录(检索即强化前的快照值,承决策 3:本次返回用旧值)。 */
  #toRecord(r: MutableRecord): MemoryRecord {
    return {
      id: r.id,
      text: r.text,
      kind: r.kind,
      memoryKind: r.memoryKind,
      createdAtMs: r.createdAtMs,
      lastSeenAtMs: r.lastSeenAtMs,
      hits: r.hits,
      subject: r.subject,
      personId: r.personId,
      importance: r.importance,
      accessCount: r.accessCount,
      pinned: r.pinned,
      // 当前未闭合 = 标记 openThread 且尚未闭合(承 §7#2;与 SQLite open_thread=1 AND closed_at IS NULL 同义)。
      openThread: r.openThread && r.closedAtMs === undefined,
    };
  }

  /**
   * 候选池收尾(单一权威,承 §5.9 缺口①③④ / §5.5;recall 与 recallHybrid 共用,不另起第二套打分;
   * 与 SQLite #finalizeCandidates 零漂移):联想扩散 → 归一融合 → kind 调制 → 门控/排序/截断 → 检索即强化。
   */
  #finalizeCandidates(
    candById: Map<number, Cand>,
    tokens: readonly string[],
    kindFilter: Set<MemoryKind> | undefined,
    pad: Pad | undefined,
    now: number,
    limit: number,
    weights: RecallSignalWeights = this.#cfg.recallSignalWeights,
  ): readonly MemoryRecord[] {
    // —— 联想扩散(承 §5.9 缺口①):从已入池候选沿邻接图 1..maxHops 跳带入额外候选 ——
    const hopOf = this.#spread([...candById.keys()], this.#cfg.associationMaxHops);
    for (const [id, hop] of hopOf) {
      if (candById.has(id)) continue; // 已是一阶/向量命中,不重复。
      const r = this.#byIdIndex.get(id);
      if (r === undefined) continue;
      // 按 kind 分路(承 §5.9 缺口④):联想带入的旁支若不在过滤集内也跳过(分路一致);与 SQLite 一致。
      if (kindFilter !== undefined && !kindFilter.has(r.memoryKind)) continue;
      const rawHits = tokens.reduce((n, t) => (r.normalized.includes(t) ? n + 1 : n), 0);
      candById.set(id, {
        r,
        raw: this.#baseSignals(r, now, pad, {
          keyword: rawHits > 0 ? { present: true, value: rawHits } : { present: false, value: 0 },
          // 联想分按跳数衰减(hop=1→decay、hop=2→decay²;承 §5.9 缺口①)。
          association: { present: true, value: hopDecay(hop, this.#cfg.associationHopDecay) },
        }),
      });
    }

    // —— 缺口③:候选集尺度 min-max 归一 + 可配权重融合(单一权威公式,与 SQLite 零漂移)——
    const cands = [...candById.values()];
    const fused = normalizeAndFuse(cands.map((c) => c.raw), weights);
    // kind 权重调制(承 §5.9 缺口④):融合分 × 该候选 kind 权重(core>semantic>episodic 可配);与 SQLite 一致。
    // 乘性调制不改变"谁能进池"(零仍零、非零仍非零),仅给分层不同分量(承 §5.5)。
    const scored = cands
      .map((c, i) => ({
        r: c.r,
        score: fused[i]! * memoryKindWeight(c.r.memoryKind, this.#cfg.memoryKindWeights),
      }))
      .filter((s) => s.score > 0); // 零信号门控只丢全零(任一路在场即进池,不学 mem0 硬丢,§5.5)。
    scored.sort((a, b) => b.score - a.score || b.r.hits - a.r.hits || b.r.id - a.r.id);
    const top = scored.slice(0, limit).map((s) => s.r);
    // 检索即强化:只对实际返回的 top-N 升 access_count/importance、更新 last_accessed(被想起→记得牢,§5.5)。
    const out = top.map((r) => this.#toRecord(r));
    for (const r of top) {
      r.accessCount += 1;
      r.importance = reinforceImportance(r.importance, this.#cfg);
      r.lastAccessedAtMs = now;
    }
    return out;
  }

  recallWithContext(query: string, opts: RecallContextOptions = {}): RecallWithContext {
    // 复用 recall 的召回/排序/检索即强化(纯加法,不另起第二套打分);命中顺序即 recall 顺序。
    // kindOptions 透传(承 §5.9 缺口④:带上下文窗口的召回同样支持按分层分路)。
    const hits = this.recall(query, opts.limit, opts.pad, opts.kindOptions);
    const n = opts.windowSize ?? this.#cfg.contextWindowSize;
    // 全局 messages 时序(写入序即时序);时间戳数组供就近锚定(单一权威纯函数,§5.5)。
    const timestamps = this.#messages.map((m) => m.createdAtMs);
    const total = this.#messages.length;
    const memories: RecalledMemory[] = [];
    // 跨命中去重:合并窗口按全局时序、同一条消息(按下标=稳定身份)只一次。
    const mergedIdx = new Set<number>();
    for (const record of hits) {
      const anchor = anchorIndex(timestamps, record.createdAtMs);
      const { start, end } = windowRange(anchor, total, n);
      const window: ChatMessage[] = [];
      for (let i = start; i < end; i++) {
        const m = this.#messages[i]!;
        window.push({ role: m.role, content: m.content });
        mergedIdx.add(i);
      }
      memories.push({ record, contextWindow: window });
    }
    // 合并窗口:下标升序还原全局时序,去重后映射为 ChatMessage。
    const merged: ChatMessage[] = [...mergedIdx]
      .sort((a, b) => a - b)
      .map((i) => {
        const m = this.#messages[i]!;
        return { role: m.role, content: m.content };
      });
    return { memories, mergedContext: merged };
  }

  openThreads(limit: number = this.#cfg.recallLimit): readonly MemoryRecord[] {
    const now = this.#now();
    // 候选 = 标记 openThread 且尚未闭合(承 §7#2);排序用与 recall 同一权威强度公式(零漂移)。
    const candidates: { r: MutableRecord; score: number }[] = [];
    for (const r of this.#memories.values()) {
      if (!r.openThread || r.closedAtMs !== undefined) continue;
      const score = recallScore(r.importance, decayFactor(r.lastSeenAtMs, now, r.pinned, this.#cfg));
      candidates.push({ r, score });
    }
    // 强度降序;同分按近因(last_seen)、再按 id 兜底,与 SQLite 一致。
    candidates.sort(
      (a, b) => b.score - a.score || b.r.lastSeenAtMs - a.r.lastSeenAtMs || b.r.id - a.r.id,
    );
    // 决策 2:巡检不触发检索即强化(不升 importance/accessCount),免待办虚高强度污染 recall 排序。
    return candidates.slice(0, limit).map((s) => ({
      id: s.r.id,
      text: s.r.text,
      kind: s.r.kind,
      memoryKind: s.r.memoryKind,
      createdAtMs: s.r.createdAtMs,
      lastSeenAtMs: s.r.lastSeenAtMs,
      hits: s.r.hits,
      subject: s.r.subject,
      personId: s.r.personId,
      importance: s.r.importance,
      accessCount: s.r.accessCount,
      pinned: s.r.pinned,
      openThread: true, // 候选条件已保证。
    }));
  }

  closeThread(id: number): void {
    // 幂等(承 §7#2 决策 3):只闭合尚未闭合者;已闭合 / 未知 id 无副作用、不抛。
    for (const r of this.#memories.values()) {
      if (r.id === id && r.closedAtMs === undefined) {
        r.closedAtMs = this.#now();
        return;
      }
    }
  }

  setEmbedding(id: number, vector: readonly number[]): void {
    if (vector.length === 0) return; // 空向量不写(保持未嵌入状态,镜像 SQLite)。
    const r = this.#byIdIndex.get(id);
    if (r === undefined) return; // 不存在 id 幂等不抛(承 §5.6)。
    // 不透明存储语义:存副本(防外部数组后续被改;dim = 长度)。
    r.embedding = [...vector];
  }

  /**
   * 同步向量 KNN 内核(承 §5.6 接缝 7;与 SQLite #vectorKnn 零漂移):对有 embedding 的记忆做暴力 cosine,
   * **维度不一致跳过(不抛)**,候选封顶 `vectorKnnCandidateCap`,按相似度降序(同分 id 兜底)。
   */
  #vectorKnn(
    vector: readonly number[],
    kindOptions: RecallKindOptions | undefined,
    cap: number = this.#cfg.vectorKnnCandidateCap,
  ): { r: MutableRecord; sim: number }[] {
    if (vector.length === 0) return [];
    const kindFilter =
      kindOptions?.kinds !== undefined && kindOptions.kinds.length > 0
        ? new Set<MemoryKind>(kindOptions.kinds)
        : undefined;
    // 候选封顶:按近因优先(last_seen 降序、id 兜底)取前 cap 个有 embedding 的记忆(与 SQLite ORDER BY 一致)。
    // weighted 混合召回传更大 cap 做"融合前 over-fetch"(融合后再按 vectorKnnCandidateCap 收口)。
    const withEmb = [...this.#memories.values()].filter((r) => r.embedding !== undefined);
    withEmb.sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs || b.id - a.id);
    const capped = withEmb.slice(0, cap);
    const out: { r: MutableRecord; sim: number }[] = [];
    for (const r of capped) {
      if (kindFilter !== undefined && !kindFilter.has(r.memoryKind)) continue;
      const emb = r.embedding!;
      if (emb.length !== vector.length) continue; // 维度不一致跳过(不抛,承硬约束)。
      out.push({ r, sim: cosineSimilarity(vector, emb) });
    }
    out.sort((a, b) => b.sim - a.sim || b.r.id - a.r.id);
    return out;
  }

  recallByVector(
    vector: readonly number[],
    limit: number = this.#cfg.recallLimit,
    opts: RecallByVectorOptions = {},
  ): readonly MemoryRecord[] {
    return this.#vectorKnn(vector, opts.kindOptions)
      .slice(0, limit)
      .map((c) => this.#toRecord(c.r));
  }

  recallHybrid(query: string, opts: RecallHybridOptions = {}): readonly MemoryRecord[] {
    const limit = opts.limit ?? this.#cfg.recallLimit;
    // 无 queryVector → 关键词快路径,逐字复用 recall(承 §5.5 末「🔴 非阻塞召回」快路径下限)。
    if (opts.queryVector === undefined || opts.queryVector.length === 0) {
      return this.recall(query, limit, opts.pad, opts.kindOptions);
    }
    const tokens = tokenize(query, this.#cfg.normalize);
    const kindFilter =
      opts.kindOptions?.kinds !== undefined && opts.kindOptions.kinds.length > 0
        ? new Set<MemoryKind>(opts.kindOptions.kinds)
        : undefined;
    const now = this.#now();
    const pad = opts.pad;

    // —— 关键词路:候选 + 原始命中数(融合前 over-fetch,不预截断)——
    const keywordHitById = new Map<number, number>();
    if (tokens.length > 0) {
      for (const r of this.#memories.values()) {
        if (kindFilter !== undefined && !kindFilter.has(r.memoryKind)) continue;
        const rawHits = tokens.reduce((n, t) => (r.normalized.includes(t) ? n + 1 : n), 0);
        if (rawHits === 0) continue;
        keywordHitById.set(r.id, rawHits);
      }
    }

    // —— 向量路:KNN(cosine 降序;维度不符已跳过)。融合前 over-fetch:cap 放大,融合后才收口 ——
    const overFetchCap =
      this.#cfg.fusionMode === 'weighted'
        ? Number.MAX_SAFE_INTEGER
        : this.#cfg.vectorKnnCandidateCap;
    const vectorHits = this.#vectorKnn(opts.queryVector, opts.kindOptions, overFetchCap);
    const simById = new Map<number, number>();
    for (const v of vectorHits) simById.set(v.r.id, v.sim);

    // —— 候选池:关键词路 ∪ 向量路并集都入池(任一路在场即进池,承 §5.5;不硬门控丢项)——
    const candById = new Map<number, Cand>();
    const allIds = new Set<number>([...keywordHitById.keys(), ...simById.keys()]);

    if (this.#cfg.fusionMode === 'rrf') {
      // —— 备选:RRF 按名次融合(承 §5.9;默认不走)——
      const keywordRanked = [...keywordHitById.entries()]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .map(([id]) => id);
      const vectorRanked = vectorHits.map((v) => v.r.id);
      const rrf = reciprocalRankFusion([keywordRanked, vectorRanked], this.#cfg.rrfK);
      const rrfMax = 2 / (this.#cfg.rrfK + 1);
      for (const id of allIds) {
        const r = this.#byIdIndex.get(id);
        if (r === undefined) continue;
        const rawHits = keywordHitById.get(id) ?? 0;
        const rrfScore = rrf.get(id) ?? 0;
        candById.set(id, {
          r,
          raw: this.#baseSignals(r, now, pad, {
            keyword: rawHits > 0 ? { present: true, value: rawHits } : { present: false, value: 0 },
            vector: { present: true, value: rrfMax > 0 ? Math.min(rrfScore / rrfMax, 1) : 0 },
          }),
        });
      }
      return this.#finalizeCandidates(candById, tokens, kindFilter, pad, now, limit);
    }

    // —— 默认 weighted:向量相似度当又一路 min-max 归一信号,折进既有加性归一(参考 Nexus 范式)——
    for (const id of allIds) {
      const r = this.#byIdIndex.get(id);
      if (r === undefined) continue;
      const rawHits = keywordHitById.get(id) ?? 0;
      const sim = simById.get(id);
      candById.set(id, {
        r,
        raw: this.#baseSignals(r, now, pad, {
          keyword: rawHits > 0 ? { present: true, value: rawHits } : { present: false, value: 0 },
          // 向量路:原始相似度入场(min-max 归一与加权融合在 normalizeAndFuse 用 hybridSignalWeights 做)。
          vector: sim !== undefined ? { present: true, value: sim } : { present: false, value: 0 },
        }),
      });
    }
    // 融合前 over-fetch、融合后才按 vectorKnnCandidateCap 收口(承用户拍板);weighted 用向量偏重权重。
    const capped = this.#capCandidates(candById, this.#cfg.vectorKnnCandidateCap);
    return this.#finalizeCandidates(capped, tokens, kindFilter, pad, now, limit, this.#cfg.hybridSignalWeights);
  }

  /**
   * 候选池收口(承用户拍板「融合后才按 vectorKnnCandidateCap 封顶」;与 SQLite #capCandidates 零漂移):
   * 按候选自身向量/关键词强度粗排取前 cap,限后续工作集规模;精排仍由 #finalizeCandidates 归一融合决定。
   */
  #capCandidates(candById: Map<number, Cand>, cap: number): Map<number, Cand> {
    if (candById.size <= cap) return candById;
    const ranked = [...candById.values()].sort((a, b) => {
      const av = a.raw.vector.present ? a.raw.vector.value : 0;
      const bv = b.raw.vector.present ? b.raw.vector.value : 0;
      const ak = a.raw.keyword.present ? a.raw.keyword.value : 0;
      const bk = b.raw.keyword.present ? b.raw.keyword.value : 0;
      return bv - av || bk - ak || a.r.id - b.r.id;
    });
    const out = new Map<number, Cand>();
    for (const c of ranked.slice(0, cap)) out.set(c.r.id, c);
    return out;
  }

  memoriesNeedingEmbedding(
    limit: number = this.#cfg.recallLimit,
  ): readonly { readonly id: number; readonly text: string }[] {
    // embedding 为 undefined 即尚未嵌入(承 §5.6);按 id 升序(先写先补),受 limit 约束。
    const pending = [...this.#memories.values()]
      .filter((r) => r.embedding === undefined)
      .sort((a, b) => a.id - b.id)
      .slice(0, limit);
    return pending.map((r) => ({ id: r.id, text: r.text }));
  }

  getCloseness(personId: string): number {
    return this.getClosenessAt(personId, this.#now());
  }

  getClosenessAt(personId: string, atMs: number): number {
    const rel = this.#closeness.get(personId);
    // 无记录(含未知 person):返回配置初值(陌生起步,承 §6);与 SQLite #readRel===null 同语义。读不写回(§5.5)。
    if (rel === undefined) return this.#cfg.initialCloseness;
    return decayCloseness(rel.closeness, rel.updatedAtMs, atMs, this.#cfg);
  }

  bumpCloseness(personId: string, valencePos: number, atMs: number): number {
    // 先取衰减后当前值,再按正向程度渐近抬升(与 SQLite 共用单一权威公式,零漂移)。
    const cur = this.getClosenessAt(personId, atMs);
    const next = bumpClosenessValue(cur, valencePos, this.#cfg);
    // 未知 personId 幂等不抛:镜像 SQLite「UPDATE 命中 0 行」——只对已 seed 的花名册成员写回,不凭空建人。
    if (this.#people.has(personId)) {
      this.#closeness.set(personId, { closeness: next, updatedAtMs: atMs });
    }
    return next;
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
