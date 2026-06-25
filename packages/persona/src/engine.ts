import type {
  Appraiser,
  Emotion,
  Ocean,
  OceanDeltaSnapshot,
  OceanEvolver,
  Pad,
  PadPull,
  PersonaConfig,
  PersonaSeed,
  PersonaSnapshot,
  PersonaStore,
  Posture,
} from './types';
import { clampUnit, DEFAULT_PERSONA_CONFIG } from './defaults';
import { oceanToPadBaseline, padToEmotion, stepPad } from './numeric';
import { padToVoiceInstruction } from './pad-voice-instruction';
import { prosodyToPadPull, type SttEmotionLike } from './prosody';
import { renderToneFragment } from './tone';
import { resolveNegativePosture } from './posture';
import { DefaultAppraiser } from './appraiser';
import { InMemoryPersonaStore } from './store';
import { applyOceanDelta, buildDeltaSnapshot, clampOceanDelta, isZeroDelta, shouldEvolve } from './ocean-evolution';

/**
 * 语音 prosody 拉力并入文本拉力时的权重(§7#5「从语音读情绪」)。外置具名常量(行为即配置、无 magic
 * number):语音为**辅**,不盖过文本(「说了什么」仍是主),故 < 1。`merged = textPull + W·prosodyPull`。
 */
export const PROSODY_PULL_WEIGHT = 0.5;

/**
 * 把语音 prosody 拉力按权重 {@link PROSODY_PULL_WEIGHT} 并入文本拉力(§7#5;纯函数)。
 * - `emotion` 缺省 → **原样返回 textPull**(同一对象,字面零改动,保证默认路径与现状逐字一致)。
 * - 否则 `prosodyPull = prosodyToPadPull(emotion)`(neutral/未知/低 confidence 已在其内降级),
 *   各维 `clampUnit(textPull + W·prosodyPull)`。neutral/未知 → prosodyPull 全零 → 结果等同 textPull。
 */
function mergeProsodyPull(textPull: PadPull, emotion?: SttEmotionLike): PadPull {
  if (emotion === undefined) return textPull;
  const p = prosodyToPadPull(emotion);
  return {
    pleasure: clampUnit(textPull.pleasure + PROSODY_PULL_WEIGHT * p.pleasure),
    arousal: clampUnit(textPull.arousal + PROSODY_PULL_WEIGHT * p.arousal),
    dominance: clampUnit(textPull.dominance + PROSODY_PULL_WEIGHT * p.dominance),
  };
}

export interface ToneView {
  readonly emotion: Emotion;
  readonly toneFragment: string;
  /** 当前 PAD 状态(供决策 trace 记录"当时心情",§8.1)。 */
  readonly pad: Pad;
  /** 当轮负面人际姿态(§7#6);无则 null。 */
  readonly posture: Posture | null;
  /**
   * 当前心情对应的"语音情绪指令"(§4.1 TTS 情感;由 PAD 经 {@link padToVoiceInstruction} 得出)。
   * 供编排层作 TtsOptions.instruction 注入 CosyVoice,使复刻音色随情绪说话。空串=中性不强加。
   * 纯加法字段;不改变 emotion/toneFragment/pad/posture 的值与行为。
   */
  readonly voiceInstruction: string;
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

  /**
   * 读当前心情渲染的情绪 + tone(纯,不改状态;回合前用)。
   * `closeness`(§2.4 关系亲密度,可选)由编排层读取后透传;省略时 tone 行为不变(向后兼容)。
   * exactOptional 安全:用条件展开仅在提供时附带 closeness 实参,绝不显式传 undefined。
   */
  tone(closeness?: number): ToneView {
    const dials = this.#seed.dials;
    const closeArgs: [number] | [] = closeness !== undefined ? [closeness] : [];
    return {
      emotion: padToEmotion(this.#snapshot.pad),
      toneFragment: renderToneFragment(this.#snapshot.pad, dials, ...closeArgs),
      pad: this.#snapshot.pad,
      posture: resolveNegativePosture(this.#snapshot.pad, dials),
      voiceInstruction: padToVoiceInstruction(this.#snapshot.pad, dials),
    };
  }

  /**
   * 推进情绪:appraise(异步)→ spring 步进 → 二级 OCEAN 演化(每 N 轮,opt-in)→ 持久化(回合后用)。
   * OCEAN 演化先于 PAD 基线计算,使演化后的人格当轮即影响心情重心;失败/未注入则 OCEAN 恒定。
   *
   * `opts.prosodyEmotion`(§7#5「从语音读情绪」,**全可选**):由编排层从 STT 读出的语气情绪透传。
   * 提供时,经 {@link prosodyToPadPull} 得语音侧拉力,与文本 appraiser 的 `textPull` 按 {@link PROSODY_PULL_WEIGHT}
   * **合并**为单一 pull 再**单次** `stepPad` 步进(`merged = textPull + W·prosodyPull`,各维钳制 [-1,1]),
   * 使「怎么说的」与「说了什么」并轨喂入 PAD。**不提供 / undefined → 拉力恒等于 `textPull`、与现状逐字一致**
   * (同一次 stepPad,纯加法、向后兼容);neutral/未知标签经 prosodyToPadPull 得零拉力 → 同样等价不提供。
   * 入参用结构类型 `SttEmotionLike`(不依赖 providers,§3.1 接缝边界)。
   */
  async advance(userText: string, opts?: { readonly prosodyEmotion?: SttEmotionLike }): Promise<void> {
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
    const textPull = await this.#appraiser.appraise({ userText, pad: this.#snapshot.pad, turn });
    // §7#5:若有语音 prosody 情绪,把它的 PAD 拉力按权重并入文本拉力(合并为单一 pull,单次步进);
    // 无 / undefined / neutral / 未知 → mergeProsodyPull 返回 textPull 原物,与现状逐字一致(纯加法)。
    const pull = mergeProsodyPull(textPull, opts?.prosodyEmotion);
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
