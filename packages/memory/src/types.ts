import type { ChatMessage } from '@chat-a/protocol';

export type { ChatMessage };

/**
 * PAD 情感状态(承 §5.5 情感共振):各分量 [-1,1]。
 * memory 包**本地定义**、结构与 persona 包的 `Pad` 兼容,但 memory **不跨包 import persona**(§3.1)。
 * 仅用于 `recall` 的可选情感共振入参(默认不启用,保持签名向后兼容)。
 */
export interface Pad {
  readonly pleasure: number;
  readonly arousal: number;
  readonly dominance: number;
}

/** 落库的对话消息(snapshot 的来源;承 §5 真相源)。 */
export interface StoredMessage {
  readonly sessionId: string;
  readonly turnId: string;
  readonly role: ChatMessage['role'];
  readonly content: string;
  readonly createdAtMs: number;
  /** 关联 ID(§8.1 贯穿);可缺省。 */
  readonly correlationId?: string;
}

/**
 * 记忆主语(承 §5.3):区分"某个人的事实/偏好/经历(person)"、
 * "Agent 关于自己确立过的事实(agent)"、"主用户与 Agent 的共同经历(shared)"。
 * 召回跨三类主语返回,防自相矛盾(§5.3 末条)。
 */
export type MemorySubject = 'person' | 'agent' | 'shared';

/**
 * 记忆的情景/语义分层(承 §5.1 / §5.9 缺口④):区分人类记忆的两种本质:
 * - **episodic**(情景记忆,叙事):"哪天发生了什么 / 某次对话事件",带时间叙事性。
 * - **semantic**(语义记忆,蒸馏事实):从经历里蒸馏出的稳定事实/偏好(如"用户喜欢咖啡")。
 * - **core**(核心档,承 §5.4):用户名字/过敏、Agent 根本设定等——**永不衰减、永远优先注入**;
 *   与既有 `pinned`(免衰减)对齐:写入 `core` 即视作 pinned(免衰),`pinned` 概念被 `core` 涵盖复用。
 *
 * 区别于自由字符串 `kind`(任意来源标签,如 'extracted'):本字段是**受约束的认知分层**,
 * 用于召回分路/配额与衰减豁免(§5.9 缺口④)。
 */
export type MemoryKind = 'episodic' | 'semantic' | 'core';

/**
 * 人物花名册条目(承 §5.3b):以人为中心建模,始终有一个主用户,
 * 结构支持未来"认识多人 / 用户组 / Agent 自主纳入成员"——P1 只 seed 主用户,
 * 其余字段就位但多为默认/空,免未来长期记忆迁移(§3.2)。
 */
export interface Person {
  readonly personId: string;
  readonly name: string;
  /** 是否主用户(P1 恒有且仅有一个)。 */
  readonly isPrimary: boolean;
  /** 关系身份:主用户 / 成员 / 访客(P1 只用 primary)。 */
  readonly status: 'primary' | 'member' | 'guest';
  /** 纳入来源:用户主动 / Agent 自主(P1 只用 user)。 */
  readonly addedBy: 'user' | 'agent';
  /** 预留:亲密度/IPC 轨迹的 JSON(P1 可空,§5.3b)。 */
  readonly relationshipState?: string;
  /** 预留:P3 声纹引用(P1 可空,本期不做识别)。 */
  readonly voiceprintRef?: string;
}

