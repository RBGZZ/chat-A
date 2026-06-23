import type {
  Appraiser,
  Emotion,
  Ocean,
  OceanDeltaSnapshot,
  OceanEvolver,
  Pad,
  PersonaConfig,
  PersonaSeed,
  PersonaSnapshot,
  PersonaStore,
  Posture,
} from './types';
import { DEFAULT_PERSONA_CONFIG } from './defaults';
import { oceanToPadBaseline, padToEmotion, stepPad } from './numeric';
import { renderToneFragment } from './tone';
import { resolveNegativePosture } from './posture';
import { DefaultAppraiser } from './appraiser';
import { InMemoryPersonaStore } from './store';
import { applyOceanDelta, buildDeltaSnapshot, clampOceanDelta, isZeroDelta, shouldEvolve } from './ocean-evolution';

export interface ToneView {
  readonly emotion: Emotion;
  readonly toneFragment: string;
  /** 当前 PAD 状态(供决策 trace 记录"当时心情",§8.1)。 */
  readonly pad: Pad;
  /** 当轮负面人际姿态(§7#6);无则 null。 */
  readonly posture: Posture | null;
}

export interface PersonaEngineOptions {
  readonly seed: PersonaSeed;
  readonly appraiser?: Appraiser;
  readonly store?: PersonaStore;
  readonly config?: PersonaConfig;
  /**
   * 二级 OCEAN 演化接缝(§6.1,默认关)。**不注入 = OCEAN 恒定**(沿用 LLM 升级 opt-in 范式)。
   * 注入后,每 config.evolutionEveryTurns 轮在 advance() 内部触发一次,失败/null 降级跳过。
   */
  readonly oceanEvolver?: OceanEvolver;
  /** 注入当前时钟(测试可控);默认 `() => new Date().toISOString()`,用于演化快照时间戳。 */
  readonly now?: () => string;
}

/**
 * 人格引擎:绑定种子/旋钮/评估器/持久化,驱动每轮情绪步进(承 §6.1 流程)。
 * 首启从 store 载入快照;无则用种子初始化(OCEAN=种子、PAD=基线)。
 */
export class PersonaEngine {
  readonly #seed: PersonaSeed;
  readonly #config: PersonaConfig;
  readonly #appraiser: Appraiser;
  readonly #store: PersonaStore;
  readonly #oceanEvolver: OceanEvolver | undefined;
  readonly #now: () => string;
  /** 本演化周期累积的用户输入(进程内窗口;触发演化后清空,不持久化)。 */
  #recentUserTexts: string[] = [];
  #snapshot: PersonaSnapshot;

  constructor(opts: PersonaEngineOptions) {
    this.#seed = opts.seed;
    this.#config = opts.config ?? DEFAULT_PERSONA_CONFIG;
    this.#appraiser = opts.appraiser ?? new DefaultAppraiser();
    this.#store = opts.store ?? new InMemoryPersonaStore();
    this.#oceanEvolver = opts.oceanEvolver;
    this.#now = opts.now ?? (() => new Date().toISOString());
    const loaded = this.#store.load();
    this.#snapshot = loaded ?? {
      ocean: opts.seed.ocean,
      pad: oceanToPadBaseline(opts.seed.ocean, opts.seed.dials),
      turn: 0,
    };
  }

  /** 当前持久化快照。 */
  current(): PersonaSnapshot {
    return this.#snapshot;
  }

  /** 读当前心情渲染的情绪 + tone(纯,不改状态;回合前用)。 */
  tone(): ToneView {
    const dials = this.#seed.dials;
    return {
      emotion: padToEmotion(this.#snapshot.pad),
      toneFragment: renderToneFragment(this.#snapshot.pad, dials),
      pad: this.#snapshot.pad,
      posture: resolveNegativePosture(this.#snapshot.pad, dials),
    };
  }

  /**
   * 推进情绪:appraise(异步)→ spring 步进 → 二级 OCEAN 演化(每 N 轮,opt-in)→ 持久化(回合后用)。
   * OCEAN 演化先于 PAD 基线计算,使演化后的人格当轮即影响心情重心;失败/未注入则 OCEAN 恒定。
   */
  async advance(userText: string): Promise<void> {
    const dials = this.#seed.dials;
    const turn = this.#snapshot.turn + 1;
    // 仅在注入了 evolver 时累积演化窗口——默认路径(无 evolver)不 push,杜绝长跑进程无界增长。
    if (this.#oceanEvolver !== undefined) {
      this.#recentUserTexts.push(userText);
      // 防御上限:窗口本应每 N 轮被 #maybeEvolveOcean 清空;万一节拍失效也不无界(ring 语义)。
      const cap = Math.max(this.#config.evolutionEveryTurns, 1) * 2;
      if (this.#recentUserTexts.length > cap) {
        this.#recentUserTexts.splice(0, this.#recentUserTexts.length - cap);
      }
    }

    // 慢变量:二级 OCEAN delta 演化(每 N 轮一次,仅注入 evolver 时;全程降级)。
    const evolved = await this.#maybeEvolveOcean(turn);
    const ocean = evolved?.ocean ?? this.#snapshot.ocean;
    const history = evolved?.history ?? this.#snapshot.history;

    // 快变量:即时 PAD 弹簧步进(基线用(可能已演化的)OCEAN)。
    const baseline = oceanToPadBaseline(ocean, dials);
    const pull = await this.#appraiser.appraise({ userText, pad: this.#snapshot.pad, turn });
    const pad = stepPad({ pad: this.#snapshot.pad, pull, baseline, dials, turn, config: this.#config });

    this.#snapshot = {
      ocean,
      pad,
      turn,
      ...(history !== undefined ? { history } : {}),
    };
    this.#store.save(this.#snapshot);
  }

  /**
   * 若到节拍且注入了 evolver,跑一次二级 OCEAN 演化:据近段对话产出 delta → 接缝侧 ±max 钳制 →
   * 应用 → 追加版本快照。返回新 OCEAN + history;未触发/失败/null/全零则返回 undefined(OCEAN 不变)。
   * 任何分支都不抛出、不打断回合(§3.2 优雅降级)。
   */
  async #maybeEvolveOcean(
    turn: number,
  ): Promise<{ readonly ocean: Ocean; readonly history: readonly OceanDeltaSnapshot[] } | undefined> {
    const evolver = this.#oceanEvolver;
    if (evolver === undefined) return undefined;
    if (!shouldEvolve(turn, this.#config.evolutionEveryTurns)) return undefined;

    // 到节拍即消费并清空本周期窗口(无论演化是否落地,避免窗口无限增长)。
    const recentUserTexts = this.#recentUserTexts;
    this.#recentUserTexts = [];

    const before = this.#snapshot.ocean;
    const raw = await evolver.evolve({ recentUserTexts, ocean: before, turn });
    if (raw === null) return undefined; // 无信号 → 不演化、不写快照。
    // ±max 单步上限是接缝侧硬不变式(单一权威):无论哪种 evolver 实现都在此封顶,
    // evolver 内部钳制退化为纵深防御。钳制后若全零(无有效信号)同样不演化。
    const delta = clampOceanDelta(raw, this.#config.maxOceanDeltaPerStep);
    if (isZeroDelta(delta)) return undefined;

    const after = applyOceanDelta(before, delta);
    const snapshot = buildDeltaSnapshot(before, after, delta, turn, this.#now());
    const history = [...(this.#snapshot.history ?? []), snapshot];
    return { ocean: after, history };
  }
}
