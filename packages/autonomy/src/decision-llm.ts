/**
 * 决策 LLM(silent|speak|idle)—— 主动回合的「是否值得说」判断核心(承 §7 + proactive-turn spec)。
 *
 * §3.2「把 LLM 关进笼子」:这是 **schema 约束的确定性边界调用**——
 *   输入 = 技能候选 + gather 的 context(情绪/未了话题/时间);
 *   输出 schema = `{decision ∈ {silent,speak,idle}, reason, text?}`(**给模型显式「沉默」选项,默认偏 silent**);
 *   失败/超时 → 默认 `silent`(永不刷屏、永不崩,§3.2)。
 *
 * 复用 `providers` 的 `LlmProvider`(测试用 `FakeLlm`);用 `tolerantJsonParse` 容错解析(剥围栏/截平衡块)。
 * 决策(含 reason + 输入摘要)经注入的 `AutonomyDecisionSink` 落 §8.1 trace。
 *
 * **衰减概率 governor**(承 tasks 1.3):在 LLM 之前先过一道**确定性概率闸**——
 *   base speak rate 由 PAD/OCEAN 调制(默认低,restraint-first),用注入的 `rng()`(可测)抽样;
 *   未过闸直接 silent(连 LLM 都不调,省成本 + 更克制);过闸才问 LLM。
 *   闸纯函数化,rng 注入,完全确定可测。
 */
import { tolerantJsonParse } from '@chat-a/providers';
import type { LlmProvider, LlmRequest } from '@chat-a/providers';
import type {
  AutonomyDecisionInput,
  AutonomyDecisionKind,
  AutonomyDecisionSink,
  AutonomyDecisionTrace,
} from './decision-trace';
import { NoopAutonomyDecisionSink } from './decision-trace';
import type { Clock } from './types';

/** 决策 LLM 的最终裁决(供调度层据此走 requestSpeak / 沉默)。 */
export interface DecisionResult {
  readonly decision: AutonomyDecisionKind;
  readonly reason: string;
  /** speak 时拟说文案(经 persona guardrail 后);silent/idle 省略。 */
  readonly text?: string;
  /** 是否为降级(LLM 失败/超时/闸未过)而非模型正解。 */
  readonly fellBack: boolean;
}

/** persona guardrail 接缝(§7):speak 前对拟说文案做人格护栏(裁剪/否决/改写)。 */
export interface PersonaGuardrail {
  /**
   * 对一条拟说文案做护栏检查。返回:
   * - `{ ok: true, text }`:放行(可改写 text);
   * - `{ ok: false, reason }`:否决(转为 silent)。
   */
  check(text: string): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };
}

/** 默认护栏:原样放行(无人格约束时;接线层注入真实现)。 */
export const PASSTHROUGH_GUARDRAIL: PersonaGuardrail = {
  check: (text) => ({ ok: true, text }),
};

/** 衰减概率 governor 旋钮(行为即配置;无 magic number)。 */
export interface SpeakGovernorOptions {
  /** base speak rate ∈ [0,1]:闸放行概率基线(默认低,克制优先)。 */
  readonly baseSpeakRate: number;
  /** PAD/OCEAN 调制偏置 ∈ [-1,1]:正=更想说(高 arousal/外向),负=更克制。默认 0。 */
  readonly affectBias: number;
}

export const DEFAULT_SPEAK_GOVERNOR_OPTIONS: SpeakGovernorOptions = {
  baseSpeakRate: 0.25, // 默认四次只放行一次:restraint-first
  affectBias: 0,
};

/**
 * 衰减概率闸(纯函数 + 注入 rng):返回是否放行去问 LLM。
 * 有效放行率 = clamp(baseSpeakRate + affectBias * 0.5, 0, 1);抽样 `rng() < rate`。
 */
export function speakGovernorPass(opts: SpeakGovernorOptions, rng: () => number): boolean {
  const rate = Math.min(1, Math.max(0, opts.baseSpeakRate + opts.affectBias * 0.5));
  return rng() < rate;
}