/** 写入一条记忆条目的输入(ADD 语义,§5.8)。 */
export interface MemoryInput {
  readonly text: string;
  /** 记忆种类(自由字符串,P1 不强约束)。 */
  readonly kind?: string;
  /**
   * 情景/语义分层(承 §5.1 / §5.9 缺口④);省略默认 episodic(原始记忆多为叙事,语义蒸馏属离线巩固)。
   * 来源:抽取/沉淀层或调用方传入;**不在热路径调 LLM 判类**(承 §5.8)。
   * 写入 `core` 即视作 pinned(免衰减),与既有 `pinned` 概念对齐复用。
   */
  readonly memoryKind?: MemoryKind;
  readonly sourceSession?: string;
  /** 省略则由实现取"现在"(注入时钟便于确定性测试,§3.2)。 */
  readonly createdAtMs?: number;
  /**
   * 主语(承 §5.3);省略默认 'person'。
   * 让现有 cognition/runtime 调用方无需改动(向后兼容)。
   */
  readonly subject?: MemorySubject;
  /**
   * 人物归属(承 §5.3b);person/shared 省略默认主用户,agent 主语忽略此字段(写 NULL)。
   */
  readonly personId?: string;
  /**
   * 重要性初值(承 §5.5);省略用配置 `initialImportance`。落在 [0,1]。
   * 检索即强化会在召回命中时升高它。
   */
  readonly importance?: number;
  /**
   * 是否核心记忆(承 §5);pinned 免于时间衰减(永不淡去)。省略默认 false。
   * P1 不开放常规写入路径设置,主要供核心标注/巩固用。
   */
  readonly pinned?: boolean;
  /**
   * 是否未闭合话题(承 §7#2 主动跟进的数据层):标记"一件悬而未决、值得日后回访的事"
   * (如"明天要面试")。省略默认 false。纯加法可选,既有写入方无需改动(向后兼容)。
   * 本切片只做记忆数据层,不接 autonomy/主动回合调度。
   */
  readonly openThread?: boolean;
}

/** 召回返回的记忆条目。 */
export interface MemoryRecord {
  readonly id: number;
  readonly text: string;
  readonly kind: string | undefined;
  /**
   * 情景/语义分层(承 §5.1 / §5.9 缺口④):episodic(叙事)/ semantic(蒸馏事实)/ core(核心档)。
   * **纯加法可选**:两实现 recall / openThreads 返回时恒填充;声明可选只为让现有消费者
   * (构造 MemoryRecord 字面量者)无需级联改动(向后兼容)。运行期返回必有值。
   */
  readonly memoryKind?: MemoryKind;
  readonly createdAtMs: number;
  readonly lastSeenAtMs: number;
  readonly hits: number;
  /** 主语标签(必带,承 §5.3);上层按主语分桶注入。 */
  readonly subject: MemorySubject;
  /** 人物归属(承 §5.3b);agent 主语为 undefined(不指向任何人)。 */
  readonly personId: string | undefined;
  /**
   * 重要性(承 §5.5);融合排序 `score = importance × decay` 的一项,检索即强化随命中升高。
   * **纯加法可选**:两实现召回时恒填充;声明为可选只为让现有消费者(构造 MemoryRecord 字面量者)
   * 无需级联改动(向后兼容,严格约束:不改 cognition/runtime)。运行期 recall 返回必有值。
   */
  readonly importance?: number;
  /** 累计被召回返回(被想起)的次数(承 §5.5 检索即强化);纯加法可选,recall 返回必有值。 */
  readonly accessCount?: number;
  /** 是否核心记忆(承 §5);true 则免于时间衰减。纯加法可选,recall 返回必有值。 */
  readonly pinned?: boolean;
  /**
   * 是否未闭合话题(承 §7#2 主动跟进的数据层):true 表示这是一件悬而未决、值得回访的事,
   * 且尚未闭合(被 `closeThread` 标记闭合后即为 false / 退出未闭合查询)。
   * **纯加法可选**:两实现 recall / openThreads 返回时恒填充;声明为可选只为让现有消费者
   * (构造 MemoryRecord 字面量者)无需级联改动(向后兼容)。运行期返回必有值。
   */
  readonly openThread?: boolean;
}

/**
 * 召回命中 + 其在对话时序里的上下文窗口(承 §5.5「上下文窗口拼接」)。
 * **纯加法派生视图**:`record` 即原 `recall` 返回的离散条目;`contextWindow` 是把该命中
 * 按时间戳就近锚回 `messages` 时序后、取前后各 N 条相邻消息拼成的连贯片段(含锚点,按时序)。
 * 无相邻消息(空库/取窗失败降级)时 `contextWindow` 为空数组。
 */
export interface RecalledMemory {
  readonly record: MemoryRecord;
  readonly contextWindow: readonly ChatMessage[];
}

