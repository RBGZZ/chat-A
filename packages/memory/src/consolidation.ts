import type { LlmProvider } from '@chat-a/providers';
import { tolerantJsonParse } from '@chat-a/providers';
import { resolveConsolidationConfig, type ConsolidationConfig } from './config';
import type { ChatMessage, MemoryRecord, MemoryStore } from './types';

/**
 * 夜间/周期巩固流水线(承 §5.1/§5.8/§5.10 B2):像睡眠一样固化记忆——
 * 触发编排(会话结束 / 每日 / 每 N 轮)+ 离线双 Pass 调和(add/update/delete/discard)+
 * 惊奇门控编码(Nemori predict-calibrate)+ 整块重写(Letta)+ 可回放(§8.1)。
 *
 * 硬约束(承 §5.8 避坑):**全后台**(不挡热路径)、**LLM 不在热路径决定 update/delete**、
 * **单一权威衰减公式**(discard=加速衰减,不改 recall)、**delete 保守**(默认 discard、core/pinned 豁免)、
 * **喂 LLM 用临时整数 ID 抗幻觉**(回映真 UUID/id 落库)。失败仅告警、优雅降级(§3.2)。
 *
 * 计时驱动留接缝:本模块只提供"巩固入口 + 纯函数触发判定";实际计时由调用方(cli/autonomy/未来 cron)驱动。
 */

// —— 触发判定(纯函数,可注入时钟,可测;承 design 决策 1)——

/** 巩固触发类型(承设计三类触发)。 */
export type ConsolidationTriggerKind = 'session-end' | 'daily' | 'every-n-turns';

/** 一次触发请求(承 §5.1 三类触发)。 */
export interface ConsolidationTrigger {
  readonly kind: ConsolidationTriggerKind;
  /**
   * 巩固单元标识(幂等键 + trace 单元):
   * - session-end:`session:<sessionId>`(同一会话只巩固一次);
   * - daily:`daily:<YYYY-MM-DD>`(同一天只巩固一次);
   * - every-n-turns:由调用方给(如 `turns:<sessionId>:<batchIndex>`)。
   */
  readonly unit: string;
}

/** 触发判定所需的状态快照(由调用方/编排层提供;承 design 决策 1 可注入)。 */
export interface ConsolidationState {
  /** 上次巩固的时刻(ms);从未巩固为 undefined。 */
  readonly lastConsolidatedAtMs?: number;
  /** 距上次巩固以来累计的对话轮数(每 N 轮触发用);未知为 0。 */
  readonly turnsSinceLast?: number;
}

/** 触发判定用配置子集(从 ConsolidationConfig 取,行为即配置)。 */
export type ConsolidationTriggerParams = Pick<
  ConsolidationConfig,
  'enabled' | 'dailyIntervalDays' | 'everyNTurns'
>;

const MS_PER_DAY = 86_400_000;

/**
 * 巩固触发判定(纯函数,承 design 决策 1):
 * - `enabled==='off'` → 永远 false(优雅降级,§3.2)。
 * - `session-end`:会话结束恒触发(幂等由 runConsolidation 的存在性检查兜底,不在此判重)。
 * - `daily`:距上次巩固 ≥ `dailyIntervalDays` 天才触发(从未巩固也触发)。
 * - `every-n-turns`:`turnsSinceLast ≥ everyNTurns` 才触发。
 * `clock` 注入"现在"(确定性测试);纯函数无副作用、无 LLM。
 */
export function shouldConsolidate(
  trigger: ConsolidationTrigger,
  state: ConsolidationState,
  clock: number,
  params: ConsolidationTriggerParams,
): boolean {
  if (params.enabled === 'off') return false;
  switch (trigger.kind) {
    case 'session-end':
      return true;
    case 'daily': {
      const last = state.lastConsolidatedAtMs;
      if (last === undefined) return true; // 从未巩固:首日即可。
      const days = Math.max(0, (clock - last) / MS_PER_DAY);
      return days >= params.dailyIntervalDays;
    }
    case 'every-n-turns':
      return (state.turnsSinceLast ?? 0) >= params.everyNTurns;
    default:
      return false;
  }
}

// —— 双 Pass 调和的 LLM 契约(抗幻觉:只见临时整数 ID,见 §5.8 决策 2)——

