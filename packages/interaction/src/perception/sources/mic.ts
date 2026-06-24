import { makeRawEvent } from '@chat-a/protocol';
import type { PerceptionSource, RawEmit, SourceHealth } from '../types';

/** 麦克风感知到的一段语音事件(由语音管线供给,非此处采集)。 */
export interface MicPerception {
  /** 事件类型(如 'speech_start'/'speech_end'/'final');映射 raw kind。 */
  readonly kind: string;
  /** 可选转写文本/能量等结构化负载。 */
  readonly value?: Readonly<Record<string, unknown>>;
  readonly atMs?: number;
}

export interface MicSourceOptions {
  readonly now?: () => number;
}

/**
 * 内置感知源:**麦克风接入点**(§12.1 task 1.4)。
 *
 * 关键:麦克风的实际采集/VAD/STT 在**既有语音管线**(packages/client + voice-detect),
 * 本 change **不重复采集**,只提供一个 `feed()` 接入点——语音管线把已成形的语音事件喂进来,
 * 源转成 `raw:heard:<kind>` 进入统一去抖管线。这样"听觉"与时钟/通知归一为同一 signal 通道,
 * 且与语音管线解耦(接缝;真机由 runtime 接线把 VoiceLoop 事件桥到此)。
 */
export interface MicPerceptionSource extends PerceptionSource {
  /** 由语音管线投喂一条语音感知事件(start 后生效)。 */
  feed(event: MicPerception): void;
}

export function createMicSource(opts: MicSourceOptions = {}): MicPerceptionSource {
  const now = opts.now ?? (() => Date.now());
  let emit: RawEmit | undefined;
  let lastEmitMs: number | undefined;
  let running = false;

  return {
    id: 'mic',
    modality: 'heard',
    start(e: RawEmit): void {
      running = true;
      emit = e;
    },
    stop(): void {
      running = false;
      emit = undefined;
    },
    health(): SourceHealth {
      return {
        healthy: running,
        ...(lastEmitMs !== undefined ? { lastEmitMs } : {}),
      };
    },
    feed(event: MicPerception): void {
      if (!running || emit === undefined) return;
      const atMs = event.atMs ?? now();
      lastEmitMs = atMs;
      emit(makeRawEvent('heard', event.kind, atMs, event.value ?? {}));
    },
  };
}