/**
 * `recallWithContext` 的返回(承 §5.5):逐命中结果 + 跨命中去重的合并窗口。
 * - `memories`:命中顺序与同参数 `recall` 一致,每项带自己独立的连贯上下文窗口。
 * - `mergedContext`:所有命中窗口按全局时序合并、同一条消息只出现一次(跨命中去重)。
 */
export interface RecallWithContext {
  readonly memories: readonly RecalledMemory[];
  readonly mergedContext: readonly ChatMessage[];
}

/**
 * 召回时按 kind 分路的可选入参(承 §5.9 缺口④;纯加法,省略 = 不限制、全 kind 混合召回)。
 * 两实现共用同一语义(零漂移)。
 */
export interface RecallKindOptions {
  /**
   * 只召回这些分层(如 `['semantic','core']` 只要稳定事实/核心)。省略 = 不过滤(全 kind)。
   * 空数组等同省略(不过滤),避免"传空 = 全丢"的脆弱语义。
   */
  readonly kinds?: readonly MemoryKind[];
}

/** `recallWithContext` 的可选入参(纯加法;省略全用配置默认,签名向后兼容)。 */
export interface RecallContextOptions {
  /** 召回返回上限;省略用配置 `recallLimit`(同 `recall`)。 */
  readonly limit?: number;
  /** 可选情感共振 PAD(同 `recall`;省略不启用)。 */
  readonly pad?: Pad;
  /** 前后各取条数 N;省略用配置 `contextWindowSize`。 */
  readonly windowSize?: number;
  /** 按 kind 分路(承 §5.9 缺口④);省略 = 全 kind 混合召回。 */
  readonly kindOptions?: RecallKindOptions;
}

/**
 * `recallHybrid` 的入参(承 §5.5 末「🔴 非阻塞召回」/ §5.9「RRF 混合检索」):
 * - **无 `queryVector` → 行为等同 `recall(query, limit, pad, kindOptions)`**(关键词快路径,逐字一致,快路径下限)。
 * - **有 `queryVector` → 关键词路 + 向量 KNN 路用 RRF 按名次融合**得到候选,再接既有联想/归一/kind 调制。
 *
 * `queryVector` 由**调用方传入**(memory 不依赖 embedder、不发网络/不异步;承本切片硬约束):
 * 编排层在调 recall 之前异步算好 query embedding,再同步传入(承 §5.5 末「query 向量在调 recall 之前异步算好」)。
 * 纯加法可选,缺省全走快路径/配置,签名向后兼容。
 */
export interface RecallHybridOptions {
  /** 查询向量(调用方异步算好后传入);省略 = 走关键词快路径(逐字等同 `recall`)。 */
  readonly queryVector?: readonly number[];
  /** 召回返回上限;省略用配置 `recallLimit`(同 `recall`)。 */
  readonly limit?: number;
  /** 可选情感共振 PAD(同 `recall`;省略不启用)。 */
  readonly pad?: Pad;
  /** 按 kind 分路(承 §5.9 缺口④);省略 = 全 kind 混合召回。 */
  readonly kindOptions?: RecallKindOptions;
}

/**
 * `recallByVector` 的可选入参(承 §5.6 接缝 7;纯加法,省略全用配置默认)。
 * 候选封顶走配置 `vectorKnnCandidateCap`(端侧调优属配置职责),本入参不暴露。
 */
export interface RecallByVectorOptions {
  /** 按 kind 分路(承 §5.9 缺口④);省略 = 全 kind。 */
  readonly kindOptions?: RecallKindOptions;
}

/**
 * 记忆存储接缝(承 §3.1):cognition/runtime 只依赖本接口,不碰具体实现内部。
 * 内存实现与 SQLite 实现满足同一契约、可互换;同步签名(本地毫秒级读 + 同步驱动)。
 */
