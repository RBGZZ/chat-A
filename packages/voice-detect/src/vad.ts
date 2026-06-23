/**
 * VAD 层(§4「有没有声」/ §5b Silero VAD 标准层)。
 *
 * 职责边界(§4 三层各司其职):VAD 只回答「这一帧有没有人声 + 何时起/止」,
 * **不**回答「说完没」(那是 TurnDetector/EOU 的事,见 turn-detector.ts / endpointing.ts)。
 *
 * 设计接缝:`VadDetector` 是接口;真 Silero VAD(~2MB ONNX、16k/512 帧,§5b 行 105)以后实现该接口;
 * 这里提供 `StubVadDetector` —— 按**注入的逐帧概率序列**确定性产出事件,供纯逻辑测试(不碰真模型/真音频/真时钟)。
 *
 * 真 Silero 如何接进来:实现 `VadDetector`,在 `pushFrame` 内把 `PcmFrame.samples` 喂给 ONNX session
 * 得到该帧语音概率,复用本文件的同一套「概率 → 去抖 → start/end 事件」状态机即可(把桩的「注入概率」换成「模型推理概率」)。
 */
import type { PcmFrame } from '@chat-a/protocol';
import { DEFAULT_VAD_CONFIG, type VadConfig } from './config';

/** VAD 事件类型(本地契约,与 A 层总线 `vad:speech_start/end` 同义;接线 runtime 时再桥接)。 */
export type VadEventType = 'speech_start' | 'speech_end';

/** 单条 VAD 事件:类型 + 触发时刻(取自帧 `timestampMs`,真实时刻非协程恢复时刻)。 */
export interface VadEvent {
  readonly type: VadEventType;
  /** 触发该事件的帧的真实时刻(ms)。 */
  readonly atMs: number;
}

/** 单帧 VAD 结果:语音概率 + 本帧是否产生了状态切换事件(无切换则 event 省略)。 */
export interface VadFrameResult {
  /** 该帧语音概率(0~1)。 */
  readonly prob: number;
  /** 本帧因去抖触发的状态切换事件;无切换时省略(exactOptional 安全,不写 undefined)。 */
  readonly event?: VadEvent;
  /** 喂入本帧后,是否处于「说话中」状态。 */
  readonly speaking: boolean;
}

/**
 * VAD 检测器接口:逐帧喂音频 → 得每帧概率 + speech_start/end 事件。
 * 真 Silero / TEN VAD 实现此接口;`reset` 清回合状态(回合切换时调用)。
 */
export interface VadDetector {
  /** 喂入一帧音频,返回该帧概率与(可能的)状态切换事件。 */
  pushFrame(frame: PcmFrame): VadFrameResult;
  /** 重置内部去抖/状态(新回合开始或显式打断后)。 */
  reset(): void;
}

/**
 * 「概率 → 去抖 → start/end」状态机(纯逻辑,真桩共用)。
 * 抽成独立类:真 Silero 实现 VadDetector 时直接复用,避免重复去抖逻辑。
 */
export class VadGate {
  private speaking = false;
  private aboveRun = 0; // 连续达标帧计数
  private belowRun = 0; // 连续不达标帧计数

  constructor(private readonly cfg: VadConfig = DEFAULT_VAD_CONFIG) {}

  /** 喂入「该帧概率 + 该帧时刻」,跑去抖,返回结果。 */
  step(prob: number, atMs: number): VadFrameResult {
    const above = prob >= this.cfg.speechProbThreshold;
    if (above) {
      this.aboveRun += 1;
      this.belowRun = 0;
    } else {
      this.belowRun += 1;
      this.aboveRun = 0;
    }

    if (!this.speaking && above && this.aboveRun >= this.cfg.speechStartFrames) {
      this.speaking = true;
      return { prob, speaking: true, event: { type: 'speech_start', atMs } };
    }
    if (this.speaking && !above && this.belowRun >= this.cfg.speechEndFrames) {
      this.speaking = false;
      return { prob, speaking: false, event: { type: 'speech_end', atMs } };
    }
    return { prob, speaking: this.speaking };
  }

  reset(): void {
    this.speaking = false;
    this.aboveRun = 0;
    this.belowRun = 0;
  }
}

/**
 * 确定性 VAD 桩:用**注入的逐帧概率序列**替代真模型推理。
 * 每次 `pushFrame` 取序列里的下一个概率(用完后恒返回 0,视作静音),跑同一套去抖状态机。
 * 测试据此断言「给定概率序列 → 产出哪些 speech_start/end」,完全不依赖真音频/真时钟/真模型。
 */
export class StubVadDetector implements VadDetector {
  private readonly probs: readonly number[];
  private idx = 0;
  private readonly gate: VadGate;

  constructor(probs: readonly number[], cfg: VadConfig = DEFAULT_VAD_CONFIG) {
    this.probs = probs;
    this.gate = new VadGate(cfg);
  }

  pushFrame(frame: PcmFrame): VadFrameResult {
    const prob = this.probs[this.idx] ?? 0;
    this.idx += 1;
    return this.gate.step(prob, frame.timestampMs);
  }

  reset(): void {
    this.idx = 0;
    this.gate.reset();
  }
}
