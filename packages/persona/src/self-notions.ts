import type {
  KvLike,
  SelfNotion,
  SelfNotionEvolver,
  SelfNotionSnapshot,
  SelfNotionStore,
  SelfNotionStrengthDelta,
  SelfNotionsState,
} from './types';
import {
  MAX_STRENGTH_DELTA_PER_STEP,
  SELF_NOTION_BASE_STRENGTH,
  SELF_NOTIONS_SCHEMA_VERSION,
  clamp01,
} from './defaults';

/**
 * self_notions 持久化 + 保守强度演化(§7#3 会反对的下一步)。
 *
 * 设计纪律:
 * - 纯加法、向后兼容:SelfNotion 的 strength/affirmCount 为可选;缺省按基线处理,行为等价当前只读种子。
 * - 演化保守:强度**只增不减**、单次有上限、版本快照可回溯(§6.1 演化纪律)。
 * - opt-in:演化器(SelfNotionEvolver)不注入 = 不演化(沿用 appraiser/oceanEvolver 范式)。
 * - 优雅降级(§3.2):store 缺失/损坏回落种子;演化失败/null/全零跳过、不抛、不打断回合。
 * - 数据迁移纪律(§6.1):持久化带 schema 版本;旧形态迁移补缺省,立场状态绝不丢。
 * - 接缝边界(§3.1):store 基于 KvLike(结构类型),persona 不依赖 memory 包。
 */

/** self_notions 状态的 KV key(独立于 OCEAN/PAD 的 persona:snapshot,各自迁移)。 */
const STATE_KEY = 'persona:self_notions';

/** 轻量归一:小写化 + 去首尾空白(与 stance.ts 一致)。 */
function normalize(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * 立场定位键:topic 首个关键词归一。强度增量据此回找立场;故 topic 至少一个关键词。
 * 同一持久集内若两条立场首关键词相同,演化只命中第一条(种子约定 topic 首词唯一)。
 */
export function topicKeyOf(notion: SelfNotion): string {
  return normalize(notion.topic[0] ?? '');
}

/** 立场的有效强度:显式 strength,否则基线(缺省视作基线,行为等价当前)。纯函数。 */
export function effectiveStrength(notion: SelfNotion): number {
  return typeof notion.strength === 'number' && Number.isFinite(notion.strength)
    ? clamp01(notion.strength)
    : SELF_NOTION_BASE_STRENGTH;
}

/**
 * 把任意来源的强度增量钳到 [0, +max](§6.1 单步上限,保守:**只增不减**)。
 * 负数/非有限 → 0(不演化该条)。纯函数、可写 golden。
 */
export function clampStrengthDelta(raw: number, max = MAX_STRENGTH_DELTA_PER_STEP): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const m = Math.abs(max);
  return raw > m ? m : raw;
}

/**
 * 把(已钳制的)正向增量应用到一条立场:strength=clamp01(有效强度+delta),affirmCount+1。
 * 纯函数,返回新立场(原对象不变)。delta 应已过 clampStrengthDelta(此处不再钳上限,仅 clamp01)。
 */
export function applyStrengthDelta(notion: SelfNotion, delta: number): SelfNotion {
  const before = effectiveStrength(notion);
  const after = clamp01(before + delta);
  const affirmCount = (typeof notion.affirmCount === 'number' && Number.isFinite(notion.affirmCount)
    ? notion.affirmCount
    : 0) + 1;
  return { topic: notion.topic, position: notion.position, strength: after, affirmCount };
}

/** 构造一条强度演化版本快照(§6.1 history,可回溯/可回滚)。纯函数。 */
export function buildSelfNotionSnapshot(
  before: number,
  after: number,
  delta: number,
  turn: number,
  topicKey: string,
  at: string,
): SelfNotionSnapshot {
  return { turn, at, topicKey, before, after, delta };
}

