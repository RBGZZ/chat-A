/**
 * EchoGuard —— 自打断防护(软件侧**部分缓解**,§4 行 162/176 缺口)。
 *
 * ⚠️ **这不是回声消除(AEC)。** 真正消除「扬声器→空气/回环→麦克风」的回声需声学/原生方案
 * (自适应滤波 + 播放参考信号对消,如 WebRTC AEC3),**不在本模块范围**,留作未来/原生。
 *
 * 本模块按 roadmap §3.1(GoNoGo 生产实测做法,与权威设计 §4「agent 说话时门控 STT」一致)做
 * **硬门控 + RMS 双层冷却**三态机。
 *
 * 在本项目 VoiceLoop 半双工架构里,agent `speaking` 期**本就不把麦克风音频喂 STT 转写**(STT 只在
 * endpointing→thinking 跑)——「硬门控 STT」在结构上已成立。speaking 期麦克风唯一驱动的是 **barge-in
 * (是否打断 agent)**;故本 Gate 的职责锚在**barge-in 放行决策**上,三档分层正是「门控强度」的工程化:
 *
 *   - **Tier 1 硬门控(speaking)**:agent 自己说话期间,用**最高 RMS 门槛**(`cooldownRmsThreshold`)
 *     + 连续 N 帧去抖压住自家 TTS 经空气/回环灌进麦克风的强回声/单帧毛刺——从根上**不自打断**;
 *     但真人足够响且连续 N 帧的语音仍能打断(否则 agent 变「打不断」,违 §4 核心打断)。
 *   - **Tier 2 冷却窗(cooldown)**:agent 说完后 `cooldownMs`(默认 1.5s)内,仍用**更高 RMS 门槛**
 *     (`cooldownRmsThreshold`,如 0.03 vs 平时 `baseRmsThreshold` 0.05~更低)吸收房间混响衰减尾巴,
 *     同时**允许用户立刻回话**(高能量真语音仍放行)。
 *   - **open(常态)**:用常态能量门槛 `baseRmsThreshold` + 连续 N 帧去抖(`confirmFrames`),
 *     压断续/低能量毛刺,真人连续 N 帧仍可靠放行。
 *
 * **可观测(day1 RMS instrument)**:每帧决策(RMS 值、当前 tier、是否放行、连续计数)经可选
 * `onDecision` 回调抛出——「看不见就调不动」(roadmap §3.1)。回调抛错被吞,绝不影响门控本身(§3.2)。
 *
 * 设计:纯逻辑 + 帧时间戳驱动(无墙钟、无副作用),`setSpeaking`/`push` 喂状态与标量、确定可测。
 * VoiceLoop 在 thinking→speaking 时 `setSpeaking(true)`、speaking→listening/收尾时 `setSpeaking(false)`,
 * speaking 期 `push` 用最高门槛(Tier1),冷却/常态期据 RMS + 去抖放行;`reset()` 在回合切换/打断后清状态。
 *
 * **回归硬线**:`enabled:false`(默认)时 VoiceLoop 根本不注入,行为完全等价现状;
 * 即便启用,`confirmFrames:1` + `baseRmsThreshold:0` 时 open 态首个达标帧即放行,与「检出语音即打断」时序一致。
 */

/** 门控所处档位(承 roadmap §3.1 双层 + 禁用态)。 */
export type EchoGuardTier =
  /** 未启用:`push` 恒放行(逐字现状)。 */
  | 'disabled'
  /** Tier 1:agent 说话期,硬门控,任意帧一律不放行。 */
  | 'speaking'
  /** Tier 2:说完后冷却窗,用更高 RMS 门槛。 */
  | 'cooldown'
  /** 常态:用 base RMS 门槛 + 连续 N 帧去抖。 */
  | 'open';

