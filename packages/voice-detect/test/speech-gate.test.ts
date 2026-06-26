import { describe, it, expect } from 'vitest';
import { SAMPLE_RATE_HZ, CHANNELS, SAMPLES_PER_FRAME, type PcmFrame } from '@chat-a/protocol';
import { passesSpeechGate, meetsSpeechGate, DEFAULT_SPEECH_GATE_CONFIG } from '@chat-a/voice-detect';

/** 一帧:160 样本(10ms@16k)填某固定振幅(便于控能量)。 */
function frame(i: number, amp: number): PcmFrame {
  const samples = new Int16Array(SAMPLES_PER_FRAME); // 160 = 10ms@16k
  samples.fill(amp);
  return { samples, sampleRate: SAMPLE_RATE_HZ, channels: CHANNELS, timestampMs: i * 10 };
}

describe('voice-detect/passesSpeechGate', () => {
  it('纯静音(全 0 帧,40 帧)→ false', () => {
    const frames: PcmFrame[] = [];
    for (let i = 0; i < 40; i++) frames.push(frame(i, 0));
    expect(passesSpeechGate(frames, DEFAULT_SPEECH_GATE_CONFIG)).toBe(false);
  });

  it('噪声尖峰(仅 2 帧高 RMS + 大量静音)→ false(有声时长 <100ms)', () => {
    const frames: PcmFrame[] = [];
    // 段够长(40 帧=400ms ≥ 300ms),但只有 2 帧有声(20ms < 100ms minVoicedMs)→ 拦。
    frames.push(frame(0, 8000)); // 归一 RMS ≈ 0.24 ≫ 0.02
    frames.push(frame(1, 8000));
    for (let i = 2; i < 40; i++) frames.push(frame(i, 0));
    expect(passesSpeechGate(frames, DEFAULT_SPEECH_GATE_CONFIG)).toBe(false);
  });

  it('真语音(35 帧、其中 ≥15 帧 RMS 高于阈)→ true', () => {
    const frames: PcmFrame[] = [];
    // 35 帧=350ms ≥ 300ms;15 帧有声=150ms ≥ 100ms → 放行。
    for (let i = 0; i < 15; i++) frames.push(frame(i, 8000));
    for (let i = 15; i < 35; i++) frames.push(frame(i, 0));
    expect(passesSpeechGate(frames, DEFAULT_SPEECH_GATE_CONFIG)).toBe(true);
  });

  it('过短(10 帧高 RMS,<300ms)→ false(时长不够)', () => {
    const frames: PcmFrame[] = [];
    // 10 帧=100ms < 300ms minSpeechMs → 拦(即便全有声)。
    for (let i = 0; i < 10; i++) frames.push(frame(i, 8000));
    expect(passesSpeechGate(frames, DEFAULT_SPEECH_GATE_CONFIG)).toBe(false);
  });

  it('空数组 → false', () => {
    expect(passesSpeechGate([], DEFAULT_SPEECH_GATE_CONFIG)).toBe(false);
  });
});

describe('voice-detect/meetsSpeechGate(标量谓词,单一真相源)', () => {
  it('段够长 + 有声足够 → true', () => {
    expect(meetsSpeechGate({ totalMs: 350, voicedMs: 150 }, DEFAULT_SPEECH_GATE_CONFIG)).toBe(true);
  });
  it('段过短(<minSpeechMs)→ false', () => {
    expect(meetsSpeechGate({ totalMs: 100, voicedMs: 100 }, DEFAULT_SPEECH_GATE_CONFIG)).toBe(false);
  });
  it('有声不足(<minVoicedMs)→ false', () => {
    expect(meetsSpeechGate({ totalMs: 400, voicedMs: 20 }, DEFAULT_SPEECH_GATE_CONFIG)).toBe(false);
  });
  it('边界值(恰好等于阈)→ true', () => {
    expect(meetsSpeechGate({ totalMs: 300, voicedMs: 100 }, DEFAULT_SPEECH_GATE_CONFIG)).toBe(true);
  });
});
