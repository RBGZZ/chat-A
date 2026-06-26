/**
 * backchannel(附和)纯决策核(全双工 v1):用户持续说话+短停顿时,判是否插一句「嗯/对」附和。
 * 确定性、外置状态(由 VoiceLoop 持有)、可 golden test;**runtime 禁随机**——触发全确定,密度靠 cooldownMs。
 * 仅 stt-stream 路用(连续 partial 流才有「说话中停顿」可判)。附和不占回合。
 */
export interface BackchannelConfig {
  /** partial 停止更新达此时长(ms)判「短停顿」=候选附和点。 */
  readonly pauseMs: number;
  /** 用户须已连续说够此时长(ms)才考虑附和(不对开头附和)。 */
  readonly minSpeechMs: number;
  /** 两次附和最小间隔(ms),防刷屏(密度旋钮)。 */
  readonly cooldownMs: number;
  /** 附和短句集(克隆音色懒合成+缓存;轮换)。 */
  readonly clipTexts: readonly string[];
}
export const DEFAULT_BACKCHANNEL_CONFIG: BackchannelConfig = {
  pauseMs: 700, minSpeechMs: 3000, cooldownMs: 5000, clipTexts: ['嗯', '嗯嗯', '对', '我在听'],
};

export interface BackchannelState {
  /** 本轮用户开口时刻(onSpeechStarted);null=当前无进行中用户话。 */
  readonly speechStartedAtMs: number | null;
  /** 最近一次 partial 时刻(判停顿用)。 */
  readonly lastPartialAtMs: number | null;
  /** 上次附和时刻(冷却用)。 */
  readonly lastBackchannelAtMs: number | null;
  /** 下一句 clip 索引(轮换)。 */
  readonly clipIndex: number;
}
export const INITIAL_BACKCHANNEL_STATE: BackchannelState = {
  speechStartedAtMs: null, lastPartialAtMs: null, lastBackchannelAtMs: null, clipIndex: 0,
};

/** 用户开口:记开口时刻 + 初始化 partial 时刻。 */
export function onSpeechStartedState(s: BackchannelState, nowMs: number): BackchannelState {
  return { ...s, speechStartedAtMs: nowMs, lastPartialAtMs: nowMs };
}
/** 收到 partial:刷新 partial 时刻(若未记开口,补记)。 */
export function onPartialState(s: BackchannelState, nowMs: number): BackchannelState {
  return { ...s, speechStartedAtMs: s.speechStartedAtMs ?? nowMs, lastPartialAtMs: nowMs };
}
/** 回合结束(final/打断):清开口态(下句前不附和);保留冷却与 clip 索引。 */
export function onTurnDoneState(s: BackchannelState): BackchannelState {
  return { ...s, speechStartedAtMs: null, lastPartialAtMs: null };
}

/**
 * 纯决策:满足「已说够 minSpeechMs 且 距上次 partial≥pauseMs(停顿) 且 距上次附和≥cooldownMs 且 有 clip」
 * → fire=true,给轮换 clipText,更新 lastBackchannelAtMs/clipIndex。否则 fire=false、状态不变。
 */
export function decideBackchannel(
  s: BackchannelState, nowMs: number, cfg: BackchannelConfig,
): { fire: boolean; clipText?: string; state: BackchannelState } {
  if (s.speechStartedAtMs === null || s.lastPartialAtMs === null) return { fire: false, state: s };
  if (cfg.clipTexts.length === 0) return { fire: false, state: s };
  const spoken = nowMs - s.speechStartedAtMs;
  const sincePartial = nowMs - s.lastPartialAtMs;
  const sinceBc = s.lastBackchannelAtMs === null ? Number.POSITIVE_INFINITY : nowMs - s.lastBackchannelAtMs;
  if (spoken >= cfg.minSpeechMs && sincePartial >= cfg.pauseMs && sinceBc >= cfg.cooldownMs) {
    const clipText = cfg.clipTexts[s.clipIndex % cfg.clipTexts.length]!;
    return { fire: true, clipText, state: { ...s, lastBackchannelAtMs: nowMs, clipIndex: s.clipIndex + 1 } };
  }
  return { fire: false, state: s };
}
