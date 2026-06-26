import { describe, it, expect } from 'vitest';
import { DEFAULT_OMNI_MODEL, createOmniAudioPort } from '../src/cli-voice';

describe('createOmniAudioPort 默认与解耦', () => {
  it('默认 omni 模型为 qwen3.5-omni-flash-realtime', () => {
    expect(DEFAULT_OMNI_MODEL).toBe('qwen3.5-omni-flash-realtime');
  });
  it('有 key 时构造出端口并带 inputSampleRate', () => {
    const port = createOmniAudioPort({ CHAT_A_DASHSCOPE_API_KEY: 'k' } as any);
    expect(port).toBeDefined();
    expect((port as any).inputSampleRate).toBe(16000);
  });
  it('CHAT_A_OMNI_SAMPLE_RATE 覆盖输入率', () => {
    const port = createOmniAudioPort({ CHAT_A_DASHSCOPE_API_KEY: 'k', CHAT_A_OMNI_SAMPLE_RATE: '24000' } as any);
    expect((port as any).inputSampleRate).toBe(24000);
  });
  it('缺 key 回落（返回 undefined）', () => {
    expect(createOmniAudioPort({} as any)).toBeUndefined();
  });
});
