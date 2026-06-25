import { describe, it, expect } from 'vitest';
import {
  createCosyVoice,
  queryCosyVoice,
  listCosyVoices,
  deleteCosyVoice,
  assertCosyPrefix,
  buildCosyCreateBody,
  buildCosyManageBody,
  parseCosyVoiceId,
  parseCosyStatus,
  parseCosyVoiceList,
  COSYVOICE_CLONE_PATH,
  COSYVOICE_ENROLLMENT_MODEL,
  OSS_RESOURCE_RESOLVE_HEADER,
  type UploadFetchLike,
} from '../src/index';

const KEY = 'sk-test-cosy';

interface Captured {
  url: string;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
}

/** mock fetch:据 input.action 返回相应 JSON;记录请求(含解析 body)。 */
function actionFetch(handlers: Record<string, unknown>): { fetch: UploadFetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: UploadFetchLike = (url, init) => {
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, ...(init?.headers ? { headers: init.headers } : {}), body });
    const action = ((body['input'] as Record<string, unknown>)?.['action'] as string) ?? '';
    const json = handlers[action] ?? {};
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve(JSON.stringify(json)),
    });
  };
  return { fetch, calls };
}

describe('cosyvoice 复刻纯函数', () => {
  it('assertCosyPrefix:合法/非法', () => {
    expect(() => assertCosyPrefix('xiaoxue')).not.toThrow();
    expect(() => assertCosyPrefix('ab12')).not.toThrow();
    expect(() => assertCosyPrefix('toolongprefix')).toThrow(/prefix/); // >10
    expect(() => assertCosyPrefix('has space')).toThrow(/prefix/);
    expect(() => assertCosyPrefix('中文')).toThrow(/prefix/);
  });

  it('buildCosyCreateBody:model=voice-enrollment / action=create_voice / language_hints 取首', () => {
    const b = buildCosyCreateBody('https://x.wav', 'cosyvoice-v3.5-flash', 'xiaoxue', ['zh', 'en']);
    expect(b['model']).toBe(COSYVOICE_ENROLLMENT_MODEL);
    const input = b['input'] as Record<string, unknown>;
    expect(input['action']).toBe('create_voice');
    expect(input['target_model']).toBe('cosyvoice-v3.5-flash');
    expect(input['prefix']).toBe('xiaoxue');
    expect(input['url']).toBe('https://x.wav');
    expect(input['language_hints']).toEqual(['zh']); // 仅首元素
  });

  it('buildCosyManageBody:list 带分页 + prefix,delete/query 带 voice_id', () => {
    const list = buildCosyManageBody('list_voice', undefined, 'xiaoxue');
    const li = list['input'] as Record<string, unknown>;
    expect(li['action']).toBe('list_voice');
    expect(li['page_index']).toBe(0);
    expect(li['prefix']).toBe('xiaoxue');
    const del = buildCosyManageBody('delete_voice', 'v-1');
    expect((del['input'] as Record<string, unknown>)['voice_id']).toBe('v-1');
    expect('page_index' in (del['input'] as Record<string, unknown>)).toBe(false);
  });

  it('parseCosyVoiceId / parseCosyStatus / parseCosyVoiceList', () => {
    expect(parseCosyVoiceId({ output: { voice_id: 'v9' } })).toBe('v9');
    expect(parseCosyVoiceId({ output: {} })).toBeUndefined();
    expect(parseCosyStatus({ output: { status: 'ok' } })).toBe('OK');
    expect(parseCosyStatus({ output: { status: 'DEPLOYING' } })).toBe('DEPLOYING');
    expect(parseCosyStatus({ output: { status: 'weird' } })).toBe('UNKNOWN');
    expect(parseCosyVoiceList({ output: { voice_list: [{ voice_id: 'a' }, 'b'] } })).toEqual(['a', 'b']);
  });
});

