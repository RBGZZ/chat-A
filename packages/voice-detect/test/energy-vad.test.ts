import { describe, it, expect } from 'vitest';
import { SAMPLE_RATE_HZ, CHANNELS, SAMPLES_PER_FRAME, type PcmFrame } from '@chat-a/protocol';
import {
  EnergyVadDetector,
  SilenceTimeoutEouModel,
  normalizedRms,
  DEFAULT_SILENCE_EOU_CONFIG,
} from '@chat-a/voice-detect';

/** 一帧:全部样本为某固定振幅(便于控能量)。 */
function frame(ts: number, amp: number): PcmFrame {
  const samples = new Int16Array(SAMPLES_PER_FRAME);
  samples.fill(amp);
  return { samples, sampleRate: SAMPLE_RATE_HZ, channels: CHANNELS, timestampMs: ts };
}

describe('voice-detect/normalizedRms', () => {
  it('全静音=0;满量程≈1', () => {
    expect(normalizedRms(new Int16Array(160), 32_768)).toBe(0);
    const loud = new Int16Array(160);
    loud.fill(32_767);
    expect(normalizedRms(loud, 32_768)).toBeCloseTo(1, 1);
  });
});

describe('voice-detect/EnergyVadDetector', () => {
  it('高能量帧达去抖阈 → speech_start;后续静音 → speech_end', () => {
    const vad = new EnergyVadDetector(); // 默认 rmsThreshold=0.02, start/end 各 2 帧去抖
    const loud = 8000; // 归一化 RMS ≈ 0.24 ≫ 0.02
    let started = false;
    let ended = false;
    // 连续高能量帧 → speech_start
    for (let i = 0; i < 4; i++) {
      const r = vad.pushFrame(frame(i * 10, loud));
      if (r.event?.type === 'speech_start') started = true;
    }
    expect(started).toBe(true);
    // 连续静音帧 → speech_end
    for (let i = 4; i < 8; i++) {
      const r = vad.pushFrame(frame(i * 10, 0));
      if (r.event?.type === 'speech_end') ended = true;
    }
    expect(ended).toBe(true);
  });

  it('全程低能量 → 不触发 speech_start', () => {
    const vad = new EnergyVadDetector();
    let started = false;
    for (let i = 0; i < 10; i++) {
      const r = vad.pushFrame(frame(i * 10, 100)); // 归一化 RMS ≈ 0.003 < 0.02
      if (r.event?.type === 'speech_start') started = true;
    }
    expect(started).toBe(false);
  });
});

describe('voice-detect/SilenceTimeoutEouModel', () => {
  it('窗尾静音达阈 → 高 eouProb', () => {
    const eou = new SilenceTimeoutEouModel();
    // 默认 600ms@16k = 9600 静音样本 = 60 帧静音。构 5 帧有声 + 70 帧静音。
    const window: PcmFrame[] = [];
    for (let i = 0; i < 5; i++) window.push(frame(i * 10, 8000));
    for (let i = 5; i < 75; i++) window.push(frame(i * 10, 0));
    expect(eou.predict(window)).toBe(1);
  });

  it('窗尾有声 → 低 eouProb', () => {
    const eou = new SilenceTimeoutEouModel();
    const window: PcmFrame[] = [frame(0, 0), frame(10, 0), frame(20, 8000)]; // 尾是有声
    expect(eou.predict(window)).toBe(0);
  });

  it('空窗 → 低 eouProb', () => {
    const eou = new SilenceTimeoutEouModel();
    expect(eou.predict([])).toBe(0);
  });

  it('配置可覆盖(更短超时)', () => {
    const eou = new SilenceTimeoutEouModel({
      config: { ...DEFAULT_SILENCE_EOU_CONFIG, silenceTimeoutMs: 10 }, // 10ms = 160 样本 = 1 帧
    });
    const window: PcmFrame[] = [frame(0, 8000), frame(10, 0)]; // 1 帧静音即够
    expect(eou.predict(window)).toBe(1);
  });
});
