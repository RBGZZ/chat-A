/**
 * @chat-a/voice-detect —— VAD + TurnDetector/EOU 接缝 + 动态 endpointing 策略(§4 / §5b)。
 *
 * 三层各司其职(§4 行 159):
 *   - VAD(有没有声)        ── vad.ts:VadDetector 接口 + StubVadDetector(确定性桩)+ VadGate(去抖状态机)。
 *   - TurnDetector(说完没)  ── turn-detector.ts:EouModel 接口 + StubEouModel + TurnDetector(组合)。
 *   - 动态 endpointing 策略   ── endpointing.ts:纯函数 decideEndpointing/targetDelayFor + Ema + DynamicEndpointing + TEN 3 态。
 *
 * 行为即配置:所有阈值/延迟/EMA α/per-language 表在 config.ts,无 magic number。
 * 本包**不接 runtime**(回合接线后续);真 Silero VAD / Smart-Turn v3 ONNX 实现对应接口即可接入。
 */
export * from './config';
export * from './vad';
export * from './endpointing';
export * from './turn-detector';
export * from './silero-vad';
export * from './smart-turn-eou';
export * from './energy-vad';
export * from './silence-eou';
export * from './echo-guard';
export * from './speech-gate';
export * from './filler-denylist';
