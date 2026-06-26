/**
 * 语音管线可追溯事件(承 §8.1 可追溯性)。VoiceLoop 在各决策/回合边界 emit;
 * 装配层经可选 `voiceObserver` fan-out 到「实时结构日志(formatVoiceTrace)」与「SqliteVoiceTraceSink」。
 *
 * 放 protocol(零依赖共享类型):runtime emit、observability/client 消费,统一依赖 protocol,方向干净。
 * 判别联合按 `kind` 收窄;公共字段含缝合键(correlationId/sessionId/turnId,与 decision_traces/otel_spans 同键)。
 */

/** 所有语音 trace 事件的公共字段。 */
export interface VoiceTraceBase {
  /** 事件时刻(ms;注入时钟取,确定可重放)。 */
  readonly atMs: number;
  /** 与 decision_traces / otel_spans 缝合(§8.1);无上下文时可缺省。 */
  readonly correlationId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
}

/** 语音路径(与 VoiceLoop voicePath 对齐)。 */
export type VoiceTracePath = 'stt' | 'stt-stream' | 'omni';

/**
 * 语音管线可追溯事件(判别联合)。三档:采样(mic-sample)/决策(vad..state)/回合(stt-input..turn)。
 */
export type VoiceTraceEvent =
  /** 采样麦电平(每 ~50 帧/500ms 一次):判「麦到底有没有信号」。 */
  | (VoiceTraceBase & { readonly kind: 'mic-sample'; readonly rmsNorm: number })
  /** VAD 边沿。 */
  | (VoiceTraceBase & { readonly kind: 'vad'; readonly event: 'speech_start' | 'speech_end' })
  /** EOU 断句触发(尾静音时长)。 */
  | (VoiceTraceBase & { readonly kind: 'endpoint'; readonly silenceMs: number })
  /** EchoGuard 决策(speaking 期去抖)。 */
  | (VoiceTraceBase & {
      readonly kind: 'echo-guard';
      readonly tier: string;
      readonly rmsNorm: number;
      readonly run: number;
      readonly passed: boolean;
    })
  /** 送 ASR 前段级门判定(防静音幻觉)。 */
  | (VoiceTraceBase & {
      readonly kind: 'speech-gate';
      readonly passed: boolean;
      readonly totalMs: number;
      readonly voicedMs: number;
    })
  /** backchannel 附和决策。 */
  | (VoiceTraceBase & { readonly kind: 'backchannel'; readonly fired: boolean; readonly clipText?: string })
  /** 状态机迁移成功。 */
  | (VoiceTraceBase & { readonly kind: 'state'; readonly from: string; readonly to: string })
  /** 送 STT/omni 的音频摘要(时长 + 能量 + 路径):一眼看出喂进去的是不是静音。 */
  | (VoiceTraceBase & {
      readonly kind: 'stt-input';
      readonly path: VoiceTracePath;
      readonly durationMs: number;
      readonly rmsNorm: number;
    })
  /** STT/onFinal 转写结果。 */
  | (VoiceTraceBase & {
      readonly kind: 'stt-result';
      readonly text: string;
      readonly emotion?: string;
      readonly lang?: string;
      readonly isFinal: boolean;
    })
  /** 回合收尾摘要(结局 + 首音延迟)。 */
  | (VoiceTraceBase & {
      readonly kind: 'turn';
      readonly outcome: 'replied' | 'gated' | 'barge_in' | 'empty' | 'error';
      readonly ttfaMs?: number;
    });

/** VoiceTraceEvent 的 kind 取值(供 sink/查询用)。 */
export type VoiceTraceKind = VoiceTraceEvent['kind'];