/**
 * Pass2 调和返回的一条 diff(LLM 只见临时整数 ID;代码回映真 id 落库)。
 * - `add`:新增一条记忆(text 必给;ref 忽略)。
 * - `update`:整块重写既有记忆(ref=既有记忆的临时整数 ID;text=新 clean summary)。
 * - `delete`:判定该既有记忆应删(ref;代码保守落为 discard=加速衰减,不物理删)。
 * - `discard`:同 delete 语义(显式 discard;ref)。
 */
interface ReconcileOp {
  readonly action: 'add' | 'update' | 'delete' | 'discard';
  /** 既有记忆的临时整数 ID(update/delete/discard 用;add 忽略)。 */
  readonly ref?: number;
  /** 新正文(add/update 用)。 */
  readonly text?: string;
  /** 决策理由(可回放,§8.1)。 */
  readonly reason?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 把 LLM 返回校验为 ReconcileOp[](丢弃非法项,抗噪)。 */
function toReconcileOps(v: unknown): ReconcileOp[] {
  const arr = isRecord(v) && Array.isArray(v['ops']) ? v['ops'] : Array.isArray(v) ? v : [];
  const out: ReconcileOp[] = [];
  for (const raw of arr) {
    if (!isRecord(raw)) continue;
    const action = raw['action'];
    if (action !== 'add' && action !== 'update' && action !== 'delete' && action !== 'discard') continue;
    const ref = typeof raw['ref'] === 'number' ? raw['ref'] : undefined;
    const text = typeof raw['text'] === 'string' ? raw['text'].trim() : undefined;
    const reason = typeof raw['reason'] === 'string' ? raw['reason'].trim() : undefined;
    // add/update 必须有 text;update/delete/discard 必须有 ref。
    if ((action === 'add' || action === 'update') && (text === undefined || text.length === 0)) continue;
    if ((action === 'update' || action === 'delete' || action === 'discard') && ref === undefined) continue;
    out.push({
      action,
      ...(ref !== undefined ? { ref } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
  }
  return out;
}

/** 惊奇门控返回:只蒸馏"预料之外"的 gap(承 §5.10 B2① Nemori)。 */
function toSurpriseGaps(v: unknown): string[] {
  const arr = isRecord(v) && Array.isArray(v['gaps']) ? v['gaps'] : Array.isArray(v) ? v : [];
  const out: string[] = [];
  for (const raw of arr) {
    const text = typeof raw === 'string' ? raw : isRecord(raw) && typeof raw['text'] === 'string' ? raw['text'] : undefined;
    if (text !== undefined && text.trim().length > 0) out.push(text.trim());
  }
  return out;
}

// —— 提示构造(LLM 只见临时整数 ID;承 §5.8 决策 2 抗幻觉)——

/** 把候选 + 既有记忆渲染为临时整数列表喂 LLM(`[i] 文本`);返回 i→真 id 回映表。 */
function renderIndexed(records: readonly MemoryRecord[]): { text: string; idByTemp: Map<number, number> } {
  const idByTemp = new Map<number, number>();
  const lines: string[] = [];
  records.forEach((r, i) => {
    const temp = i + 1; // 临时整数从 1 起。
    idByTemp.set(temp, r.id);
    lines.push(`[${temp}] (${r.memoryKind ?? 'episodic'}/${r.subject}) ${r.text}`);
  });
  return { text: lines.join('\n'), idByTemp };
}

function buildReconcilePrompt(candidates: string, existing: string): string {
  return [
    '你在做记忆「离线调和」:把近期新候选记忆与既有记忆对标,消解矛盾、合并重复、淘汰过时。',
    '严格规则:',
    '- 只用方括号里的**整数编号**引用既有记忆(如 [2]);不要编造编号。',
    '- 矛盾(如旧偏好被新事实推翻)→ 输出 update(整块重写为新的 clean summary)或 discard,而不是新增矛盾条目。',
    '- 已被既有记忆覆盖的候选 → 不要重复 add。',
    '- 确无对应既有记忆的全新事实 → add。',
    '只输出 JSON,形如:',
    '{"ops":[{"action":"update","ref":2,"text":"用户现在喜欢茶","reason":"旧记忆说喜欢咖啡,新候选推翻"},{"action":"add","text":"...","reason":"..."},{"action":"discard","ref":5,"reason":"过时"}]}',
    '',
    '【近期新候选】',
    candidates.length > 0 ? candidates : '(无)',
    '',
    '【既有记忆(用编号引用)】',
    existing.length > 0 ? existing : '(无)',
  ].join('\n');
}

function buildSurprisePrompt(episode: string, semantic: string): string {
  return [
    '你在做记忆「惊奇门控编码」(predict-calibrate):',
    '先用【已有语义记忆】预测【这段情景】会发生什么,再对比情景原文,只挑出**预料之外**(已有语义无法预测)的要点。',
    '已能被已有语义预测的内容**不要**重复记录。没有意外则返回空数组。',
    '只输出 JSON,形如 {"gaps":["小雪第一次得知用户对花生过敏"]};每条简洁、第三人称陈述。',
    '',
    '【已有语义记忆】',
    semantic.length > 0 ? semantic : '(无)',
    '',
    '【这段情景原文】',
    episode,
  ].join('\n');
}

// —— 编排器选项 ——

export interface ConsolidatorOptions {
  readonly provider: LlmProvider;
  readonly store: MemoryStore;
  readonly config?: Partial<ConsolidationConfig>;
  /** 注入时钟(确定性测试,§3.2);省略用 Date.now。 */
  readonly now?: () => number;
  readonly onError?: (err: unknown) => void;
}

/**
 * 一次巩固的输入材料(由调用方/编排层组织;承本 change「巩固入口」接缝):
 * - `candidates`:近期记忆候选(Pass1 已提取;通常为近期 episodic/抽取条目)。
 * - `existing`:待对标的既有记忆(Pass2 对标对象;通常为同主题/近期 semantic)。
 * - `episodeText`:本情景原文(惊奇门控的 calibrate 源;可空 → 跳过惊奇门控)。
 * - `existingSemantic`:已有语义记忆(惊奇门控的 predict 源;可空)。
 */
export interface ConsolidationInput {
  readonly candidates: readonly MemoryRecord[];
  readonly existing: readonly MemoryRecord[];
  readonly episodeText?: string;
  readonly existingSemantic?: readonly MemoryRecord[];
}

/** 一次巩固的结果摘要(供调用方/测试断言;非持久化)。 */
export interface ConsolidationResult {
  readonly ran: boolean;
  readonly added: number;
  readonly updated: number;
  readonly discarded: number;
  readonly surpriseDistilled: number;
}

const SKIPPED: ConsolidationResult = { ran: false, added: 0, updated: 0, discarded: 0, surpriseDistilled: 0 };

/**
 * 夜间巩固编排器(承 §5.1):后台 async、幂等、失败仅告警。
 * 复用 reflector 的 LLM 端口(注入 fake 可测);全程不挡热路径(由调用方在空闲/夜间 fire-and-forget)。
 */
export class Consolidator {
  readonly #provider: LlmProvider;
  readonly #store: MemoryStore;
  readonly #cfg: ConsolidationConfig;
  readonly #now: () => number;
  readonly #onError: ((err: unknown) => void) | undefined;

  constructor(opts: ConsolidatorOptions) {
    this.#provider = opts.provider;
    this.#store = opts.store;
    this.#cfg = resolveConsolidationConfig(opts.config);
    this.#now = opts.now ?? Date.now;
    this.#onError = opts.onError;
  }

  /** 触发判定(实例便捷封装纯函数 shouldConsolidate;用本编排器的配置 + 时钟)。 */
  shouldRun(trigger: ConsolidationTrigger, state: ConsolidationState): boolean {
    return shouldConsolidate(trigger, state, this.#now(), this.#cfg);
  }

  /**
   * 运行一次巩固(承 §5.1):
   * 1) 幂等:`kv_state[stateKeyPrefix+unit]` 存在则跳过(沿用 reflector 模式)。
   * 2) Pass2 离线调和:候选 vs 既有 → diff{add/update/delete/discard}(LLM 见临时整数 ID,回映落库)。
   * 3) 惊奇门控:predict-calibrate 取 gap → 只蒸馏 gap 入语义(失败退回不门控、跳过)。
   * 4) 可回放:每步落 consolidation_trace(§8.1)。
   * 5) 成功后打幂等标记。
   * 全程 try/catch、失败仅告警、绝不抛(承 §3.2 fire-and-forget)。
   */
  async run(unit: string, input: ConsolidationInput): Promise<ConsolidationResult> {
    if (this.#cfg.enabled === 'off') return SKIPPED;
    const stateKey = this.#cfg.stateKeyPrefix + unit;
    // 幂等:已巩固过该单元则安静跳过(不调 LLM、不写)。
    try {
      if (this.#store.getState(stateKey) !== undefined) return SKIPPED;
    } catch (err) {
      this.#onError?.(err);
      return SKIPPED;
    }

    let added = 0;
    let updated = 0;
    let discarded = 0;
    let surpriseDistilled = 0;
    const at = this.#now();

    try {
      // —— Pass2 离线双 Pass 调和(承 §5.8)——
      const diff = await this.#reconcile(unit, input, at);
      added += diff.added;
      updated += diff.updated;
      discarded += diff.discarded;

      // —— 惊奇门控编码(承 §5.10 B2①;失败退回不门控、跳过该步)——
      surpriseDistilled += await this.#surpriseGate(unit, input, at);
    } catch (err) {
      // 巩固过程报错:仅告警,主对话/同步 recall 不受影响(§3.2)。不打幂等标记(允许下次重试)。
      this.#onError?.(err);
      return { ran: false, added, updated, discarded, surpriseDistilled };
    }

    // 打幂等标记(承 reflector 模式):记录巩固时刻与产出,供下次存在性检查跳过。
    try {
      this.#store.setState(
        stateKey,
        JSON.stringify({ at, added, updated, discarded, surpriseDistilled }),
      );
    } catch (err) {
      this.#onError?.(err);
    }
    return { ran: true, added, updated, discarded, surpriseDistilled };
  }

  /**
   * Pass2 调和(承 §5.8 决策 2/3):候选 + 既有 → LLM diff → 回映真 id 落库。
   * - 喂 LLM 用临时整数 ID(抗幻觉);返回 diff 引用整数 → 回映真 id。
   * - add 走既有 ADD(复用去重);update 整块重写(Letta 式);delete/discard → 保守 markDiscarded(加速衰减)。
   * - core/pinned 永不删改(由 store.updateMemory/markDiscarded 内部豁免兜底)。
   * - 无候选且无既有 → 不调 LLM(省成本)。
   */
  async #reconcile(
    unit: string,
    input: ConsolidationInput,
    at: number,
  ): Promise<{ added: number; updated: number; discarded: number }> {
    let added = 0;
    let updated = 0;
    let discarded = 0;

    // 既有记忆对标范围封顶(抗 token 失控 + 临时整数 ID 范围;承 §5.8 决策 2)。
    const existing = input.existing.slice(0, this.#cfg.maxReconcileCandidates);
    if (input.candidates.length === 0 && existing.length === 0) {
      return { added, updated, discarded };
    }

    const cand = renderIndexed(input.candidates);
    const exist = renderIndexed(existing);
    const text = await this.#provider.complete({
      system: '你是记忆离线调和器,只输出 JSON,只用方括号整数编号引用既有记忆,不要编造编号。',
      messages: [{ role: 'user', content: buildReconcilePrompt(cand.text, exist.text) }],
      maxTokens: this.#cfg.maxTokens,
    });
    const ops = toReconcileOps(tolerantJsonParse(text));

    for (const op of ops) {
      if (op.action === 'add' && op.text !== undefined) {
        // add 走既有 ADD(复用 SimHash/LSH 去重;新事实落语义)。
        const id = this.#store.addMemory({ text: op.text, kind: 'consolidated', memoryKind: 'semantic' });
        if (id > 0) {
          added += 1;
          this.#store.recordConsolidationTrace({
            unit, kind: 'add', memoryId: id, reason: op.reason ?? '调和新增', atMs: at,
            detail: JSON.stringify({ text: op.text }),
          });
        }
        continue;
      }
      // update/delete/discard:把临时整数 ID 回映为真 id(只接受**既有**编号,抗幻觉乱引)。
      const realId = op.ref !== undefined ? exist.idByTemp.get(op.ref) : undefined;
      if (realId === undefined) continue; // 越界/幻觉编号:丢弃(宁可漏改不可错改,§5.8)。

      if (op.action === 'update' && op.text !== undefined) {
        // 整块重写(Letta 式,承 §5.10 B2②):clean summary 覆盖;core/pinned 由 store 内部豁免返回 false。
        const ok = this.#store.updateMemory(realId, { text: op.text, atMs: at });
        if (ok) {
          updated += 1;
          this.#store.recordConsolidationTrace({
            unit, kind: 'update', memoryId: realId, reason: op.reason ?? '调和重写', atMs: at,
            detail: JSON.stringify({ tempRef: op.ref, newText: op.text }),
          });
        }
      } else if (op.action === 'delete' || op.action === 'discard') {
        // delete 保守(承 §5.8 决策 3):不物理删,落 markDiscarded(加速衰减);core/pinned 由 store 豁免。
        const ok = this.#store.markDiscarded(realId, at);
        if (ok) {
          discarded += 1;
          this.#store.recordConsolidationTrace({
            unit, kind: 'discard', memoryId: realId,
            reason: op.reason ?? '调和判定过时/矛盾(保守 discard,非物理删)', atMs: at,
            detail: JSON.stringify({ tempRef: op.ref, action: op.action }),
          });
        }
      }
    }
    return { added, updated, discarded };
  }

  /**
   * 惊奇门控编码(承 §5.10 B2① Nemori predict-calibrate;放夜间 dream pass,有 LLM 预算):
   * 由已有语义记忆预测本情景 → 对比原文取 prediction gap → 只把 gap 蒸馏入语义。
   * 失败(LLM 抛/解析失败)→ 退回"不门控、照常蒸馏",不崩溃(优雅降级,§3.2)。
   * 无情景原文 → 跳过(无可校准对象)。
   */
  async #surpriseGate(unit: string, input: ConsolidationInput, at: number): Promise<number> {
    const episode = input.episodeText?.trim();
    if (episode === undefined || episode.length === 0) return 0;
    const semantic = renderIndexed(input.existingSemantic ?? []);
    try {
      const text = await this.#provider.complete({
        system: '你是惊奇门控编码器(predict-calibrate),只输出 JSON,只挑预料之外的要点。',
        messages: [{ role: 'user', content: buildSurprisePrompt(episode, semantic.text) }],
        maxTokens: this.#cfg.maxTokens,
      });
      const gaps = toSurpriseGaps(tolerantJsonParse(text));
      let distilled = 0;
      for (const gap of gaps) {
        // 只把 prediction gap 蒸馏入语义(承 §5.10 B2①);复用 ADD+去重(与热路径去重并存)。
        const id = this.#store.addMemory({ text: gap, kind: 'surprise', memoryKind: 'semantic' });
        if (id > 0) {
          distilled += 1;
          this.#store.recordConsolidationTrace({
            unit, kind: 'surprise', memoryId: id,
            reason: '惊奇门控:已有语义无法预测的 prediction gap', atMs: at,
            detail: JSON.stringify({ gap }),
          });
        }
      }
      return distilled;
    } catch (err) {
      // 门控失败:退回"不门控、照常蒸馏"——把整段情景作为一条 episodic 落库(不丢信息,§3.2)。
      this.#onError?.(err);
      try {
        const id = this.#store.addMemory({ text: episode, kind: 'episode-fallback', memoryKind: 'episodic' });
        if (id > 0) {
          this.#store.recordConsolidationTrace({
            unit, kind: 'surprise', memoryId: id,
            reason: '惊奇门控失败,降级为不门控照常蒸馏(整段情景入 episodic)', atMs: at,
          });
          return 1;
        }
      } catch (err2) {
        this.#onError?.(err2);
      }
      return 0;
    }
  }
}

/** 把一段消息渲染为情景原文(承 §5.10 B2① 惊奇门控的 calibrate 源;供调用方组织 ConsolidationInput)。 */
export function renderEpisode(messages: readonly ChatMessage[]): string {
  return messages
    .map((m) => `${m.role === 'assistant' ? '小雪' : m.role === 'user' ? '用户' : m.role}：${m.content}`)
    .join('\n');
}
