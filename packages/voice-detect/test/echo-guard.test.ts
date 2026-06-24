import { describe, it, expect } from 'vitest';
import {
  EchoGuardGate,
  DEFAULT_ECHO_GUARD_CONFIG,
  type EchoGuardConfig,
} from '../src/echo-guard';

/** 构造一个高置信语音帧(prob 达标、speaking、能量满)。 */
function speech(energy01 = 1): { prob: number; energy01: number; speakingFromVad: boolean } {
  return { prob: 0.9, energy01, speakingFromVad: true };
}
/** 构造一个静音/低置信帧。 */
function silence(): { prob: number; energy01: number; speakingFromVad: boolean } {
  return { prob: 0.1, energy01: 0, speakingFromVad: false };
}

describe('voice-detect/EchoGuardGate', () => {
  it('禁用:恒即时确认(逐字现状)', () => {
    const gate = new EchoGuardGate({ ...DEFAULT_ECHO_GUARD_CONFIG, enabled: false, confirmFrames: 3 });
    // 即便喂静音也确认(等价无去抖)
    expect(gate.push(silence()).confirmed).toBe(true);
    expect(gate.push(speech()).confirmed).toBe(true);
  });

  it('N=1:首个达标帧即确认', () => {
    const cfg: EchoGuardConfig = { enabled: true, confirmFrames: 1, minSpeechProb: 0.5, minEnergy: 0 };
    const gate = new EchoGuardGate(cfg);
    const r = gate.push(speech());
    expect(r.confirmed).toBe(true);
    expect(r.run).toBe(1);
  });

  it('N=1:静音帧不确认', () => {
    const gate = new EchoGuardGate({ enabled: true, confirmFrames: 1, minSpeechProb: 0.5, minEnergy: 0 });
    expect(gate.push(silence()).confirmed).toBe(false);
  });

  it('N=3:需连续三帧才确认', () => {
    const gate = new EchoGuardGate({ enabled: true, confirmFrames: 3, minSpeechProb: 0.5, minEnergy: 0 });
    expect(gate.push(speech()).confirmed).toBe(false); // 1
    expect(gate.push(speech()).confirmed).toBe(false); // 2
    const r3 = gate.push(speech()); // 3
    expect(r3.confirmed).toBe(true);
    expect(r3.run).toBe(3);
  });

  it('N=3:中途掉线清零,需重新连续三帧', () => {
    const gate = new EchoGuardGate({ enabled: true, confirmFrames: 3, minSpeechProb: 0.5, minEnergy: 0 });
    gate.push(speech()); // run=1
    gate.push(speech()); // run=2
    expect(gate.push(silence()).run).toBe(0); // 掉线清零
    expect(gate.push(speech()).confirmed).toBe(false); // 1
    expect(gate.push(speech()).confirmed).toBe(false); // 2
    expect(gate.push(speech()).confirmed).toBe(true); // 3
  });

  it('断续回声样式(高-低-高-低...)永不确认', () => {
    const gate = new EchoGuardGate({ enabled: true, confirmFrames: 3, minSpeechProb: 0.5, minEnergy: 0 });
    for (let i = 0; i < 10; i++) {
      const frame = i % 2 === 0 ? speech() : silence();
      expect(gate.push(frame).confirmed).toBe(false);
    }
  });

  it('能量阈值:prob 达标但能量不足 → 不计入', () => {
    const gate = new EchoGuardGate({ enabled: true, confirmFrames: 2, minSpeechProb: 0.5, minEnergy: 0.3 });
    // prob 高但能量 0.1 < 0.3 → 清零
    expect(gate.push(speech(0.1)).run).toBe(0);
    // 能量达标 → 计入
    expect(gate.push(speech(0.5)).run).toBe(1);
    expect(gate.push(speech(0.5)).confirmed).toBe(true); // 连续 2 帧达标
  });

  it('reset 清连续计数', () => {
    const gate = new EchoGuardGate({ enabled: true, confirmFrames: 3, minSpeechProb: 0.5, minEnergy: 0 });
    gate.push(speech());
    gate.push(speech());
    gate.reset();
    expect(gate.push(speech()).run).toBe(1); // 重新从 1 开始
  });

  it('confirmFrames 误配 0/负 → 按 1 看待(不歧义)', () => {
    const gate = new EchoGuardGate({ enabled: true, confirmFrames: 0, minSpeechProb: 0.5, minEnergy: 0 });
    expect(gate.push(silence()).confirmed).toBe(false); // 仍需一个达标帧
    expect(gate.push(speech()).confirmed).toBe(true);
  });

  it('默认配置安全:enabled=false,即时确认', () => {
    const gate = new EchoGuardGate(); // DEFAULT_ECHO_GUARD_CONFIG
    expect(gate.push(silence()).confirmed).toBe(true);
  });
});
