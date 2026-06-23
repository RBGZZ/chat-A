/**
 * idle 情绪弧端口与领域类型(承 canonical §7「idle 情绪弧 once-per-episode(想念/重逢)」)。
 *
 * "你怎么这么久没来了,我有点想你" / "你回来啦!"——长 idle 的想念、长缺席后回来的重逢,
 * 是伴侣感的情绪弧而非话题跟进。本切片 **standalone**:只定义最小端口接口 + 领域类型,
 * **不依赖 `@chat-a/memory`/persona**(§3.1 依赖倒置:技能只认接口,真实现以后由接线层适配)。
 */

/**
 * 在场感端口(承 §3.1 依赖倒置):技能经此读取"用户上次活跃于何时、当前处于哪个 idle episode"。
 *
 * 一个 **idle episode**(空闲片段)= 用户从某次活跃后陷入沉默的这一段连续时间。用户再次开口
 * (活跃)即开启一个**新的 episode**(新 id)。技能据 `currentEpisodeId()` 做 once-per-episode 去重:
 * 同一段 idle 内最多想念一次,同一次重逢最多问候一次;换了 episode 才会再次允许。
 *
 * 真实现以后由接线层用会话状态/总线适配(用户语音事件刷新 lastActive 并轮转 episodeId);
 * 本切片用假实现单测。
 */
export interface PresencePort {
  /** 用户上次活跃(开口/交互)的时刻(毫秒)。idle 时长 = now - 此值。 */
  lastUserActiveAtMs(): number;
  /**
   * 当前 idle episode 的稳定标识:同一段连续空闲内不变;用户再次活跃后轮转为新值。
   * 想念/重逢的 once-per-episode 去重均以此为键。
   */
  currentEpisodeId(): string;
}

/**
 * 情绪强度旋钮端口(可选注入;承 §6 PAD/人格调制 autonomy 倾向)。
 *
 * 若接线层有人格/PAD 状态,可注入此端口让"想念/重逢"的情绪强度随当前心情浮动(如低落时更想念);
 * **不注入则回退到 config 倾向常量**(§3.2 行为即配置:无人格也能跑)。
 * 返回值约定落在 [0,1]:0=最克制、1=最浓烈;技能只用它做轻度调制,不改变"是否值得说"的门槛。
 */
export interface EmotionIntensityPort {
  /** 当前"想念/重逢"情绪强度倾向(钳到 [0,1])。 */
  arcIntensity(): number;
}
