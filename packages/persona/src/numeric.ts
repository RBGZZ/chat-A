import type { Emotion, Ocean, Pad, PadPull, PersonaConfig, PersonaDials } from './types';
import { centered, clampUnit } from './defaults';

/**
 * OCEAN → PAD 基线(Mehrabian 系数,单一权威公式,§6.1)。OCEAN 居中到 [-1,1] 后:
 *   P = 0.21·E + 0.59·A + 0.19·N
 *   A = 0.15·O + 0.30·A_g − 0.57·N
 *   D = 0.25·O + 0.17·C + 0.60·E − 0.32·A_g
 * baseline_warmth 旋钮额外平移 Pleasure 基线;结果钳制 [-1,1]。纯函数。
 */
export function oceanToPadBaseline(ocean: Ocean, dials: PersonaDials): Pad {
  const o = centered(ocean.openness);
  const c = centered(ocean.conscientiousness);
  const e = centered(ocean.extraversion);
  const a = centered(ocean.agreeableness);
  const n = centered(ocean.neuroticism);

  const warmthShift = (dials.baselineWarmth - 0.5) * 0.4;
  return {
    pleasure: clampUnit(0.21 * e + 0.59 * a + 0.19 * n + warmthShift),
    arousal: clampUnit(0.15 * o + 0.3 * a - 0.57 * n),
    dominance: clampUnit(0.25 * o + 0.17 * c + 0.6 * e - 0.32 * a),
  };
}

/**
 * PAD 弹簧步进(单一权威公式,§6.1):`new = cur + 0.3·(pull·amp) − k·(cur − baseline)`。
 * - 交互 k=0.2(idle k=0.01 预留给未来 autonomy tick)。
 * - emotional_volatility 反向调制 k(越易波动→回归阻尼越小):k_eff = k·(1.5 − volatility)。
 * - emotional_intensity 调制 pull 幅度:amp = 0.5 + intensity。
 * - 冷启动(turn ≤ coldStartTurns):幅度减半 + k 乘以加速回弹系数。
 * 纯函数,结果钳制 [-1,1]。
 */
export function stepPad(args: {
  readonly pad: Pad;
  readonly pull: PadPull;
  readonly baseline: Pad;
  readonly dials: PersonaDials;
  readonly turn: number;
  readonly config: PersonaConfig;
  /** 交互回合 true(默认);idle tick 传 false。 */
  readonly interaction?: boolean;
}): Pad {
  const { pad, pull, baseline, dials, turn, config } = args;
  const kBase = (args.interaction ?? true) ? 0.2 : 0.01;
  let k = kBase * (1.5 - dials.emotionalVolatility);
  let amp = 0.5 + dials.emotionalIntensity;
  if (turn <= config.coldStartTurns) {
    amp *= 0.5;
    k *= config.coldStartReboundFactor;
  }
  const axis = (cur: number, pl: number, base: number): number =>
    clampUnit(cur + 0.3 * pl * amp - k * (cur - base));
  return {
    pleasure: axis(pad.pleasure, pull.pleasure, baseline.pleasure),
    arousal: axis(pad.arousal, pull.arousal, baseline.arousal),
    dominance: axis(pad.dominance, pull.dominance, baseline.dominance),
  };
}

/**
 * PAD → 最近离散情绪(纯函数,小集合)。主看 Pleasure,辅以 Arousal 区分高低唤醒。
 */
export function padToEmotion(pad: Pad): Emotion {
  const { pleasure, arousal } = pad;
  if (pleasure >= 0.35) return arousal >= 0.25 ? 'joyful' : 'content';
  if (pleasure <= -0.35) return arousal >= 0.25 ? 'irritated' : 'down';
  return 'neutral';
}
