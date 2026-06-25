/**
 * DashScope 临时文件上传 —— 本地文件 → 临时存储 → `oss://` URL(承 §4.1 复刻链路 + §3.1 注入式可测)。
 *
 * 为什么:CosyVoice 声音复刻只收**公网/oss:// URL**(不收 base64),而桌面端要"选本地文件一键复刻"。
 * DashScope 提供官方临时上传(48h),让本地音频无需用户自备 OSS:
 *   1. `GET {endpoint}/api/v1/uploads?action=getPolicy&model={model}`(Bearer)→ 上传凭证;
 *   2. 凭证字段 + 文件以 multipart/form-data POST 到凭证给出的 `upload_host`;
 *   3. 拼出 `oss://{key}` 临时 URL;
 *   4. 后续接口(如复刻 create_voice)用该 oss:// URL 时**必须加头** `X-DashScope-OssResourceResolve: enable`。
 *
 * ⚠️ 真机校准点(隔离在可改函数/参数,承可追溯纪律):getPolicy 的 `model` 取值文档只说"音频模型"
 * (默认值见 {@link DASHSCOPE_UPLOAD_DEFAULT_MODEL},真机若 4xx 改此一处);create_voice 是否接受 oss://
 * + 该头亦待真机确认(复刻模块保留"用户直传公网 https URL"兜底通道)。
 *
 * 可测试性(R1 注入接缝,镜像 qwen-voice-clone):fetch 经注入端口 {@link UploadFetchLike},单测全程不触网。
 */

/** 北京区默认 DashScope HTTP 端点根(海外区 dashscope-intl 可覆盖)。 */
export const DASHSCOPE_UPLOAD_ENDPOINT = 'https://dashscope.aliyuncs.com';
/** 取上传凭证子路径。 */
export const DASHSCOPE_UPLOAD_POLICY_PATH = '/api/v1/uploads';
/**
 * getPolicy 默认 `model` 参数。**真机校准**:文档仅说"音频模型",声音复刻场景应填的确切值待确认
 * (候选 `voice-enrollment` / `cosyvoice-v3.5-flash`);真机若 4xx,改此默认或经 opts.model 覆盖。
 */
export const DASHSCOPE_UPLOAD_DEFAULT_MODEL = 'cosyvoice-v3.5-flash';
/** oss:// 临时 URL 在后续 API 调用须声明的解析头(缺失则服务端无法解析 oss:// 链接)。 */
export const OSS_RESOURCE_RESOLVE_HEADER = 'X-DashScope-OssResourceResolve';

/**
 * 注入式 fetch 端口(上传专用:body 需容纳 multipart FormData,故比 gpt-sovits 的 FetchLike 宽)。
 * 缺省绑 globalThis.fetch。
 */
export type UploadFetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | FormData;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

/** 上传凭证(getPolicy 解析结果;字段名对齐 DashScope 文档)。 */
export interface UploadPolicy {
  readonly uploadHost: string;
  readonly uploadDir: string;
  readonly ossAccessKeyId: string;
  readonly policy: string;
  readonly signature: string;
  readonly xOssObjectAcl: string;
  readonly xOssForbidOverwrite: string;
}

/** 上传通用选项。 */
export interface UploadOptions {
  /** DASHSCOPE_API_KEY;缺失/空 → fail-fast(**绝不打印**)。 */
  readonly apiKey: string;
  /** getPolicy 的 model 参数(默认 {@link DASHSCOPE_UPLOAD_DEFAULT_MODEL};真机校准点)。 */
  readonly model?: string;
  /** HTTP 端点根(默认北京区;海外区 dashscope-intl 可覆盖)。 */
  readonly endpoint?: string;
  /** 注入的 fetch(测试用);缺省懒绑 globalThis.fetch。 */
  readonly fetch?: UploadFetchLike;
}

// ───────────────────────────── 纯函数(契约可改;真机校准只改这里) ─────────────────────────────

/** 拼 getPolicy 请求 URL(query 带 action=getPolicy + model)。 */
export function buildPolicyUrl(endpoint: string, model: string): string {
  const root = endpoint.replace(/\/+$/, '');
  return `${root}${DASHSCOPE_UPLOAD_POLICY_PATH}?action=getPolicy&model=${encodeURIComponent(model)}`;
}

/** 解析 getPolicy 响应为 {@link UploadPolicy}。字段缺失时返回 undefined(调用方据此报错)。 */
export function parseUploadPolicy(resp: unknown): UploadPolicy | undefined {
  if (resp === null || typeof resp !== 'object') return undefined;
  // 凭证可能在 data 包一层,也可能在根;两者兼容。
  const root = resp as Record<string, unknown>;
  const data = (root['data'] !== null && typeof root['data'] === 'object'
    ? (root['data'] as Record<string, unknown>)
    : root);
  const uploadHost = str(data['upload_host']);
  const uploadDir = str(data['upload_dir']);
  const ossAccessKeyId = str(data['oss_access_key_id']);
  const policy = str(data['policy']);
  const signature = str(data['signature']);
  if (
    uploadHost === undefined ||
    uploadDir === undefined ||
    ossAccessKeyId === undefined ||
    policy === undefined ||
    signature === undefined
  ) {
    return undefined;
  }
  return {
    uploadHost,
    uploadDir,
    ossAccessKeyId,
    policy,
    signature,
    // ACL/forbid-overwrite 有默认(私有 / 不可覆盖),缺省按文档默认值。
    xOssObjectAcl: str(data['x_oss_object_acl']) ?? 'private',
    xOssForbidOverwrite: str(data['x_oss_forbid_overwrite']) ?? 'true',
  };
}