export interface MemoryStore {
  /** 追加一条对话消息(snapshot 来源)。 */
  appendMessage(msg: StoredMessage): void;
  /** 取最近 N 条消息(滑窗快照,跨会话恢复连续性);N 省略用配置默认。 */
  snapshot(limit?: number): readonly ChatMessage[];
  /**
   * 取**指定会话**最近的若干条消息(按时序),供会话级沉淀(Reflection,§6.1)使用。
   * 区别于 snapshot 的全局最近 N;只返回该 sessionId 的消息;N 省略用配置默认。
   * 读失败优雅降级为空数组(承 §3.2),不抛。
   */
  messagesForSession(sessionId: string, limit?: number): readonly ChatMessage[];
  /**
   * ADD 一条记忆条目(带去重),返回该记忆的 id(承 §5.6:供编排层随后 `setEmbedding` 补嵌)。
   * 去重命中既有等价记忆时返回**被强化的那条**的 id(不新建)。
   * **向后兼容**:返回类型从 `void → number`,现有忽略返回值的调用方不受影响。
   * 写失败优雅降级(返回 -1,不抛,§3.2)。
   */
  addMemory(rec: MemoryInput): number;
  /**
   * 关键词召回(P1 关键词级;语义/向量属 P2)。
   * 排序用混合归一得分(关键词归一 + 记忆强度 + 可选情感共振,§5.5)。
   * `pad` 为**可选**:传入则启用情感共振重排,缺省不启用(签名向后兼容,默认行为不变)。
   * `kindOptions` 为**可选**(承 §5.9 缺口④):传入则按情景/语义分层过滤候选,缺省不过滤
   * (全 kind 混合召回,默认行为不变)。kind 间的**权重调制**始终生效(配置 `memoryKindWeights`)。
   */
  recall(
    query: string,
    limit?: number,
    pad?: Pad,
    kindOptions?: RecallKindOptions,
  ): readonly MemoryRecord[];
  /**
   * 带上下文窗口的召回(承 §5.5「上下文窗口拼接」):在 `recall` 命中基础上,
   * 把每条命中按**时间戳就近**锚回 `messages` 时序,取前后各 N 条相邻消息拼成连贯片段,
   * 并提供跨命中去重的合并窗口。N 走配置(`contextWindowSize`)、可经 `opts.windowSize` 覆盖。
   *
   * **纯加法**:复用 `recall` 的召回/排序/检索即强化(不另起第二套打分),仅追加取窗;
   * `memories` 命中顺序与同参数 `recall` 一致。取窗优雅降级(空库/读失败→窗口为空,不抛,§3.2)。
   */
  recallWithContext(query: string, opts?: RecallContextOptions): RecallWithContext;
  /**
   * 列出当前未闭合话题(承 §7#2 主动跟进的数据层):返回所有
   * "标记 openThread 且尚未闭合"的记忆,按记忆强度(`importance × decay`)降序,
   * 同分按近因 / id 兜底——与 `recall` 同一套单一权威强度公式(§5.5),两实现零漂移。
   * 数量受 `limit` 约束(省略用配置 `recallLimit`)。
   *
   * **不触发检索即强化**(决策 2):巡检待办不等于"被想起",不升 importance / access_count,
   * 免待办因被巡检而虚高强度污染 recall 排序。读失败优雅降级为空数组,不抛(§3.2)。
   */
  openThreads(limit?: number): readonly MemoryRecord[];
  /**
   * 标记话题闭合(承 §7#2):把指定记忆置为已闭合(记录闭合时间),令其退出 `openThreads()`。
   * **幂等**:对已闭合记忆重复调用、或对不存在 / 非未闭合的 id 调用,均无副作用且不抛(§3.2)。
   * 闭合是轻量状态字段更新(同 pinned 列),非记忆内容 update/delete,故走热路径而非离线巩固。
   */
  closeThread(id: number): void;
  /**
   * 写入一条记忆的向量(承 §5.6 接缝 7 / §5.9 接缝预留⑤):**Float32 BLOB 不透明存储** + 维度。
   * 由**调用方传入** `number[]`(memory 不依赖 embedder、不发网络/不异步);供换 embedder 后台 re-embed 写回同列。
   * 对不存在 id **幂等不抛**(命中 0 行,无副作用);写失败优雅降级(不抛,§3.2)。
   */
  setEmbedding(id: number, vector: readonly number[]): void;
  /**
   * 同步向量 KNN(承 §5.6 接缝 7 / §5.5 语义检索一路):对**有 embedding** 的记忆做 JS 暴力 cosine,
   * 按相似度降序返回前 `limit` 条(省略用配置 `recallLimit`)。候选封顶 `vectorKnnCandidateCap`(不卡事件循环)。
   * `query` 向量由调用方传入;**维度不一致的行跳过(不抛)**。读失败优雅降级为空数组(§3.2)。
   * 同步契约(沿用 `recall`):语义期的异步 query embedding 由编排层在调用前算好(承 §5.5 末「🔴 非阻塞召回」)。
   */
  recallByVector(
    vector: readonly number[],
    limit?: number,
    opts?: RecallByVectorOptions,
  ): readonly MemoryRecord[];
  /**
   * 同步混合召回(承 §5.5 末「🔴 非阻塞召回」/ §5.9「RRF 混合检索」):
   * - **无 `opts.queryVector` → 行为等同 `recall(query, limit, pad, kindOptions)`**(关键词快路径,逐字复用)。
   * - **有 `opts.queryVector` → 关键词路 + 向量 KNN 路用 RRF(k=配置 `rrfK`)按名次融合**得到候选,
   *   再接既有联想扩散 + min-max 归一 + kind 加权(复用同一套打分,不另起第二套)。
   *   保持 §5.5 规则:**情感/关键词单路也能入候选池**,RRF 只融合"关键词 vs 向量"两路的名次,不硬门控丢项。
   * 同步契约;query 向量由调用方在调用前异步算好后传入(承本切片硬约束)。读失败优雅降级为空数组(§3.2)。
   */
  recallHybrid(query: string, opts?: RecallHybridOptions): readonly MemoryRecord[];
  /**
   * 列出 embedding 为 NULL(尚未嵌入)的记忆(承 §5.6「写侧 embedding 走后台」),供编排层后台补嵌。
   * 返回 `{ id, text }`,数量受 `limit` 约束(省略用配置 `recallLimit`)。读失败优雅降级为空数组(§3.2)。
   */
  memoriesNeedingEmbedding(limit?: number): readonly { readonly id: number; readonly text: string }[];
  /**
   * 读关系亲密度(承 §6/§5.3b 关系亲密度小节):取 `people.relationship_state.closeness`
   * 并按距上次互动时长**惰性衰减** `c·0.5^(days/H)`,夹到 `[closenessFloor, 1]`;
   * 无记录返回配置 `initialCloseness`。**读不写回**(承 §5.5 衰减纪律)。生产用 `Date.now()`。
   */
  getCloseness(personId: string): number;
  /**
   * 同 `getCloseness`,但**可注入时刻** `atMs`(承 §3.2 可测试性):
   * 供确定性测试时间衰减、以及编排层在固定时刻演化用;生产 `getCloseness` 即以"现在"调用它。
   */
  getClosenessAt(personId: string, atMs: number): number;
  /**
   * 抬升关系亲密度(承 §6/§2.3,回合收尾按 appraiser 正向 valence 调用,非首字热路径):
   * 先取衰减后当前值 `c`,`c' = clamp(c + closenessUpK·clamp(valencePos,0,1)·(1−c), floor, 1)`
   * (渐近饱和),写回 `relationship_state` JSON `{closeness:c', closenessUpdatedAtMs:atMs}`,返回 `c'`。
   * `valencePos≤0` 时只刷新衰减基线(等价 `c'=c`,更新时间戳)。对未知 personId **幂等不抛**(§3.2)。
   */
  bumpCloseness(personId: string, valencePos: number, atMs: number): number;
  /** 通用状态 KV 读(真相源持久化原语;persona 状态等复用)。无则 undefined。 */
  getState(key: string): string | undefined;
  /** 通用状态 KV 写(同 key 覆盖)。 */
  setState(key: string, value: string): void;
  /** 释放底层资源(SQLite 句柄等)。 */
  close(): void;
}