/** 决策 LLM 构造依赖(全注入,确定可测;§3.1 + §3.2)。 */
export interface DecisionLlmDeps {
  readonly llm: LlmProvider;
  readonly clock: Clock;
  /** 决策超时(ms):超时 → 默认 silent(永不刷屏)。默认 1500。 */
  readonly timeoutMs?: number;
  /** persona guardrail(默认原样放行)。 */
  readonly guardrail?: PersonaGuardrail;
  /** 决策 trace 写入(默认 Noop)。 */
  readonly sink?: AutonomyDecisionSink;
  /** 衰减概率 governor 旋钮 + rng(默认保守 base rate + Math.random)。 */
  readonly governor?: Partial<SpeakGovernorOptions>;
  readonly rng?: () => number;
  /** 决策用 system 提示(可覆盖;默认内置「多数沉默」提示)。 */
  readonly systemPrompt?: string;
  /**
   * 每日主动开口上限(§11 调参):当天真 speak 累计达到此值后,后续一律强制 silent,跨日自动重置。
   * 缺省 0 = 不限(只有真 speak 计数;silent/idle/降级都不计)。装配层默认传 3。
   */
  readonly dailyCap?: number;
}

/** 默认决策超时(ms):主动决策非用户热路径,给宽松上限但仍有界。 */
const DEFAULT_TIMEOUT_MS = 1500;

/** 默认决策 system 提示:显式给「沉默」选项、强调 restraint-first。 */
const DEFAULT_SYSTEM_PROMPT = [
  '你是一个长期语音陪伴体的「是否开口」决策器。多数时候应当**沉默**(silent)——只有当主动开口确有价值时才 speak。',
  '严格只输出 JSON,形如 {"decision":"silent|speak|idle","reason":"简短中文理由","text":"speak 时要说的话,其余省略"}。',
  'decision 取值:silent=此刻不开口;speak=值得主动说,并在 text 给出口语;idle=无事可做,进入空闲。',
  '默认偏向 silent。不要寒暄、不要刷存在感。',
].join('\n');

export class DecisionLlm {
  readonly #llm: LlmProvider;
  readonly #clock: Clock;
  readonly #timeoutMs: number;
  readonly #guardrail: PersonaGuardrail;
  readonly #sink: AutonomyDecisionSink;
  readonly #governor: SpeakGovernorOptions;
  readonly #rng: () => number;
  readonly #systemPrompt: string;
  /** 每日主动开口上限(0=不限);#capDay/#capCount 记当天计数,跨日重置。 */
  readonly #dailyCap: number;
  #capDay: string | null = null;
  #capCount = 0;

  constructor(deps: DecisionLlmDeps) {
    this.#llm = deps.llm;
    this.#clock = deps.clock;
    this.#timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#guardrail = deps.guardrail ?? PASSTHROUGH_GUARDRAIL;
    this.#sink = deps.sink ?? new NoopAutonomyDecisionSink();
    this.#governor = { ...DEFAULT_SPEAK_GOVERNOR_OPTIONS, ...deps.governor };
    this.#rng = deps.rng ?? Math.random;
    this.#systemPrompt = deps.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.#dailyCap = deps.dailyCap ?? 0;
  }