/** 一条 SelfNotion 的最小形状校验(必须有非空 position 与至少一个 topic 关键词)。 */
function isValidNotion(v: unknown): v is SelfNotion {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o['position'] !== 'string' || o['position'].trim().length === 0) return false;
  const topic = o['topic'];
  if (!Array.isArray(topic) || topic.length === 0) return false;
  return topic.every((t) => typeof t === 'string' && t.trim().length > 0);
}

/** 逐条规整一条立场:补齐 strength/affirmCount 缺省(条件展开,不写 undefined)。 */
function normalizeNotion(raw: SelfNotion): SelfNotion {
  const strength =
    typeof raw.strength === 'number' && Number.isFinite(raw.strength)
      ? clamp01(raw.strength)
      : SELF_NOTION_BASE_STRENGTH;
  const affirmCount =
    typeof raw.affirmCount === 'number' && Number.isFinite(raw.affirmCount) && raw.affirmCount >= 0
      ? Math.floor(raw.affirmCount)
      : 0;
  return { topic: raw.topic, position: raw.position, strength, affirmCount };
}

/**
 * schema 迁移(§6.1 数据迁移纪律):把任意读到的形态迁到当前版本。
 * - 纯 SelfNotion[](v0,无版本号)或带 notions 的对象 → v1,逐条补 strength/affirmCount 缺省。
 * - notions 非数组/全损坏 → 返回 null(回落种子比带病续接安全)。
 * - history 非数组 → 丢弃 history 字段而非丢整 state(立场条目绝不因 history 损坏而丢)。
 * **立场的 topic/position 永不在迁移中丢失。**
 */
export function migrateSelfNotionsState(parsed: unknown): SelfNotionsState | null {
  // v0:历史上直接存了 SelfNotion[](无版本号包裹)。
  const rawNotions: unknown = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)['notions']
      : undefined;
  if (!Array.isArray(rawNotions)) return null;

  const valid = rawNotions.filter(isValidNotion).map(normalizeNotion);
  if (valid.length === 0) return null; // 全损坏 → 回落种子。

  const rawHistory =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)['history']
      : undefined;
  const base: SelfNotionsState = { version: SELF_NOTIONS_SCHEMA_VERSION, notions: valid };
  // history 存在且为数组才保留;否则(缺失/损坏)丢字段不丢 state。
  return Array.isArray(rawHistory) ? { ...base, history: rawHistory as readonly SelfNotionSnapshot[] } : base;
}

/** 把种子立场包成当前版本的 state(逐条补缺省)。纯函数。 */
export function seedToState(seedNotions: readonly SelfNotion[]): SelfNotionsState {
  return { version: SELF_NOTIONS_SCHEMA_VERSION, notions: seedNotions.map(normalizeNotion) };
}

/** 进程内 self_notions 存储(默认/测试)。 */
export class InMemorySelfNotionStore implements SelfNotionStore {
  #state: SelfNotionsState | null = null;
  load(): SelfNotionsState | null {
    return this.#state;
  }
  save(state: SelfNotionsState): void {
    this.#state = state;
  }
}

/**
 * 基于通用 KV(结构类型 KvLike)的 self_notions 存储:JSON 序列化存独立 key。
 * 与 createKvPersonaStore 同构;runtime 可注入同一 store,persona 不依赖 memory 包。
 */
export function createKvSelfNotionStore(kv: KvLike): SelfNotionStore {
  return {
    load(): SelfNotionsState | null {
      const raw = kv.getState(STATE_KEY);
      if (raw === undefined) return null;
      try {
        return migrateSelfNotionsState(JSON.parse(raw) as unknown);
      } catch {
        return null; // 解析失败 → 视作无状态,回落种子(优雅降级)。
      }
    },
    save(state: SelfNotionsState): void {
      kv.setState(STATE_KEY, JSON.stringify(state));
    },
  };
}

