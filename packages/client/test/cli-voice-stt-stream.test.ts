import { describe, it, expect } from 'vitest';
import { createStreamingSttPort, loadVoicePath } from '../src/cli-voice';

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
});
