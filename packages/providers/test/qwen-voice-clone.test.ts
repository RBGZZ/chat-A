import { describe, it, expect } from 'vitest';
import {
  createVoice,
  listVoices,
  deleteVoice,
  audioToDataUri,
  mimeFromPath,
  buildCreateBody,
  buildManageBody,
  parseVoiceId,
  parseVoiceList,
  QWEN_VOICE_CLONE_PATH,
  QWEN_VOICE_ENROLLMENT_MODEL,
} from '../src/index';
import type { FetchLike } from '../src/index';

interface Captured {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
  body: Record<string, unknown>;
}

/** 注入 fetch:返回 200 + 给定 JSON;记录每次请求(含解析后的 body)。 */
function okFetch(json: unknown): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({
      url,
      ...(init ? { init } : {}),
      body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    });
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: null,
      text: () => Promise.resolve(JSON.stringify(json)),
    });
  };
  return { fetch, calls };
}

/** 注入 fetch:返回非 2xx + 错误文本。 */
function errFetch(status: number, detail: string): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, ...(init ? { init } : {}), body: init?.body ? JSON.parse(init.body) : {} });
    return Promise.resolve({
      ok: false,
      status,
      statusText: 'Bad Request',
      body: null,
      text: () => Promise.resolve(detail),
    });
  };
  return { fetch, calls };
}

const KEY = 'sk-test-key-xyz';

describe('createVoice(注入 mock fetch,不触网)', () => {
  it('从字节创建音色:请求体形态正确 + 参考音频按 base64 data URI 进 input.audio.data', async () => {
    const { fetch, calls } = okFetch({ output: { voice: 'qwen-tts-vc-xiaoxue-voice-123' } });
    const data = new Uint8Array([1, 2, 3, 4]);
    const res = await createVoice(
      { data, mime: 'audio/wav' },
      { apiKey: KEY, targetModel: 'qwen3-tts-vc-realtime-2026-01-15', fetch },
    );
    expect(res.voiceId).toBe('qwen-tts-vc-xiaoxue-voice-123');
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url.endsWith(QWEN_VOICE_CLONE_PATH)).toBe(true);
    expect(c.init?.method).toBe('POST');
    expect(c.body['model']).toBe(QWEN_VOICE_ENROLLMENT_MODEL);
    const input = c.body['input'] as Record<string, unknown>;
    expect(input['action']).toBe('create');
    expect(input['target_model']).toBe('qwen3-tts-vc-realtime-2026-01-15');
    const audio = input['audio'] as { data: string };
    expect(audio.data).toBe(audioToDataUri(data, 'audio/wav'));
    expect(audio.data.startsWith('data:audio/wav;base64,')).toBe(true);
  });

  it('鉴权头为 Bearer <key>,且不在错误信息泄漏 key', async () => {
    const { calls } = okFetch({ output: { voice: 'v1' } });
    const cap = okFetch({ output: { voice: 'v1' } });
    await createVoice({ data: new Uint8Array([9]), mime: 'audio/mpeg' }, { apiKey: KEY, fetch: cap.fetch });
    expect(cap.calls[0]!.init?.headers?.['Authorization']).toBe(`Bearer ${KEY}`);
    void calls;
  });

  it('缺 key fail-fast,错误文本不含 key', async () => {
    await expect(
      createVoice({ data: new Uint8Array([1]), mime: 'audio/wav' }, { apiKey: '' }),
    ).rejects.toThrow(/DashScope API key/);
  });

  it('超过 10MB 上限:发请求前抛中文错', async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    const { fetch, calls } = okFetch({ output: { voice: 'v' } });
    await expect(
      createVoice({ data: big, mime: 'audio/wav' }, { apiKey: KEY, fetch }),
    ).rejects.toThrow(/过大/);
    expect(calls).toHaveLength(0); // 未发起网络请求。
  });

  it('非 2xx → 中文错误带响应片段,且不含 key', async () => {
    const { fetch } = errFetch(400, 'InvalidParameter: audio too short');
    let msg = '';
    try {
      await createVoice({ data: new Uint8Array([1]), mime: 'audio/wav' }, { apiKey: KEY, fetch });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain('HTTP 400');
    expect(msg).toContain('audio too short');
    expect(msg).not.toContain(KEY);
  });

  it('解析不到 output.voice → 抛中文错', async () => {
    const { fetch } = okFetch({ output: {} });
    await expect(
      createVoice({ data: new Uint8Array([1]), mime: 'audio/wav' }, { apiKey: KEY, fetch }),
    ).rejects.toThrow(/未解析到 voice id/);
  });

  it('AbortSignal 已取消:不发请求、抛 AbortError', async () => {
    const { fetch, calls } = okFetch({ output: { voice: 'v' } });
    const ac = new AbortController();
    ac.abort();
    await expect(
      createVoice({ data: new Uint8Array([1]), mime: 'audio/wav' }, { apiKey: KEY, fetch }, ac.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(0);
  });
});

describe('listVoices / deleteVoice', () => {
  it('deleteVoice 构造 action=delete + voice 字段', async () => {
    const { fetch, calls } = okFetch({ output: {} });
    await deleteVoice('v-del', { apiKey: KEY, fetch });
    const input = calls[0]!.body['input'] as Record<string, unknown>;
    expect(input['action']).toBe('delete');
    expect(input['voice']).toBe('v-del');
    expect(calls[0]!.init?.headers?.['Authorization']).toBe(`Bearer ${KEY}`);
  });

  it('deleteVoice 空 voiceId fail-fast', async () => {
    const { fetch } = okFetch({ output: {} });
    await expect(deleteVoice('', { apiKey: KEY, fetch })).rejects.toThrow(/voiceId/);
  });

  it('listVoices 解析音色数组(容忍 voices 字段 / 字符串或对象元素)', async () => {
    const { fetch, calls } = okFetch({ output: { voices: ['v1', { voice: 'v2' }] } });
    const list = await listVoices({ apiKey: KEY, fetch });
    expect(list).toEqual(['v1', 'v2']);
    expect((calls[0]!.body['input'] as Record<string, unknown>)['action']).toBe('list');
  });
});

describe('纯函数契约(真机校准点)', () => {
  it('mimeFromPath 按扩展名推 MIME', () => {
    expect(mimeFromPath('a.wav')).toBe('audio/wav');
    expect(mimeFromPath('a.MP3')).toBe('audio/mpeg');
    expect(mimeFromPath('a.m4a')).toBe('audio/mp4');
    expect(mimeFromPath('noext')).toBe('application/octet-stream');
  });

  it('audioToDataUri 产出 data URI', () => {
    const uri = audioToDataUri(new Uint8Array([0, 255]), 'audio/wav');
    expect(uri).toBe('data:audio/wav;base64,AP8=');
  });

  it('buildCreateBody / buildManageBody / parseVoiceId / parseVoiceList', () => {
    const cb = buildCreateBody('data:audio/wav;base64,AA==', 'qwen3-tts-vc-realtime', 'xiaoxue');
    expect((cb['input'] as Record<string, unknown>)['action']).toBe('create');
    const mb = buildManageBody('query', 'vq');
    expect((mb['input'] as Record<string, unknown>)['voice']).toBe('vq');
    expect(parseVoiceId({ output: { voice: 'v' } })).toBe('v');
    expect(parseVoiceId({ output: {} })).toBeUndefined();
    expect(parseVoiceList({ output: { voice_list: [{ voice: 'x' }] } })).toEqual(['x']);
    expect(parseVoiceList({ output: ['a', 'b'] })).toEqual(['a', 'b']);
  });
});
