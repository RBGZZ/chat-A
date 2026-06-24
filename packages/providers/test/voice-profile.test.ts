import { describe, it, expect } from 'vitest';
import { loadVoiceProfile } from '../src/voice-profile';

/**
 * voice 配置块解析(§4.1)。重点:**全空 env → 各键缺席**(缺省安全,逐字现状);
 * auto/空 视作自动检测(inputLang 省略);完整 env → 全字段(含 cloneRef)。
 */
describe('loadVoiceProfile(§4.1 voice 配置块)', () => {
  it('全空 env → 各键均缺席', () => {
    const p = loadVoiceProfile({});
    expect('inputLang' in p).toBe(false);
    expect('outputLang' in p).toBe(false);
    expect('voiceId' in p).toBe(false);
    expect('cloneRef' in p).toBe(false);
  });

  it('input_lang=auto(大小写不敏感)→ inputLang 缺席(自动检测)', () => {
    expect('inputLang' in loadVoiceProfile({ CHAT_A_VOICE_INPUT_LANG: 'auto' })).toBe(false);
    expect('inputLang' in loadVoiceProfile({ CHAT_A_VOICE_INPUT_LANG: 'AUTO' })).toBe(false);
    expect('inputLang' in loadVoiceProfile({ CHAT_A_VOICE_INPUT_LANG: '  ' })).toBe(false);
  });

  it('input_lang=具体语种 → 填该值', () => {
    expect(loadVoiceProfile({ CHAT_A_VOICE_INPUT_LANG: 'en' }).inputLang).toBe('en');
  });

  it('output_lang 空 → 缺席;非空 → 填值', () => {
    expect('outputLang' in loadVoiceProfile({ CHAT_A_VOICE_OUTPUT_LANG: '' })).toBe(false);
    expect(loadVoiceProfile({ CHAT_A_VOICE_OUTPUT_LANG: 'zh' }).outputLang).toBe('zh');
  });

  it('clone_ref:仅 ref 路径非空时产出 cloneRef,refText/refLang 各自可选', () => {
    expect('cloneRef' in loadVoiceProfile({ CHAT_A_VOICE_CLONE_REF_TEXT: '只有文本无路径' })).toBe(false);
    const p = loadVoiceProfile({ CHAT_A_VOICE_CLONE_REF: '/r.wav' });
    expect(p.cloneRef).toEqual({ source: '/r.wav' });
    expect('refText' in p.cloneRef!).toBe(false);
  });

  it('完整 env → 全字段(含 cloneRef 全字段)', () => {
    const p = loadVoiceProfile({
      CHAT_A_VOICE_INPUT_LANG: 'en',
      CHAT_A_VOICE_OUTPUT_LANG: 'zh',
      CHAT_A_VOICE_ID: 'xiaoxue_v2',
      CHAT_A_VOICE_CLONE_REF: '/path/ref.wav',
      CHAT_A_VOICE_CLONE_REF_TEXT: '你好',
      CHAT_A_VOICE_CLONE_REF_LANG: 'zh',
    });
    expect(p).toEqual({
      inputLang: 'en',
      outputLang: 'zh',
      voiceId: 'xiaoxue_v2',
      cloneRef: { source: '/path/ref.wav', refText: '你好', refLang: 'zh' },
    });
  });
});