/** EchoGuard 配置(行为即配置,无 magic number;全字段可被装配/构造覆盖)。 */
export interface EchoGuardConfig {
  /** 是否启用 EchoGuard。false=禁用(VoiceLoop 不注入即此态),等价即时放行、逐字现状。 */
  readonly enabled: boolean;
  /**
   * 放行「真打断」所需的**连续达标帧数** N(≥1),三档(speaking/cooldown/open)同此去抖。
   * N=1 等价即时放行;N≥2 需连续 N 帧达标,中途掉线即清零重计(压断续回声毛刺)。
   */
  readonly confirmFrames: number;
  /** 「高置信」帧的最低语音概率(prob ≥ 此值);默认与 VAD 阈值对齐(不比 VAD 更宽松)。 */
  readonly minSpeechProb: number;
  /**
   * 旧版能量门槛(向后兼容,**已被 base/cooldownRmsThreshold 取代**):>0 时附加要求该帧能量也达标。
   * 新代码用 `baseRmsThreshold`/`cooldownRmsThreshold` 表达双层;`minEnergy` 仅作额外底线叠加(取较严者)。
   * 默认 0 = 不附加(纯由双层阈值 + 去抖判定)。
   */
  readonly minEnergy: number;
  /**
   * Tier 2 冷却窗时长(ms):agent 说完后这段时间内用 `cooldownRmsThreshold` 高门槛(roadmap §3.1 默认 1.5s)。
   * 据帧时间戳判窗内/窗外(确定性,不读墙钟)。0 = 无冷却窗(说完立即回 open 常态)。
   */
  readonly cooldownMs: number;
  /**
   * 常态(open)态 RMS 能量门槛(0~1):归一化能量 ≥ 此值才视为达标(roadmap §3.1「平时 0.05」)。
   * 0 = 不查能量(纯由 prob + 去抖判定,等价旧纯帧数去抖)。
   */
  readonly baseRmsThreshold: number;
  /**
   * Tier 2 冷却窗 RMS 能量门槛(0~1):冷却窗内用此**更高**门槛吸收混响尾巴(roadmap §3.1「如 0.03」)。
   * 一般 `cooldownRmsThreshold > baseRmsThreshold`;高能量真语音仍能在冷却窗内放行(允许立刻回话)。
   */
  readonly cooldownRmsThreshold: number;
}

/**
 * EchoGuard 默认配置(**安全默认**):
 * - `enabled:false` → VoiceLoop 未注入即此态,行为逐字现状;
 * - `confirmFrames:1` → 即使启用,默认 N=1 也使既有 barge-in 时序不变(回归硬线);
 * - `minSpeechProb:0.5` → 与 `DEFAULT_VAD_CONFIG.speechProbThreshold` 对齐;
 * - `minEnergy:0` → 不附加旧能量门;
 * - `cooldownMs:1500` → roadmap §3.1 推荐 1.5s 冷却窗;
 * - `baseRmsThreshold:0` → 默认 open 态不查能量(保守不误伤真人;装配层据真机标定可调到 0.05);
 * - `cooldownRmsThreshold:0.03` → roadmap §3.1 推荐冷却高门槛(仅在 cooldownMs>0 且进入冷却时生效)。
 */
export const DEFAULT_ECHO_GUARD_CONFIG: EchoGuardConfig = {
  enabled: false,
  confirmFrames: 1,
  minSpeechProb: 0.5,
  minEnergy: 0,
  cooldownMs: 1500,
  baseRmsThreshold: 0,
  cooldownRmsThreshold: 0.03,
};

/** 喂给 Gate 的单帧输入(已归一标量,Gate 不依赖 PcmFrame 形状,保持纯净)。 */
export interface EchoGuardFrame {
  /** 该帧语音概率(0~1,取自 VAD)。 */
  readonly prob: number;
  /** 该帧归一化能量(RMS/fullScale,0~1)。 */
  readonly energy01: number;
  /** VAD 当前是否判「说话中」(去抖后的 speaking 态)。 */
  readonly speakingFromVad: boolean;
  /** 该帧真实时刻(ms,取自 PcmFrame.timestampMs);用于判冷却窗内/外(确定性,不读墙钟)。 */
  readonly atMs: number;
}

/**
 * Gate 单帧决策(可观测:RMS/tier/pass/连续计数全可打日志/trace,承 roadmap §3.1 day1 instrument)。
 */