describe('createCosyVoice(注入 mock fetch,不触网)', () => {
  it('给公网 url:create_voice → 轮询 OK → 返回 voiceId/status', async () => {
    const { fetch, calls } = actionFetch({
      create_voice: { output: { voice_id: 'cosyvoice-v3.5-flash-xiaoxue-abc' } },
      query_voice: { output: { status: 'OK' } },
    });
    const res = await createCosyVoice(
      { url: 'https://pub.example.com/voice.wav' },
      { apiKey: KEY, fetch, pollIntervalMs: 0 },
    );
    expect(res.voiceId).toBe('cosyvoice-v3.5-flash-xiaoxue-abc');
    expect(res.status).toBe('OK');
    // 第一次是 create_voice,后面是 query_voice。
    expect(calls[0]!.url.endsWith(COSYVOICE_CLONE_PATH)).toBe(true);
    expect((calls[0]!.body['input'] as Record<string, unknown>)['action']).toBe('create_voice');
    expect(calls[0]!.headers?.['Authorization']).toBe(`Bearer ${KEY}`);
    // 公网 https URL 不加 oss 解析头。
    expect(calls[0]!.headers?.[OSS_RESOURCE_RESOLVE_HEADER]).toBeUndefined();
  });

  it('waitForDeploy=false:仅创建直返(不轮询)', async () => {
    const { fetch, calls } = actionFetch({
      create_voice: { output: { voice_id: 'v-now' } },
    });
    const res = await createCosyVoice(
      { url: 'https://x.wav' },
      { apiKey: KEY, fetch, waitForDeploy: false },
    );
    expect(res.voiceId).toBe('v-now');
    expect(calls).toHaveLength(1); // 没有 query_voice
  });

  it('轮询 UNDEPLOYED → 抛部署失败', async () => {
    const { fetch } = actionFetch({
      create_voice: { output: { voice_id: 'v-bad' } },
      query_voice: { output: { status: 'UNDEPLOYED' } },
    });
    await expect(
      createCosyVoice({ url: 'https://x.wav' }, { apiKey: KEY, fetch, pollIntervalMs: 0 }),
    ).rejects.toThrow(/部署失败/);
  });

  it('轮询超时 → 抛超时(始终 DEPLOYING)', async () => {
    const { fetch } = actionFetch({
      create_voice: { output: { voice_id: 'v-slow' } },
      query_voice: { output: { status: 'DEPLOYING' } },
    });
    await expect(
      createCosyVoice(
        { url: 'https://x.wav' },
        { apiKey: KEY, fetch, pollIntervalMs: 0, maxPollAttempts: 3 },
      ),
    ).rejects.toThrow(/超时/);
  });

  it('非法 prefix:发请求前抛(不触网)', async () => {
    const { fetch, calls } = actionFetch({ create_voice: { output: { voice_id: 'v' } } });
    await expect(
      createCosyVoice({ url: 'https://x.wav' }, { apiKey: KEY, fetch, prefix: 'bad prefix!' }),
    ).rejects.toThrow(/prefix/);
    expect(calls).toHaveLength(0);
  });

  it('create 解析不到 voice_id → 抛中文错', async () => {
    const { fetch } = actionFetch({ create_voice: { output: {} } });
    await expect(
      createCosyVoice({ url: 'https://x.wav' }, { apiKey: KEY, fetch, waitForDeploy: false }),
    ).rejects.toThrow(/未解析到 voice_id/);
  });

  it('缺 key fail-fast', async () => {
    await expect(createCosyVoice({ url: 'https://x.wav' }, { apiKey: '' })).rejects.toThrow(/API key/);
  });
});

describe('queryCosyVoice / listCosyVoices / deleteCosyVoice', () => {
  it('queryCosyVoice 解析 status', async () => {
    const { fetch } = actionFetch({ query_voice: { output: { status: 'OK' } } });
    expect(await queryCosyVoice('v', { apiKey: KEY, fetch })).toBe('OK');
  });

  it('listCosyVoices 解析列表 + action=list_voice', async () => {
    const { fetch, calls } = actionFetch({
      list_voice: { output: { voice_list: ['v1', { voice_id: 'v2' }] } },
    });
    const list = await listCosyVoices({ apiKey: KEY, fetch });
    expect(list).toEqual(['v1', 'v2']);
    expect((calls[0]!.body['input'] as Record<string, unknown>)['action']).toBe('list_voice');
  });

  it('deleteCosyVoice:action=delete_voice + voice_id', async () => {
    const { fetch, calls } = actionFetch({ delete_voice: { output: {} } });
    await deleteCosyVoice('v-del', { apiKey: KEY, fetch });
    const input = calls[0]!.body['input'] as Record<string, unknown>;
    expect(input['action']).toBe('delete_voice');
    expect(input['voice_id']).toBe('v-del');
  });

  it('deleteCosyVoice 空 voiceId fail-fast', async () => {
    const { fetch } = actionFetch({});
    await expect(deleteCosyVoice('', { apiKey: KEY, fetch })).rejects.toThrow(/voiceId/);
  });
});
