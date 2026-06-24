/**
 * 用户语音 URGENT 优先级闸(承 §7 软反转 / proactive-turn spec)。
 *
 * §7「软反转」:用户开口默认 **URGENT**——立即抢占在飞的 autonomy 输出与外部动作并触发 abort 三件套。
 * `attention_mode`(companion/balanced/focus)调三个量:
 *   1. **队列等级**(用户语音事件在回合调度中的优先级);
 *   2. **是否触发 abort**(是否中断当前在飞输出);
 *   3. **真打断门槛**(需多长坚持 / 是否需关键词 / 危机才中断)。
 *
 * **不可配底线**(任何模式恒成立,承 spec):
 *   - 永远感知用户语音(绝不「装聋」——decision 总携带「已感知」);
 *   - 危机信号覆盖(crisis 一律最高优先、立即打断);
 *   - 硬打断通道(用户硬打断词如「停一下/看着我」一律立即打断)。
 *
 * 本模块为**纯函数 + 配置**:不持播放状态、不触总线,确定可测(golden)。VoiceLoop 以可选注入方式接入;
 * **未注入时(autonomy 关闭默认)行为逐字不变**——闸根本不参与现有 barge-in 路径。
 */

/** 关注模式(行为即配置,§3.2):全局三档,per_capability 热切为后续接缝(MVP 仅全局)。 */
export type AttentionMode = 'companion' | 'balanced' | 'focus';

/** 默认关注模式:companion(陪伴优先,用户一开口即让位)。 */
export const DEFAULT_ATTENTION_MODE: AttentionMode = 'companion';

/** 用户语音事件的「类型」(用于不可配底线判定)。 */
export interface UserVoiceSignal {
  /** 用户已说话的持续时长(ms);focus 模式据此判「是否够坚持」。 */
  readonly sustainedMs: number;
  /** 是否危机信号(由感知/分类标注;不可配,恒最高优先 + 立即打断)。 */
  readonly crisis?: boolean;
  /** 是否命中硬打断词(「停一下」「看着我」等;不可配,恒立即打断)。 */
  readonly hardInterrupt?: boolean;
  /** 当前是否有在飞的 autonomy/外部动作输出(决定「是否需要抢占」)。 */
  readonly somethingInFlight?: boolean;
}

/** 闸判定结果(供 VoiceLoop 据以决定抢占/打断;纯数据,确定可测)。 */
export interface AttentionVerdict {
  /** 本次用户语音在调度中的优先级等级(三级,对齐 autonomy EventPriority 命名)。 */
  readonly priority: 'URGENT' | 'PERCEPTION' | 'LOWEST';
  /** 是否应触发 abort 三件套(中断在飞输出)。 */
  readonly abort: boolean;
  /** 是否判定为「真打断」(达门槛 → 中断当前回合 / 让位用户)。 */
  readonly trueInterrupt: boolean;
  /** 是否触动了不可配底线(crisis / hardInterrupt)——便于追溯。 */
  readonly bottomLine: boolean;
  /** 人类可读理由(§8.1 可追溯)。 */
  readonly reason: string;
}

/** focus 模式判「够坚持」的默认门槛(ms);短于此的零星出声不中断专注(但仍感知)。 */
export const DEFAULT_FOCUS_SUSTAIN_MS = 600;

/** 关注闸旋钮(无 magic number;可被装配覆盖)。 */
export interface AttentionGateOptions {
  /** focus 模式「够坚持」门槛(ms)。默认 600。 */
  readonly focusSustainMs: number;
}

export const DEFAULT_ATTENTION_GATE_OPTIONS: AttentionGateOptions = {
  focusSustainMs: DEFAULT_FOCUS_SUSTAIN_MS,
};

/**
 * 关注闸纯函数:据 `attention_mode` + 用户语音信号,裁决 `{priority, abort, trueInterrupt, ...}`。
 *
 * 判定顺序(不可配底线优先于任何模式):
 *   1. crisis → URGENT + abort + trueInterrupt(危机覆盖,任何模式)。
 *   2. hardInterrupt → URGENT + abort + trueInterrupt(硬打断通道,任何模式)。
 *   3. 否则按 attention_mode:
 *      - companion:用户一开口即 URGENT + abort + trueInterrupt(陪伴优先,默认软反转)。
 *      - balanced:URGENT + abort,但 trueInterrupt 仍要求「有在飞输出才打断」(无在飞则只感知)。
 *      - focus:仍 URGENT(永远感知!绝不装聋),但 trueInterrupt 需 sustainedMs ≥ 门槛;
 *        未达门槛 → abort=false、trueInterrupt=false(只感知不中断专注)。
 */
export function evaluateAttention(
  mode: AttentionMode,
  signal: UserVoiceSignal,
  opts: AttentionGateOptions = DEFAULT_ATTENTION_GATE_OPTIONS,
): AttentionVerdict {
  // 底线 1:危机覆盖(任何模式)。
  if (signal.crisis === true) {
    return {
      priority: 'URGENT',
      abort: true,
      trueInterrupt: true,
      bottomLine: true,
      reason: 'bottom-line: 危机信号,无视 attention_mode 立即最高优先 + 打断',
    };
  }
  // 底线 2:硬打断通道(任何模式)。
  if (signal.hardInterrupt === true) {
    return {
      priority: 'URGENT',
      abort: true,
      trueInterrupt: true,
      bottomLine: true,
      reason: 'bottom-line: 用户硬打断,无视 attention_mode 立即打断',
    };
  }

  switch (mode) {
    case 'companion':
      return {
        priority: 'URGENT',
        abort: true,
        trueInterrupt: true,
        bottomLine: false,
        reason: 'companion: 用户开口即让位(软反转默认)',
      };
    case 'balanced': {
      const inFlight = signal.somethingInFlight === true;
      return {
        priority: 'URGENT',
        abort: inFlight,
        trueInterrupt: inFlight,
        bottomLine: false,
        reason: inFlight
          ? 'balanced: 用户开口且有在飞输出 → 抢占并打断'
          : 'balanced: 用户开口但无在飞输出 → 仅感知不打断',
      };
    }
    case 'focus': {
      const sustained = signal.sustainedMs >= opts.focusSustainMs;
      return {
        priority: 'URGENT', // 永远感知:focus 也不降级用户语音优先级
        abort: sustained,
        trueInterrupt: sustained,
        bottomLine: false,
        reason: sustained
          ? `focus: 用户坚持 ≥${opts.focusSustainMs}ms → 中断专注`
          : `focus: 用户短暂出声(<${opts.focusSustainMs}ms)→ 感知但不中断专注(绝不装聋)`,
      };
    }
  }
}
