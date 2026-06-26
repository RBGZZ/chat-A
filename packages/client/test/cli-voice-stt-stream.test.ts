import { describe, it, expect } from 'vitest';
import {
  createStreamingSttPort,
  loadVoicePath,
  parseVadThreshold,
  isDenylistEnabled,
  isStreamEnergyGateEnabled,
} from '../src/cli-voice';

describe('cli-voice 流式路装配', () => {
  it("loadVoicePath 识别三值 stt/omni/stt-stream", () => {
    expect(loadVoicePath({ CHAT_A_VOICE_PATH: 'stt-stream' } as NodeJS.ProcessEnv)).toBe('stt-stream');
    expect(loadVoicePath({ CHAT_A_VOICE_PATH: 'omni' } as NodeJS.ProcessEnv)).toBe('omni');
    expect(loadVoicePath({} as NodeJS.ProcessEnv)).toBe('stt');
  });

  it('有 key → 构造出流式端口', () => {
    const p = createStreamingSttPort({ CHAT_A_DASHSCOPE_API_KEY: 'k' } as unknown as NodeJS.ProcessEnv);
    expect(p).toBeDefined();
    expect(typeof p!.openSession).toBe('function');
  });

  it('缺 key → undefined(回落批式)', () => {
    expect(createStreamingSttPort({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('parseVadThreshold:缺省/非法/越界 → 0.5;合法 → 透传', () => {
    expect(parseVadThreshold(undefined)).toBe(0.5);
    expect(parseVadThreshold('')).toBe(0.5);
    expect(parseVadThreshold('abc')).toBe(0.5);
    expect(parseVadThreshold('-0.1')).toBe(0.5);
    expect(parseVadThreshold('1.5')).toBe(0.5);
    expect(parseVadThreshold('0.3')).toBe(0.3);
    expect(parseVadThreshold('0')).toBe(0);
    expect(parseVadThreshold('1')).toBe(1);
  });

  it('isDenylistEnabled:默认开;仅 0/false/off 关', () => {
    expect(isDenylistEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isDenylistEnabled({ CHAT_A_STT_DENYLIST: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(isDenylistEnabled({ CHAT_A_STT_DENYLIST: '0' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isDenylistEnabled({ CHAT_A_STT_DENYLIST: 'false' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isDenylistEnabled({ CHAT_A_STT_DENYLIST: 'OFF' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it('isStreamEnergyGateEnabled:默认关;仅 1/true/on 开', () => {
    expect(isStreamEnergyGateEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isStreamEnergyGateEnabled({ CHAT_A_STT_ENERGY_GATE: '0' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isStreamEnergyGateEnabled({ CHAT_A_STT_ENERGY_GATE: 'off' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isStreamEnergyGateEnabled({ CHAT_A_STT_ENERGY_GATE: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(isStreamEnergyGateEnabled({ CHAT_A_STT_ENERGY_GATE: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(isStreamEnergyGateEnabled({ CHAT_A_STT_ENERGY_GATE: 'ON' } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});