export interface SelfNotionsManagerOptions {
  /** 人格种子的 self_notions(首启 seed / 回落源;绝不空手)。 */
  readonly seedNotions: readonly SelfNotion[];
  /** 持久化存储(可选);不注入 = 进程内、不落库。 */
  readonly store?: SelfNotionStore;
  /**
   * 强度演化接缝(§7#3,默认关)。**不注入 = 立场恒定**(沿用 opt-in 范式);
   * 注入后,advance() 内据其判定强化哪些立场,失败/null/全零降级跳过。
   */
  readonly evolver?: SelfNotionEvolver;
  /** 单次强度增量上限(默认 MAX_STRENGTH_DELTA_PER_STEP)。 */
  readonly maxDeltaPerStep?: number;
  /** 注入当前时钟(测试可控);默认 ISO now,用于演化快照时间戳。 */
  readonly now?: () => string;
}

/**
 * self_notions 管理器(薄编排):首启用种子 seed、之后活在 store;opt-in 保守强度演化。
 * **默认(无 store、无 evolver):current() 恒等于种子 → 严格等价当前只读种子。**
 */
export class SelfNotionsManager {
  readonly #seedNotions: readonly SelfNotion[];
  readonly #store: SelfNotionStore | undefined;
  readonly #evolver: SelfNotionEvolver | undefined;
  readonly #maxDelta: number;
  readonly #now: () => string;
  #state: SelfNotionsState;

  constructor(opts: SelfNotionsManagerOptions) {
    this.#seedNotions = opts.seedNotions;
    this.#store = opts.store;
    this.#evolver = opts.evolver;
    this.#maxDelta = opts.maxDeltaPerStep ?? MAX_STRENGTH_DELTA_PER_STEP;
    this.#now = opts.now ?? (() => new Date().toISOString());

    const loaded = this.#store?.load() ?? null;
    if (loaded !== null) {
      this.#state = loaded;
    } else {
      // 首启:用种子初始化;若有 store,seed 落库一次(之后活在 store)。
      this.#state = seedToState(this.#seedNotions);
      this.#store?.save(this.#state);
    }
  }

  /** 当前(可能已演化的)立场集,直接喂给 stance 检测。 */
  current(): readonly SelfNotion[] {
    return this.#state.notions;
  }

  /** 当前持久化状态(含 version/history,供 trace/测试)。 */
  state(): SelfNotionsState {
    return this.#state;
  }

  /**
   * 推进一轮(opt-in 演化):若注入了 evolver 且其判定确立了某些立场 → 钳制增量 → 应用 →
   * 追加版本快照 → 持久化。未注入 evolver = no-op(立场恒定)。
   * 任何失败/null/全零都跳过、不写、立场不变、绝不抛(§3.2 优雅降级)。
   */
  async advance(userText: string, turn: number): Promise<void> {
    const evolver = this.#evolver;
    if (evolver === undefined) return;

    let deltas: readonly SelfNotionStrengthDelta[] | null;
    try {
      deltas = await evolver.evolve({ userText, notions: this.#state.notions, turn });
    } catch {
      return; // 演化失败 → 立场不变,回合不受影响。
    }
    if (deltas === null || deltas.length === 0) return;

    const at = this.#now();
    let notions = this.#state.notions;
    let history: readonly SelfNotionSnapshot[] = this.#state.history ?? [];
    let changed = false;

    for (const req of deltas) {
      const delta = clampStrengthDelta(req.delta, this.#maxDelta);
      if (delta === 0) continue; // 全零/无效 → 跳过该条。
      const key = normalize(req.topicKey);
      const idx = notions.findIndex((n) => topicKeyOf(n) === key);
      if (idx < 0) continue; // 定位不到 → 跳过(不新增条目,本切片只演化已有立场)。

      const target = notions[idx]!;
      const before = effectiveStrength(target);
      const updated = applyStrengthDelta(target, delta);
      const after = effectiveStrength(updated);
      if (after === before) continue; // 已封顶 → 无实际变化,不写快照。

      const next = notions.slice();
      next[idx] = updated;
      notions = next;
      history = [...history, buildSelfNotionSnapshot(before, after, delta, turn, key, at)];
      changed = true;
    }

    if (!changed) return; // 无任何实际演化 → 不写。
    this.#state = { version: this.#state.version, notions, history };
    this.#store?.save(this.#state);
  }
}