/** 据凭证 + 文件名拼 OSS object key(`{upload_dir}/{filename}`)。 */
export function buildOssKey(uploadDir: string, filename: string): string {
  const dir = uploadDir.replace(/\/+$/, '');
  const name = filename.replace(/^\/+/, '');
  return `${dir}/${name}`;
}

/**
 * 据凭证 + key 构造 OSS multipart 表单字段(不含 file 本身;file 由上传函数加)。
 * 字段名对齐 OSS PostObject 约定 + DashScope 凭证。
 */
export function buildOssFormFields(policy: UploadPolicy, key: string): Record<string, string> {
  return {
    OSSAccessKeyId: policy.ossAccessKeyId,
    policy: policy.policy,
    Signature: policy.signature,
    'x-oss-object-acl': policy.xOssObjectAcl,
    'x-oss-forbid-overwrite': policy.xOssForbidOverwrite,
    key,
    success_action_status: '200',
  };
}

/** 据最终 key 拼 `oss://` 临时 URL。 */
export function buildOssUrl(key: string): string {
  return `oss://${key}`;
}

/**
 * 后续接口调用时,据 URL 是否为 oss:// 决定是否附加解析头。
 * oss:// → 加 `X-DashScope-OssResourceResolve: enable`;普通公网 https:// → 不加。
 */
export function ossResolveHeaders(url: string): Record<string, string> {
  return url.startsWith('oss://') ? { [OSS_RESOURCE_RESOLVE_HEADER]: 'enable' } : {};
}

// ───────────────────────────── 公开 API ─────────────────────────────

/**
 * 取上传凭证:GET getPolicy → 解析 {@link UploadPolicy}。
 * 缺 key fail-fast;非 2xx / 解析失败抛清晰中文错(**不含 key**);AbortSignal 取消返回 undefined。
 */
export async function getUploadPolicy(
  opts: UploadOptions,
  signal?: AbortSignal,
): Promise<UploadPolicy | undefined> {
  assertApiKey(opts.apiKey);
  if (signal?.aborted === true) return undefined;
  const endpoint = opts.endpoint ?? DASHSCOPE_UPLOAD_ENDPOINT;
  const model = opts.model ?? DASHSCOPE_UPLOAD_DEFAULT_MODEL;
  const url = buildPolicyUrl(endpoint, model);
  const fetchImpl = resolveFetch(opts.fetch);

  let res: Awaited<ReturnType<UploadFetchLike>>;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (isAbortError(err)) return undefined;
    throw new Error(`取上传凭证请求 DashScope 失败: ${describeErr(err)}`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(
      `取上传凭证失败:HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 500)}` : ''}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`取上传凭证失败:响应非合法 JSON;片段:${text.slice(0, 300)}`);
  }
  const policy = parseUploadPolicy(json);
  if (policy === undefined) {
    throw new Error(`取上传凭证成功但缺必要字段(upload_host/upload_dir/policy/signature 等);片段:${snippet(json)}`);
  }
  return policy;
}

/**
 * 把本地文件字节上传到 DashScope 临时存储,返回 `oss://` URL。
 * 流程:getPolicy → multipart POST 到 upload_host → 拼 oss:// URL。
 * 缺 key fail-fast;任一步非 2xx / 失败抛清晰中文错(**不含 key**);取消抛 AbortError。
 */
export async function uploadToDashScopeTemp(
  bytes: Uint8Array,
  filename: string,
  opts: UploadOptions,
  signal?: AbortSignal,
): Promise<string> {
  assertApiKey(opts.apiKey);
  const policy = await getUploadPolicy(opts, signal);
  if (policy === undefined) {
    throw new DOMExceptionLike('文件上传已取消', 'AbortError');
  }
  if (signal?.aborted === true) {
    throw new DOMExceptionLike('文件上传已取消', 'AbortError');
  }

  const key = buildOssKey(policy.uploadDir, filename);
  const fields = buildOssFormFields(policy, key);
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  // file 必须放在表单最后(OSS PostObject 约定:策略字段在前、file 在后)。
  form.append('file', new Blob([toArrayBuffer(bytes)]), filename);

  const fetchImpl = resolveFetch(opts.fetch);
  let res: Awaited<ReturnType<UploadFetchLike>>;
  try {
    res = await fetchImpl(policy.uploadHost, {
      method: 'POST',
      body: form,
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (isAbortError(err)) throw new DOMExceptionLike('文件上传已取消', 'AbortError');
    throw new Error(`上传文件到临时存储失败: ${describeErr(err)}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `上传文件到临时存储失败:HTTP ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
    );
  }
  return buildOssUrl(key);
}

// ───────────────────────────── 内部工具 ─────────────────────────────

function assertApiKey(apiKey: string): void {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error(
      'DashScope 临时上传需要 API key;请设置环境变量 CHAT_A_DASHSCOPE_API_KEY(或在 .env.local 填写)',
    );
  }
}

function resolveFetch(injected: UploadFetchLike | undefined): UploadFetchLike {
  return injected ?? ((url, init) => (globalThis.fetch as unknown as UploadFetchLike)(url, init));
}

/** Uint8Array → 独立 ArrayBuffer(避免 SharedArrayBuffer/偏移问题,Blob 用)。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  if (typeof err === 'string') return err.slice(0, 500);
  return String(err).slice(0, 500);
}

function snippet(json: unknown): string {
  try {
    return JSON.stringify(json).slice(0, 300);
  } catch {
    return String(json).slice(0, 300);
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err !== null && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError'
  );
}

/** 轻量 AbortError(避免依赖 DOM lib 的 DOMException 类型)。 */
class DOMExceptionLike extends Error {
  constructor(message: string, name: string) {
    super(message);
    this.name = name;
  }
}
