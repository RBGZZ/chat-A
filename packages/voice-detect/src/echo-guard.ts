/**
 * EchoGuard —— 自打断防护(软件侧**部分缓解**,§4 行 162/176 缺口)。
 *
 * ⚠️ **这不是回声消除(AEC)。** 真正消除「扬声器→空气/回环→麦克风」的回声需声学/原生方案
 * (自适应滤波 + 播放参考信号对消,如 WebRTC AEC3),**不在本模块范围**,留作未来/原生。
 *
 * 本模块做的是:在 agent 自己说话(VoiceLoop `speaking`)期间,**提高 barge-in 的确认门槛**——
 * 要求**连续 N 帧高置信语音**(可选叠能量阈值)才确认为「真打断」,把自家 TTS 回声引起的
 * 偶发/单帧/低能量误触过滤掉。它压不住持续强回声(那是 AEC 的活),只压断续/低能量毛刺。
 *
 * 设计:纯逻辑去抖件,与 {@link VadGate} 同范式——无时钟、无副作用,逐帧喂标量、确定可测。
 * VoiceLoop 复用本 Gate(零改状态机),`reset()` 在回合切换/打断后清连续计数。
 *
 * **回归硬线**:默认 `confirmFrames:1` → 首个达标帧即确认,与现状「检出语音即打断」时序逐字一致;
 * `enabled:false`(默认)时 VoiceLoop 根本不注入,行为完全等价现状。
 */

/** EchoGuard 配置(行为即配置,无 magic number;全字段可被装配/构造覆盖)。 */
export interface EchoGuardConfig {
  /** 是否启用 EchoGuard。false=禁用(VoiceLoop 不注入即此态),等价即时确认、逐字现状。 */
  readonly enabled: boolean;
  /**
   * speaking 期确认「真打断」所需的**连续高置信语音帧数** N(≥1)。
   * N=1 等价即时打断(现状);N≥2 需连续 N 帧达标,中途掉线即清零重计。
   */
  readonly confirmFrames: number;
  /** 「高置信」帧的最低语音概率(prob ≥ 此值);默认与 VAD 阈值对齐(不比 VAD 更宽松)。 */
  readonly minSpeechProb: number;
  /**
   * 可选能量阈值(RMS 归一化 0~1):>0 时要求该帧能量也达标才计入连续帧;0/缺省=不查能量。
   * 自家回声经空气衰减后能量通常低于近场真人,叠能量门可进一步压回声;默认 0 以保守不误伤真人。
   */
  readonly minEnergy: number;
}

/**
 * EchoGuard 默认配置(**安全默认**):
 * - `enabled:false` → VoiceLoop 未注入即此态,行为逐字现状;
 * - `confirmFrames:1` → 即使启用,默认 N=1 也使既有 barge-in 时序不变(回归硬线);
 * - `minSpeechProb:0.5` → 与 `DEFAULT_VAD_CONFIG.speechProbThreshold` 对齐;
 * - `minEnergy:0` → 默认不叠能量门(纯帧数去抖)。
 */
export const DEFAULT_ECHO_GUARD_CONFIG: EchoGuardConfig = {
  enabled: false,
  confirmFrames: 1,
  minSpeechProb: 0.5,
  minEnergy: 0,
};

/** 喂给 Gate 的单帧输入(已归一标量,Gate 不依赖 PcmFrame 形状,保持纯净)。 */
export interface EchoGuardFrame {
  /** 该帧语音概率(0~1,取自 VAD)。 */
  readonly prob: number;
  /** 该帧归一化能量(RMS/fullScale,0~1);`minEnergy<=0` 时不参与判定,可传 0/任意。 */
  readonly energy01: number;
  /** VAD 当前是否判「说话中」(去抖后的 speaking 态)。 */
  readonly speakingFromVad: boolean;
}

/** Gate 单帧结果:是否已确认真打断 + 当前连续达标帧数(便于追溯/调参)。 */
export interface EchoGuardResult {
  /** 连续达标帧数是否已达 `confirmFrames`(达到即应放行打断)。 */
  readonly confirmed: boolean;
  /** 当前连续达标帧计数(`enabled:false` 时无意义,恒 0)。 */
  readonly run: number;
}

/**
 * EchoGuard 去抖件:speaking 期累计「连续高置信语音帧数」，达 N 才确认真打断。
 * 纯计数、无时钟、无副作用;喂概率/能量序列即可确定性断言确认时机。
 */
export class EchoGuardGate {
  /** 当前连续达标帧数;任一帧不达标即清零(防回声断续累积)。 */
  #run = 0;

  constructor(private readonly cfg: EchoGuardConfig = DEFAULT_ECHO_GUARD_CONFIG) {}

  /** 喂入一帧,跑连续帧去抖,返回是否已确认 + 当前连续计数。 */
  push(frame: EchoGuardFrame): EchoGuardResult {
    // 禁用:即时确认(等价无去抖,逐字现状)。
    if (!this.cfg.enabled) return { confirmed: true, run: 0 };

    const highConf =
      frame.prob >= this.cfg.minSpeechProb &&
      frame.speakingFromVad &&
      (this.cfg.minEnergy <= 0 || frame.energy01 >= this.cfg.minEnergy);

    if (highConf) {
      this.#run += 1;
    } else {
      this.#run = 0; // 掉到静音/低置信/能量不足 → 清零重计
    }

    // confirmFrames 至少按 1 看待(防误配 0/负导致恒确认歧义)。
    const need = Math.max(1, this.cfg.confirmFrames);
    return { confirmed: this.#run >= need, run: this.#run };
  }

  /** 重置连续计数(回合切换/打断后调用;承 VadGate.reset 范式)。 */
  reset(): void {
    this.#run = 0;
  }
}
