/**
 * TurnDetector / EOU 层(§4「说完没,该接话」/ §5b Smart-Turn v3 行 100 + TEN 3 态 行 102)。
 *
 * 职责:吃音频(韵律,非转写)→ 给出「已说完」概率 eouProb;概率交给 endpointing.ts 的动态策略定夺。
 *
 * 设计接缝:`EouModel` 是接口;真 Smart-Turn v3(8MB INT8 ONNX、音频原生、23 语种含中文,§5b 行 100)
 * 以后实现该接口;这里提供 `StubEouModel` —— 按**注入的概率序列**确定性产出 eouProb,供测试。
 *
 * 真 Smart-Turn v3 如何接进来:实现 `EouModel.predict`,内部把累积的用户音频窗喂给 ONNX session
 * 得到 finished 概率(模型对韵律打分),其余动态 endpointing 策略与 TEN 3 态映射完全复用本包逻辑不变。
 * **已实现**:见 `smart-turn-eou.ts` 的 `SmartTurnEouModel`(注入同步 `EouInferenceSession` 端口,
 * 截最近 `maxWindowMs` 音频窗;真 Smart-Turn v3 经 sherpa-onnx 同步原生绑定注入,零改 VoiceLoop)。
 *
 * 注:本包只做「检测 + 策略」,**不接 runtime / 回合调度**(接线后续做);TurnDetector 把
 * EouModel(概率源)与 DynamicEndpointing(策略)组合成一个「该不该接话」的可测单元。
 */
import type { PcmFrame } from '@chat-a/protocol';
import { DEFAULT_ENDPOINTING_CONFIG, type EndpointingConfig } from './config';
import {
  DynamicEndpointing,
  type EndpointingDecision,
  type TurnState,
} from './endpointing';

/** EOU 模型接口:给定累积音频窗 → 「已说完」概率(0~1)。真 Smart-Turn v3 实现此。 */
export interface EouModel {
  /** 对当前累积的用户音频窗预测「已说完」概率。 */
  predict(window: readonly PcmFrame[]): number;
  /** 重置内部窗/状态(回合切换)。 */
  reset(): void;
}

/**
 * 确定性 EOU 桩:用**注入的概率序列**替代真模型推理。
 * 每次 `predict` 取序列下一个概率(用完恒返回末值,模拟「持续判定已说完」)。
 */
export class StubEouModel implements EouModel {
  private readonly probs: readonly number[];
  private idx = 0;

  constructor(probs: readonly number[]) {
    this.probs = probs;
  }

  predict(_window: readonly PcmFrame[]): number {
    const last = this.probs.length > 0 ? this.probs[this.probs.length - 1]! : 0;
    const p = this.probs[this.idx] ?? last;
    if (this.idx < this.probs.length) this.idx += 1;
    return p;
  }

  reset(): void {
    this.idx = 0;
  }
}

/** TurnDetector 单步输入:当前音频窗 + 静音时长 + 语种 +(可选)显式 Wait。 */
export interface TurnStepInput {
  readonly window: readonly PcmFrame[];
  readonly silenceMs: number;
  readonly lang: string;
  readonly forceWait?: boolean;
}

/**
 * TurnDetector:组合 EouModel(概率源)+ DynamicEndpointing(策略)。
 * `step` = 取 EOU 概率 → 跑动态 endpointing → 输出 TEN 3 态 + 是否接话。可注入桩,完全确定性。
 */
export class TurnDetector {
  private readonly model: EouModel;
  private readonly dyn: DynamicEndpointing;

  constructor(model: EouModel, cfg: EndpointingConfig = DEFAULT_ENDPOINTING_CONFIG) {
    this.model = model;
    this.dyn = new DynamicEndpointing(cfg);
  }

  /** 暴露内部动态 endpointing,供上游喂停顿样本做自校准(observeIntraPause/observeTurnGap)。 */
  get dynamic(): DynamicEndpointing {
    return this.dyn;
  }

  /** 单步判定:是否该接话 + TEN 3 态。 */
  step(input: TurnStepInput): EndpointingDecision {
    const eouProb = this.model.predict(input.window);
    return this.dyn.decide({
      eouProb,
      silenceMs: input.silenceMs,
      lang: input.lang,
      ...(input.forceWait === true ? { forceWait: true } : {}),
    });
  }

  reset(): void {
    this.model.reset();
    this.dyn.reset();
  }
}

/** 便捷重导出:TEN 3 态枚举(契约层使用方常一起 import)。 */
export type { TurnState };
