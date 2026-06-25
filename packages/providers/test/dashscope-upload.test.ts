import { describe, it, expect } from 'vitest';
import {
  getUploadPolicy,
  uploadToDashScopeTemp,
  buildPolicyUrl,
  parseUploadPolicy,
  buildOssKey,
  buildOssFormFields,
  buildOssUrl,
  ossResolveHeaders,
  OSS_RESOURCE_RESOLVE_HEADER,
  DASHSCOPE_UPLOAD_POLICY_PATH,
  type UploadFetchLike,
} from '../src/index';

const KEY = 'sk-test-upload';

const POLICY_JSON = {
  data: {
    upload_host: 'https://dashscope-instant.oss-cn-beijing.aliyuncs.com',
    upload_dir: 'abc/2026-06-25/xyz',
    oss_access_key_id: 'STS.akid',
    policy: 'eyJ...base64policy',
    signature: 'sigvalue',
    x_oss_object_acl: 'private',
    x_oss_forbid_overwrite: 'true',
  },
  request_id: 'req-1',
};

interface Captured {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string | FormData };
}

/** 路由 mock:含 /uploads → 返回凭证 JSON;其它(OSS host)→ 返回 200。 */
function routeFetch(): { fetch: UploadFetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: UploadFetchLike = (url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.includes(DASHSCOPE_UPLOAD_POLICY_PATH)) {
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve(JSON.stringify(POLICY_JSON)),
      });
    }
    return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve('') });
  };
  return { fetch, calls };
}

describe('dashscope-upload 纯函数', () => {
  it('buildPolicyUrl 带 action=getPolicy + model', () => {
    const u = buildPolicyUrl('https://dashscope.aliyuncs.com/', 'cosyvoice-v3.5-flash');
    expect(u).toBe(
      'https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=cosyvoice-v3.5-flash',
    );
  });

  it('parseUploadPolicy 解析 data 包一层', () => {
    const p = parseUploadPolicy(POLICY_JSON);
    expect(p?.uploadHost).toContain('oss-cn-beijing');
    expect(p?.uploadDir).toBe('abc/2026-06-25/xyz');
    expect(p?.ossAccessKeyId).toBe('STS.akid');
  });

  it('parseUploadPolicy 缺字段返回 undefined', () => {
    expect(parseUploadPolicy({ data: { upload_host: 'h' } })).toBeUndefined();
    expect(parseUploadPolicy(null)).toBeUndefined();
  });

  it('buildOssKey / buildOssUrl', () => {
    expect(buildOssKey('dir/sub', 'a.wav')).toBe('dir/sub/a.wav');
    expect(buildOssKey('dir/', '/a.wav')).toBe('dir/a.wav');
    expect(buildOssUrl('dir/a.wav')).toBe('oss://dir/a.wav');
  });

  it('buildOssFormFields 含 OSS PostObject 必备字段', () => {
    const p = parseUploadPolicy(POLICY_JSON)!;
    const f = buildOssFormFields(p, 'dir/a.wav');
    expect(f['OSSAccessKeyId']).toBe('STS.akid');
    expect(f['policy']).toBe(p.policy);
    expect(f['Signature']).toBe(p.signature);
    expect(f['key']).toBe('dir/a.wav');
    expect(f['success_action_status']).toBe('200');
  });

  it('ossResolveHeaders:oss:// 加解析头,https:// 不加', () => {
    expect(ossResolveHeaders('oss://k')[OSS_RESOURCE_RESOLVE_HEADER]).toBe('enable');
    expect(ossResolveHeaders('https://x.wav')[OSS_RESOURCE_RESOLVE_HEADER]).toBeUndefined();
  });
});

describe('getUploadPolicy / uploadToDashScopeTemp(注入 mock fetch,不触网)', () => {
  it('getUploadPolicy 带 Bearer 鉴权 + GET', async () => {
    const { fetch, calls } = routeFetch();
    const p = await getUploadPolicy({ apiKey: KEY, fetch });
    expect(p?.uploadDir).toBe('abc/2026-06-25/xyz');
    expect(calls[0]!.init?.method).toBe('GET');
    expect(calls[0]!.init?.headers?.['Authorization']).toBe(`Bearer ${KEY}`);
  });

  it('uploadToDashScopeTemp:getPolicy → OSS POST → oss:// URL', async () => {
    const { fetch, calls } = routeFetch();
    const url = await uploadToDashScopeTemp(new Uint8Array([1, 2, 3]), 'voice.wav', { apiKey: KEY, fetch });
    expect(url).toBe('oss://abc/2026-06-25/xyz/voice.wav');
    expect(calls).toHaveLength(2);
    // 第二次是 OSS POST 到 upload_host。
    expect(calls[1]!.url).toContain('oss-cn-beijing');
    expect(calls[1]!.init?.method).toBe('POST');
    expect(calls[1]!.init?.body).toBeInstanceOf(FormData);
  });

  it('缺 key fail-fast', async () => {
    await expect(uploadToDashScopeTemp(new Uint8Array([1]), 'a.wav', { apiKey: '' })).rejects.toThrow(
      /API key/,
    );
  });

  it('getPolicy 非 2xx → 中文错(不含 key)', async () => {
    const fetch: UploadFetchLike = () =>
      Promise.resolve({ ok: false, status: 403, statusText: 'Forbidden', text: () => Promise.resolve('denied') });
    let msg = '';
    try {
      await uploadToDashScopeTemp(new Uint8Array([1]), 'a.wav', { apiKey: KEY, fetch });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain('HTTP 403');
    expect(msg).not.toContain(KEY);
  });

  it('AbortSignal 已取消:抛 AbortError', async () => {
    const { fetch } = routeFetch();
    const ac = new AbortController();
    ac.abort();
    await expect(
      uploadToDashScopeTemp(new Uint8Array([1]), 'a.wav', { apiKey: KEY, fetch }, ac.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