export interface EchoGuardDecision {
  /** 是否放行本帧到下游(STT/打断判定)。false=被门控丢弃。 */
  readonly pass: boolean;
  /** 本帧所处档位(disabled/speaking/cooldown/open)。 */
  readonly tier: EchoGuardTier;
  /** 本帧归一化 RMS 能量(原样回传,便于 day1 RMS 日志)。 */
  readonly energy01: number;
  /** 本帧实际生效的 RMS 门槛(open=base、cooldown=cooldown;speaking/disabled 无意义,记 0)。 */
  readonly rmsThreshold: number;
  /** 当前连续达标帧计数(open/cooldown 用;speaking/disabled 恒 0)。 */
  readonly run: number;
}

/** 决策观测回调(day1 RMS instrument):每帧 push 后被调用;抛错被吞,不影响门控。 */
export interface EchoGuardObserver {
  readonly onDecision?: (decision: EchoGuardDecision) => void;
}

/**
 * EchoGuard 三态机:Tier1 硬门控(speaking)/ Tier2 冷却(cooldown)/ 常态(open)。
 * 纯逻辑、帧时间戳驱动、无副作用;喂 `setSpeaking` + `push(帧)` 即确定性产出放行决策。
 */
export class EchoGuardGate {
  /** 当前连续达标帧数;任一帧不达标即清零(防回声断续累积)。speaking 态不累计。 */
  #run = 0;
  /** agent 是否正在说话(Tier1 硬门控开关)。 */
  #agentSpeaking = false;
  /** 冷却窗结束时刻(ms,帧时间轴):agent 说完时置为 atMs+cooldownMs;< 此刻为冷却窗内。 */
  #cooldownUntilMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly cfg: EchoGuardConfig = DEFAULT_ECHO_GUARD_CONFIG,
    private readonly observer: EchoGuardObserver = {},
  ) {}

  /**
   * 设置 agent 说话状态(Tier1/Tier2 切换驱动):
   * - `true`:进入 Tier1 硬门控(说话期一律不放行);清连续计数。
   * - `false`:agent 说完 → 起 `cooldownMs` 冷却窗(到 `nowMs+cooldownMs` 用高 RMS 门槛);清连续计数。
   * `nowMs` 取触发帧/收尾时的真实时刻(ms);VoiceLoop 用注入时钟或帧时间戳传入。
   */
  setSpeaking(speaking: boolean, nowMs: number): void {
    if (speaking) {
      this.#agentSpeaking = true;
    } else {
      if (this.#agentSpeaking) {
        // 刚从说话切到不说话 → 开冷却窗(cooldownMs<=0 则窗为空,立即回 open)。
        this.#cooldownUntilMs = nowMs + Math.max(0, this.cfg.cooldownMs);
      }
      this.#agentSpeaking = false;
    }
    this.#run = 0; // 状态切换清连续计数(避免跨态残留)
  }

  /** 喂入一帧,跑三态门控,返回放行决策(并触发可观测回调)。 */
  push(frame: EchoGuardFrame): EchoGuardDecision {
    const decision = this.#decide(frame);
    // day1 RMS instrument:抛错被吞,绝不影响门控本身(§3.2 优雅降级)。
    const obs = this.observer.onDecision;
    if (obs !== undefined) {
      try {
        obs(decision);
      } catch {
        /* 日志/trace 故障不致命,忽略 */
      }
    }
    return decision;
  }

  /** 纯决策逻辑(不含可观测副作用),便于 push 包一层日志。 */
  #decide(frame: EchoGuardFrame): EchoGuardDecision {
    // 禁用:即时放行(等价无门控,逐字现状)。
    if (!this.cfg.enabled) {
      return { pass: true, tier: 'disabled', energy01: frame.energy01, rmsThreshold: 0, run: 0 };
    }

    // 判档 + 取本档 RMS 门槛:
    // - speaking(Tier1):agent 在说 → 最高门槛(cooldownRmsThreshold),压住自家回声,真人响声仍可打断。
    // - cooldown(Tier2):说完冷却窗内(帧时刻 < cooldownUntil)→ 同最高门槛吸收混响尾巴。
    // - open(常态):base 门槛。
    let tier: EchoGuardTier;
    let rmsThreshold: number;
    if (this.#agentSpeaking) {
      tier = 'speaking';
      rmsThreshold = this.cfg.cooldownRmsThreshold;
    } else if (frame.atMs < this.#cooldownUntilMs) {
      tier = 'cooldown';
      rmsThreshold = this.cfg.cooldownRmsThreshold;
    } else {
      tier = 'open';
      rmsThreshold = this.cfg.baseRmsThreshold;
    }

    // 帧是否「高置信达标」:prob 达标 + VAD 有声 + 能量过当前层门槛 + (兼容)过旧 minEnergy 底线。
    const energyOk =
      frame.energy01 >= rmsThreshold && (this.cfg.minEnergy <= 0 || frame.energy01 >= this.cfg.minEnergy);
    const highConf = frame.prob >= this.cfg.minSpeechProb && frame.speakingFromVad && energyOk;

    if (highConf) {
      this.#run += 1;
    } else {
      this.#run = 0; // 掉到静音/低置信/能量不足 → 清零重计
    }

    // confirmFrames 至少按 1 看待(防误配 0/负导致歧义)。
    const need = Math.max(1, this.cfg.confirmFrames);
    const pass = this.#run >= need;
    return { pass, tier, energy01: frame.energy01, rmsThreshold, run: this.#run };
  }

  /**
   * Tier2 冷却窗输入抑制查询(用于 listening 期判「这帧是不是 agent 刚说完的混响尾」):
   * **不动连续计数、无副作用**,只据当前是否在冷却窗 + 能量是否低于冷却高门槛作纯查询。
   *
   * 返回 true = 应抑制本帧(冷却窗内的低能量混响尾,别开启虚假回合);
   * 返回 false = 放行(不在冷却窗 / 高能量真语音 / 未启用)。
   *
   * 与 `push`(barge-in 决策,带 N 帧去抖)分工:`push` 答「说话期/打断要不要放行」,
   * 本法答「听期冷却窗要不要挡混响尾」——后者是单事件判定,不该被 N 帧去抖耦合。
   * 可观测:同样经 `onDecision` 抛出本帧决策(tier=cooldown/open、pass、RMS),便于 day1 调阈。
   */
  shouldSuppressInput(frame: EchoGuardFrame): boolean {
    if (!this.cfg.enabled || this.#agentSpeaking) {
      // 未启用 → 不抑制;speaking 期 listening 不该出现(防御性:交给 push 路径,这里不抑制)。
      return false;
    }
    const inCooldown = frame.atMs < this.#cooldownUntilMs;
    const tier: EchoGuardTier = inCooldown ? 'cooldown' : 'open';
    const rmsThreshold = inCooldown ? this.cfg.cooldownRmsThreshold : this.cfg.baseRmsThreshold;
    // 能量过门槛即放行;冷却窗内低于高门槛(混响尾)→ 抑制。
    const energyOk =
      frame.energy01 >= rmsThreshold && (this.cfg.minEnergy <= 0 || frame.energy01 >= this.cfg.minEnergy);
    const suppress = !energyOk;
    const obs = this.observer.onDecision;
    if (obs !== undefined) {
      try {
        obs({ pass: !suppress, tier, energy01: frame.energy01, rmsThreshold, run: 0 });
      } catch {
        /* 日志/trace 故障不致命 */
      }
    }
    return suppress;
  }

  /**
   * 回合切换/打断后调用:**只清 barge-in 连续计数**,**不动** speaking/cooldown 档位状态。
   *
   * 关键:Tier2 冷却窗是「agent 说完后」的状态,正好要**延续进随后的 listening 期**吸收混响尾;
   * 若此处把冷却窗一并清掉,turn:end 刚开的冷却窗会被同帧的收尾 reset 抹掉(自相矛盾)。
   * 故档位状态**唯一**由 `setSpeaking` 驱动(说→Tier1、说完→开冷却窗、窗按帧时刻自然过期),
   * `reset` 只负责清去抖计数;要彻底清档位用 {@link resetTiers}(start/stop 全量重置时)。
   */
  reset(): void {
    this.#run = 0;
  }

  /** 全量重置档位(start/stop 时用):清连续计数 + 清 speaking + 清冷却窗 → 回 open 常态。 */
  resetTiers(): void {
    this.#run = 0;
    this.#agentSpeaking = false;
    this.#cooldownUntilMs = Number.NEGATIVE_INFINITY;
  }
}
