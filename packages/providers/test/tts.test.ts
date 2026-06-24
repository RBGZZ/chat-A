import { describe, it, expect } from 'vitest';
import {
  FakeTts,
  FAKE_TTS_CLONE_MARK,
  createTts,
  listTtsKinds,
  loadTtsConfig,
  chunkByteLength,
  OpenAiCompatTts,
  GptSoVitsTts,
  TTS_SAMPLE_RATE_HZ,
  toQwenLanguageType,
} from '../src/index';
import type { PcmChunk, TtsConfig, TtsRefAudio } from '../src/index';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('FakeTts(确定性可校验音频块)', () => {
  it('产出 PcmChunk:24kHz mono,块长与文本成比例', async () => {
    const tts = new FakeTts({ samplesPerChar: 10 });
    const chunks = await collect(tts.synthesize('你好'));
    expect(chunks.length).toBe(1); // 无句末标点 → 整段一块
    const c = chunks[0] as PcmChunk;
    expect(c.sampleRate).toBe(TTS_SAMPLE_RATE_HZ);
    expect(c.channels).toBe(1);
    expect(c.samples.length).toBe('你好'.length * 10); // 2 字符 * 10
    expect(chunkByteLength(c)).toBe(c.samples.length * 2);
  });

  it('多句 → 多块(按句末标点切段)', async () => {
    const tts = new FakeTts({ samplesPerChar: 5 });
    const chunks = await collect(tts.synthesize('你好。在吗?'));
    expect(chunks.length).toBe(2);
  });

  it('两次运行字节完全一致(确定性)', async () => {
    const tts = new FakeTts({ samplesPerChar: 8 });
    const a = await collect(tts.synthesize('测试一下'));
    const b = await collect(tts.synthesize('测试一下'));
    expect(a.map((c) => [...c.samples])).toEqual(b.map((c) => [...c.samples]));
  });

  it('空文本 → 无音频块', async () => {
    const tts = new FakeTts();
    expect(await collect(tts.synthesize('   '))).toEqual([]);
  });
});

describe('FakeTts 音色复刻路径(§4.1/v2.1)', () => {
  const ref: TtsRefAudio = { source: '/samples/xiaoxue.wav', refText: '你好呀', refLang: 'zh' };

  it('传 refAudio → 首样本带复刻标记(可校验复刻路径走到)', async () => {
    const tts = new FakeTts({ samplesPerChar: 10 });
    const chunks = await collect(tts.synthesize('合成这句', { refAudio: ref }));
    expect(chunks[0]?.samples[0]).toBe(FAKE_TTS_CLONE_MARK);
  });

  it('选预注册复刻 voiceId → 同样走复刻标记', async () => {
    const tts = new FakeTts({ samplesPerChar: 10 });
    const chunks = await collect(tts.synthesize('用小雪音色', { voiceId: 'xiaoxue_v2' }));
    expect(chunks[0]?.samples[0]).toBe(FAKE_TTS_CLONE_MARK);
  });

  it('不传复刻参数 → 无标记(普通路径)', async () => {
    const tts = new FakeTts({ samplesPerChar: 10 });
    const chunks = await collect(tts.synthesize('普通合成'));
    expect(chunks[0]?.samples[0]).not.toBe(FAKE_TTS_CLONE_MARK);
  });

  it('能力位 voiceCloning=false + 传 refAudio → fail-fast', async () => {
    const tts = new FakeTts({ capabilities: { voiceCloning: false } });
    await expect(collect(tts.synthesize('合成', { refAudio: ref }))).rejects.toThrow(/不支持音色复刻/);
  });

  it('FakeTts 默认能力声明:多语种 / 含预注册音色 / 24kHz / 流式 / 支持复刻', () => {
    const tts = new FakeTts();
    expect(tts.capabilities).toEqual({
      languages: ['*'],
      voiceId: ['fake-voice', 'xiaoxue_v2'],
      sampleRate: TTS_SAMPLE_RATE_HZ,
      streaming: true,
      voiceCloning: true,
    });
  });
});

