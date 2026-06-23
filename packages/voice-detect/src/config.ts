/**
 * voice-detect 配置(承 §4「自校准延迟预算」+ §5b LiveKit per-language 策略 / 「行为即配置」原则)。
 *
 * 这里集中所有阈值/延迟/EMA α/per-language 表——**严禁在逻辑里写 magic number**。
 * 全部字段 readonly,运行期可整表替换(热加载/profile gate 友好,承 §4.3)。
 *
 * 数值来源:
 *   - min/max endpointing delay、EMA α=0.9 ── 设计 §4(canonical)行 173 与 voice-infra 深读。
 *   - per-language unlikelyThreshold ── 仿 LiveKit turn-detector(§5b 行 101);中文句末韵律≠英文,
 *     故中英文给不同默认阈值,真实数值待真模型/真 Pi 标定(此处为合理占位,可被 config 覆盖)。
 */

// ───────────────────────────── VAD ─────────────────────────────

/** VAD 桩/真模型共用的判定配置(承 Silero 16k/512 framing 习惯,§5b 行 105)。 */
export interface VadConfig {
  /** 进入「说话」的语音概率阈值(prob ≥ 此值视为有声)。 */
  readonly speechProbThreshold: number;
  /** 连续达标帧数去抖:≥ 此值才触发 speech_start(防单帧毛刺,承 §4 barge-in 去抖)。 */
  readonly speechStartFrames: number;
  /** 连续不达标帧数去抖:≥ 此值才触发 speech_end(防句中短停顿误判)。 */
  readonly speechEndFrames: number;
}

/** VAD 默认配置(Silero 习惯阈值 0.5;前后各 2 帧去抖,可被覆盖)。 */
export const DEFAULT_VAD_CONFIG: VadConfig = {
  speechProbThreshold: 0.5,
  speechStartFrames: 2,
  speechEndFrames: 2,
};

// ───────────────────────────── 动态 endpointing ─────────────────────────────

/**
 * 单语种 EOU/endpointing 阈值组(仿 LiveKit:概率 vs unlikelyThreshold + min/max 兜底)。
 * 语义:
 *   - unlikelyThreshold ── EOU「已说完」概率低于此值 → 视为「多半没说完」,等待窗拉向 maxDelay。
 *   - minEndpointingDelay ── 最自信「说完了」时也至少等这么久(防把附和当结束)。
 *   - maxEndpointingDelay ── 再不自信也最多等这么久(兜底,防永远不接话)。
 */
export interface LangEndpointingThresholds {
  readonly unlikelyThreshold: number;
  readonly minEndpointingDelayMs: number;
  readonly maxEndpointingDelayMs: number;
}

/**
 * per-language 阈值表(承「行为即配置」+ §5b LiveKit per-language `unlikely_threshold`)。
 * 键为 BCP-47 风格语种码;`default` 为未命中语种时的兜底。
 * 中文默认更「耐心」(unlikelyThreshold 略高 → 更倾向多等),呼应「中文句末韵律≠英文」。
 */
export interface EndpointingConfig {
  /** EMA 平滑系数 α(0~1,越大越「跟手」最新停顿;设计 §4 取 ≈0.9)。 */
  readonly emaAlpha: number;
  /** 兜底默认阈值(未命中具体语种时用)。 */
  readonly default: LangEndpointingThresholds;
  /** 各语种覆盖项。 */
  readonly perLanguage: Readonly<Record<string, LangEndpointingThresholds>>;
}

/** 动态 endpointing 默认配置(α=0.9;中/英文各一组占位阈值,真值待标定)。 */
export const DEFAULT_ENDPOINTING_CONFIG: EndpointingConfig = {
  emaAlpha: 0.9,
  default: {
    unlikelyThreshold: 0.5,
    minEndpointingDelayMs: 500,
    maxEndpointingDelayMs: 6000,
  },
  perLanguage: {
    // 中文:句末韵律更平,易把「思考停顿」当结束 → 阈值更高(更倾向再等)+ 兜底窗更长。
    zh: {
      unlikelyThreshold: 0.7,
      minEndpointingDelayMs: 600,
      maxEndpointingDelayMs: 6000,
    },
    // 英文:句末降调线索强 → 阈值更低(更敢接话)+ 兜底窗更短。
    en: {
      unlikelyThreshold: 0.4,
      minEndpointingDelayMs: 400,
      maxEndpointingDelayMs: 4000,
    },
  },
};

/** 取某语种的阈值组:命中 perLanguage 用之,否则回落 default(承能力门 fail-safe)。 */
export function thresholdsForLang(
  cfg: EndpointingConfig,
  lang: string,
): LangEndpointingThresholds {
  return cfg.perLanguage[lang] ?? cfg.default;
}