  /** 自注入时钟的 ms 取「当天」键(UTC 日,YYYY-MM-DD);带参 `new Date(ms)` 合法且确定可测。 */
  #dayKey(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
  }

  /**
   * 决策一次:候选 + context → `{decision, reason, text?}`。
   * 顺序:
   *   0. 无候选 → 直接 silent(没什么可说)。
   *   1. 衰减概率闸:未过 → silent(连 LLM 都不问,省成本 + 克制)。
   *   2. 调决策 LLM(带超时);失败/超时 → silent(降级,fellBack=true)。
   *   3. 解析 schema;非法/缺字段 → silent(降级)。
   *   4. speak → persona guardrail;否决 → silent。
   * 全程把决策 + reason + 输入摘要落 trace(§8.1)。
   */
  async decide(
    input: AutonomyDecisionInput,
    ctx?: { readonly skillId: string; readonly correlationId?: string },
  ): Promise<DecisionResult> {
    const skillId = ctx?.skillId ?? 'unknown';
    const correlationId = ctx?.correlationId;

    // 0. 无候选:无话可说。
    if (input.candidates.length === 0) {
      return this.#finish({ decision: 'silent', reason: 'silent: 无候选,无话可说', fellBack: false }, input, skillId, correlationId);
    }

    // 0.5 每日上限闸(§11 调参):当天真 speak 已达上限 → 强制 silent;跨日重置。
    const today = this.#dayKey(this.#clock.now());
    if (this.#capDay !== today) {
      this.#capDay = today;
      this.#capCount = 0;
    }
    if (this.#dailyCap > 0 && this.#capCount >= this.#dailyCap) {
      return this.#finish(
        { decision: 'silent', reason: `silent: 当日主动开口已达上限(${this.#dailyCap} 次)`, fellBack: false },
        input,
        skillId,
        correlationId,
      );
    }

    // 1. 衰减概率闸(克制优先):未过则不问 LLM,直接沉默。
    if (!speakGovernorPass(this.#governor, this.#rng)) {
      return this.#finish(
        { decision: 'silent', reason: 'silent: 衰减概率闸未放行(restraint-first)', fellBack: false },
        input,
        skillId,
        correlationId,
      );
    }

    // 2. 调决策 LLM(带超时)。
    let raw: string;
    try {
      raw = await this.#callWithTimeout(input);
    } catch (err) {
      return this.#finish(
        { decision: 'silent', reason: `silent: 决策 LLM 失败/超时退回沉默(${String((err as Error)?.message ?? err)})`, fellBack: true },
        input,
        skillId,
        correlationId,
      );
    }

    // 3. 解析 schema。
    const parsed = parseDecision(raw);
    if (parsed === null) {
      return this.#finish(
        { decision: 'silent', reason: 'silent: 决策 LLM 输出非法 JSON/缺字段,退回沉默', fellBack: true },
        input,
        skillId,
        correlationId,
      );
    }

    if (parsed.decision !== 'speak') {
      // silent / idle:直接采纳。
      return this.#finish(
        { decision: parsed.decision, reason: parsed.reason || `${parsed.decision}: 模型判定`, fellBack: false },
        input,
        skillId,
        correlationId,
      );
    }

    // 4. speak → 须有 text + 过 persona guardrail。
    const text = parsed.text?.trim() ?? '';
    if (text.length === 0) {
      return this.#finish(
        { decision: 'silent', reason: 'silent: 模型选 speak 但未给 text,降级沉默', fellBack: true },
        input,
        skillId,
        correlationId,
      );
    }
    const guard = this.#guardrail.check(text);
    if (!guard.ok) {
      return this.#finish(
        { decision: 'silent', reason: `silent: persona guardrail 否决(${guard.reason})`, fellBack: false },
        input,
        skillId,
        correlationId,
      );
    }
    // 只有真 speak(过 guardrail)才计入当日上限;silent/idle/降级一律不计。
    this.#capCount += 1;
    return this.#finish(
      { decision: 'speak', reason: parsed.reason || 'speak: 模型判定值得主动开口', text: guard.text, fellBack: false },
      input,
      skillId,
      correlationId,
    );
  }

  /** 调 LLM.complete 带超时(超时 reject;不真取消底层,仅决策端放弃 → silent)。 */
  async #callWithTimeout(input: AutonomyDecisionInput): Promise<string> {
    const req: LlmRequest = {
      system: this.#systemPrompt,
      messages: [{ role: 'user', content: renderDecisionPrompt(input) }],
    };
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new Error('decision-llm 超时'));
      }, this.#timeoutMs);
    });
    try {
      return await Promise.race([this.#llm.complete(req, ac.signal), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 收尾:落 trace(§8.1)+ 返回结果(record 异常自吞,§3.2)。 */
  #finish(
    result: DecisionResult,
    input: AutonomyDecisionInput,
    skillId: string,
    correlationId: string | undefined,
  ): DecisionResult {
    const trace: AutonomyDecisionTrace = {
      skillId,
      atMs: this.#clock.now(),
      decision: result.decision,
      reason: result.reason,
      input,
      ...(result.text !== undefined ? { text: result.text } : {}),
      ...(result.fellBack ? { fellBack: true } : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
    };
    try {
      this.#sink.record(trace);
    } catch (err) {
      console.warn('[DecisionLlm] 决策 trace 写入抛错(已捕获):', err);
    }
    return result;
  }
}

/** 把候选 + context 渲染为决策 LLM 的 user 提示。 */
export function renderDecisionPrompt(input: AutonomyDecisionInput): string {
  const lines: string[] = [];
  lines.push('【候选发言】');
  input.candidates.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
  if (input.context !== undefined && input.context.trim().length > 0) {
    lines.push('【上下文】');
    lines.push(input.context.trim());
  }
  lines.push('请据上面判断此刻是否值得主动开口,严格输出 JSON。');
  return lines.join('\n');
}

/** 解析决策 JSON;非法/缺字段返回 null(调用方降级 silent)。 */
export function parseDecision(
  raw: string,
): { readonly decision: AutonomyDecisionKind; readonly reason: string; readonly text?: string } | null {
  const obj = tolerantJsonParse(raw);
  if (obj === null || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  const decision = rec['decision'];
  if (decision !== 'silent' && decision !== 'speak' && decision !== 'idle') return null;
  const reason = typeof rec['reason'] === 'string' ? rec['reason'] : '';
  const text = typeof rec['text'] === 'string' ? rec['text'] : undefined;
  return text !== undefined ? { decision, reason, text } : { decision, reason };
}