describe('toQwenLanguageType(ISO 码 → Qwen language_type 名)', () => {
  it('ISO 码映射到 Qwen 名', () => {
    expect(toQwenLanguageType('zh')).toBe('Chinese');
    expect(toQwenLanguageType('en')).toBe('English');
    expect(toQwenLanguageType('ja')).toBe('Japanese');
    expect(toQwenLanguageType('ko')).toBe('Korean');
    expect(toQwenLanguageType('de')).toBe('German');
    expect(toQwenLanguageType('it')).toBe('Italian');
    expect(toQwenLanguageType('pt')).toBe('Portuguese');
    expect(toQwenLanguageType('es')).toBe('Spanish');
    expect(toQwenLanguageType('fr')).toBe('French');
    expect(toQwenLanguageType('ru')).toBe('Russian');
  });

  it('大小写不敏感', () => {
    expect(toQwenLanguageType('ZH')).toBe('Chinese');
    expect(toQwenLanguageType('En')).toBe('English');
  });

  it('未给 / 空 → undefined(=不发 = Auto,逐字回归)', () => {
    expect(toQwenLanguageType()).toBeUndefined();
    expect(toQwenLanguageType('')).toBeUndefined();
    expect(toQwenLanguageType('   ')).toBeUndefined();
  });

  it('未知码 → undefined(优雅落回 Auto,不抛)', () => {
    expect(toQwenLanguageType('xx')).toBeUndefined();
    expect(toQwenLanguageType('zh-CN')).toBeUndefined();
  });

  it('已是合法 Qwen 名 → 归一原样返回(兼容用户直传)', () => {
    expect(toQwenLanguageType('Chinese')).toBe('Chinese');
    expect(toQwenLanguageType('chinese')).toBe('Chinese');
    expect(toQwenLanguageType('Auto')).toBe('Auto');
    expect(toQwenLanguageType('english')).toBe('English');
  });
});

describe('TTS 能力门 fail-fast(语种,§4.3)', () => {
  it('限定语种 + 外语种 → fail-fast', async () => {
    const tts = new FakeTts({ capabilities: { languages: ['zh'] } });
    await expect(collect(tts.synthesize('hi', { language: 'en' }))).rejects.toThrow(/不支持语种 "en"/);
  });

  it('OpenAiCompatTts voiceCloning=false:传 refAudio → fail-fast', async () => {
    const tts = new OpenAiCompatTts({ id: 'openai', model: 'tts-1', apiKey: 'k', baseURL: 'http://x/v1', voice: 'alloy' });
    expect(tts.capabilities.voiceCloning).toBe(false);
    await expect(
      collect(tts.synthesize('hi', { refAudio: { source: '/r.wav' } })),
    ).rejects.toThrow(/不支持音色复刻/);
  });
});

