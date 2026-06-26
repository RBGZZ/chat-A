import { describe, it, expect } from 'vitest';
import type { OmniAudioPort } from '../src/voice-loop';

describe('OmniAudioPort.inputSampleRate', () => {
  it('端口可声明输入采样率（结构上可选）', () => {
    const port: OmniAudioPort = {
      inputSampleRate: 16000,
      async *respondToAudio() {
        yield { type: 'end' as const };
      },
    };
    expect(port.inputSampleRate).toBe(16000);
  });
  it('不声明也满足接口（向后兼容）', () => {
    const port: OmniAudioPort = {
      async *respondToAudio() {
        yield { type: 'end' as const };
      },
    };
    expect(port.inputSampleRate).toBeUndefined();
  });
});