describe('createTts(工厂按判别联合切换)+ loadTtsConfig', () => {
  it('kind: fake → FakeTts(voiceCloning 透传)', () => {
    const tts = createTts({ kind: 'fake', voiceCloning: false });
    expect(tts).toBeInstanceOf(FakeTts);
    expect(tts.capabilities.voiceCloning).toBe(false);
  });

  it('kind: openai-compat → OpenAiCompatTts(真实字段透传)', () => {
    const tts = createTts({
      kind: 'openai-compat',
      model: 'tts-1-hd',
      apiKey: 'k',
      baseURL: 'https://api.openai.com/v1',
      voice: 'alloy',
      responseFormat: 'pcm',
      speed: 1.2,
    });
    expect(tts).toBeInstanceOf(OpenAiCompatTts);
    expect(tts.capabilities.sampleRate).toBe(TTS_SAMPLE_RATE_HZ);
  });

  it('kind: gpt-sovits → GptSoVitsTts(真复刻引擎已接入,voiceCloning=true)', () => {
    const tts = createTts({ kind: 'gpt-sovits', baseURL: 'http://127.0.0.1:9880', textLang: 'zh' });
    expect(tts).toBeInstanceOf(GptSoVitsTts);
    expect(tts.capabilities.voiceCloning).toBe(true);
    expect(tts.capabilities.streaming).toBe(true);
  });

  it('kind: edge → 占位抛错(真引擎以后接)', () => {
    expect(() => createTts({ kind: 'edge', voice: 'zh-CN-XiaoxiaoNeural' })).toThrow(/edge TTS 尚未接入/);
  });

  it('kind: kokoro 未注入 session → 明确报错"需运行时端口"(非崩,非"尚未接入")', () => {
    expect(() => createTts({ kind: 'kokoro', voice: 'af_bella' })).toThrow(/需运行时提供 session 端口/);
  });

  it('未知 kind → 抛错并列出已注册项', () => {
    expect(() => createTts({ kind: 'nope' } as unknown as TtsConfig)).toThrow(/unknown TTS kind "nope"/);
  });

  it('已注册 kind 列表', () => {
    expect([...listTtsKinds()].sort()).toEqual([
      'edge',
      'fake',
      'gpt-sovits',
      'kokoro',
      'openai-compat',
      'qwen-tts',
    ]);
  });

  it('全空 env → 降级 fake', () => {
    expect(loadTtsConfig({})).toEqual({ kind: 'fake' });
  });

  it('齐备 openai-compat env → openai-compat(真实字段)', () => {
    const cfg = loadTtsConfig({
      CHAT_A_TTS_MODEL: 'tts-1',
      CHAT_A_TTS_API_KEY: 'k',
      CHAT_A_TTS_BASE_URL: 'https://api.openai.com/v1',
      CHAT_A_TTS_VOICE: 'alloy',
      CHAT_A_TTS_RESPONSE_FORMAT: 'pcm',
      CHAT_A_TTS_SPEED: '1.25',
    });
    expect(cfg).toEqual({
      kind: 'openai-compat',
      model: 'tts-1',
      apiKey: 'k',
      baseURL: 'https://api.openai.com/v1',
      voice: 'alloy',
      responseFormat: 'pcm',
      speed: 1.25,
    });
  });

  it('edge env → 真实 Edge-TTS 字段', () => {
    const cfg = loadTtsConfig({
      CHAT_A_TTS_KIND: 'edge',
      CHAT_A_TTS_VOICE: 'zh-CN-XiaoxiaoNeural',
      CHAT_A_TTS_RATE: '+10%',
      CHAT_A_TTS_PITCH: '+0Hz',
    });
    expect(cfg).toEqual({ kind: 'edge', voice: 'zh-CN-XiaoxiaoNeural', rate: '+10%', pitch: '+0Hz' });
  });

  it('gpt-sovits env → 真实复刻字段(ref/prompt)', () => {
    const cfg = loadTtsConfig({
      CHAT_A_TTS_KIND: 'gpt-sovits',
      CHAT_A_TTS_BASE_URL: 'http://127.0.0.1:9880',
      CHAT_A_TTS_LANGUAGE: 'zh',
      CHAT_A_TTS_REF_AUDIO: '/samples/xiaoxue.wav',
      CHAT_A_TTS_PROMPT_TEXT: '你好呀',
      CHAT_A_TTS_PROMPT_LANG: 'zh',
    });
    expect(cfg).toEqual({
      kind: 'gpt-sovits',
      baseURL: 'http://127.0.0.1:9880',
      textLang: 'zh',
      refAudioPath: '/samples/xiaoxue.wav',
      promptText: '你好呀',
      promptLang: 'zh',
    });
  });

  it('exactOptionalPropertyTypes 合规:fake 不带可选键时不含该键', () => {
    const cfg = loadTtsConfig({});
    expect('languages' in cfg).toBe(false);
    expect('voiceCloning' in cfg).toBe(false);
  });
});
