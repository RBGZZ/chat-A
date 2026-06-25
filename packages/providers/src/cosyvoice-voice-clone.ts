import { createRequire } from 'node:module';
import {
  uploadToDashScopeTemp,
  ossResolveHeaders,
  type UploadFetchLike,
} from './dashscope-upload';

/**
 * CosyVoice(阿里 DashScope)声音复刻 —— 云端**音色复刻**(承 §4.1 音色复刻 v2.1 + §4.3 可换性)。
 *
 * 为什么:qwen 云复刻保真度低("不像");CosyVoice v3.5 零样本复刻保真更高,是让「小雪」声音更像她
 * 自己的路径(见记忆 cosyvoice-clone-synth-contract / qwen-tts-clone-model §6)。
 *
 * **与 qwen 复刻是完全不同的契约**(别套用 qwen-voice-clone.ts):
 * - 端点同 `POST {endpoint}/api/v1/services/audio/tts/customization`,但 body
 *   `{model:"voice-enrollment", input:{action:"create_voice", target_model, prefix, url, language_hints?}}`;
 * - 音频**只收公网/oss:// URL(不收 base64)**——本地文件先经 {@link uploadToDashScopeTemp} 转 oss:// URL;
 * - 返回 `output.voice_id`(qwen 是 output.voice);
 * - **异步部署**:create 后轮询 `query_voice` 查 status∈{DEPLOYING, OK, UNDEPLOYED};
 * - 管理动词 `list_voice`/`delete_voice` + 字段 `voice_id`(qwen 是裸动词 list/delete + voice)。
 *
 * 一致性纪律:复刻 `target_model` 必须与后续合成的 model **逐字一致**(都是 cosyvoice-v3.5-flash);
 * 装配层(desktop)负责保证两者同串。
 *
 * 真机校准点(隔离在可改函数):getPolicy model 参数、create_voice 是否接受 oss://+解析头、
 * language_hints 合成期是否生效、端点二选一——文档未完全明确,改这里即可。
 *
 * 可测试性(R1 注入接缝):fetch 经注入端口 {@link UploadFetchLike}(同时供上传与 JSON 调用),单测不触网;
 * 轮询间隔可配(测试设 0 即时)。
 */

/** 北京区默认 DashScope HTTP 端点根(海外区 dashscope-intl 可覆盖)。 */
export const COSYVOICE_CLONE_ENDPOINT = 'https://dashscope.aliyuncs.com';
/** 复刻 customization 子路径(与 qwen 同端点)。 */
export const COSYVOICE_CLONE_PATH = '/api/v1/services/audio/tts/customization';
/** 复刻所用顶层 model(固定;CosyVoice 用裸 `voice-enrollment`,非 qwen 的 `qwen-voice-enrollment`)。 */
export const COSYVOICE_ENROLLMENT_MODEL = 'voice-enrollment';
/** 默认 target_model(=合成 model,须逐字一致;可经 opts 覆盖)。CosyVoice v3.5-flash 无日期快照。 */
export const COSYVOICE_DEFAULT_TARGET_MODEL = 'cosyvoice-v3.5-flash';
/** 默认音色前缀(prefix;仅数字字母、≤10 字符)。 */
export const COSYVOICE_DEFAULT_PREFIX = 'xiaoxue';
/** list 默认每页条数(分页 page_size)。 */
export const COSYVOICE_LIST_PAGE_SIZE = 100;
/** 异步部署轮询:默认间隔(毫秒)与最大次数(约 10s × 30 ≈ 5 分钟,与官方示例一致)。 */
export const COSYVOICE_POLL_INTERVAL_MS = 10_000;
export const COSYVOICE_POLL_MAX_ATTEMPTS = 30;
/** prefix 合法性正则(仅数字字母,≤10 字符)。 */
const PREFIX_RE = /^[A-Za-z0-9]{1,10}$/;

/** 音色部署状态(query_voice 的 status 字段)。 */
export type CosyVoiceStatus = 'DEPLOYING' | 'OK' | 'UNDEPLOYED' | 'UNKNOWN';

/** 参考音频:公网/oss:// URL,或本地字节(自动上传),或本地路径(读盘+上传)。 */
export type CosyVoiceCloneAudio =
  | { readonly url: string }
  | { readonly data: Uint8Array; readonly mime?: string; readonly filename?: string }
  | { readonly path: string };

/** 复刻通用选项(鉴权 + 端点 + 注入 fetch)。 */
export interface CosyVoiceCommonOptions {
  /** DASHSCOPE_API_KEY;缺失/空 → fail-fast(**绝不打印**)。 */
  readonly apiKey: string;
  /** HTTP 端点根(默认北京区)。 */
  readonly endpoint?: string;
  /** 注入的 fetch(测试用,同时供上传 + JSON 调用);缺省懒绑 globalThis.fetch。 */
  readonly fetch?: UploadFetchLike;
}

/** 创建音色选项。 */
export interface CreateCosyVoiceOptions extends CosyVoiceCommonOptions {
  /** 目标模型(=合成 model,须逐字一致);默认 cosyvoice-v3.5-flash。 */
  readonly targetModel?: string;
  /** 音色前缀(仅数字字母 ≤10 字符);默认 'xiaoxue'。 */
  readonly prefix?: string;
  /** 样本语种提示(数组,仅取首元素);如 ['zh']。 */
  readonly languageHints?: readonly string[];
  /** 上传 getPolicy 的 model 参数(本地文件时透传给临时上传;真机校准点)。 */
  readonly uploadModel?: string;
  /** 是否在创建后轮询直到 OK(默认 true);设 false 仅创建返回 voiceId(状态自行查)。 */
  readonly waitForDeploy?: boolean;
  /** 轮询间隔毫秒(默认 10s;测试设 0 即时)。 */
  readonly pollIntervalMs?: number;
  /** 最大轮询次数(默认 30)。 */
  readonly maxPollAttempts?: number;
  /** 每次轮询前回调(进度反馈用,如 desktop 显示"部署中 attempt/max")。 */
  readonly onDeployPoll?: (attempt: number, maxAttempts: number) => void;
}

/** 创建结果。 */
export interface CreateCosyVoiceResult {
  readonly voiceId: string;
  /** 轮询后的最终状态(未轮询时为创建直返、视为 DEPLOYING/UNKNOWN)。 */
  readonly status: CosyVoiceStatus;
}

// ───────────────────────────── 纯函数(契约可改;真机校准只改这里) ─────────────────────────────

/** 校验 prefix(仅数字字母、≤10 字符)。非法抛中文错。 */
export function assertCosyPrefix(prefix: string): void {
  if (!PREFIX_RE.test(prefix)) {
    throw new Error(`CosyVoice 复刻 prefix 仅允许数字与英文字母、且不超过 10 字符;收到:"${prefix}"`);
  }
}

/** 构造 create_voice 请求体。`language_hints` 仅取首元素(服务端只认首个)。 */
export function buildCosyCreateBody(
  url: string,
  targetModel: string,
  prefix: string,
  languageHints?: readonly string[],
): Record<string, unknown> {
  const first = languageHints?.[0];
  return {
    model: COSYVOICE_ENROLLMENT_MODEL,
    input: {
      action: 'create_voice',
      target_model: targetModel,
      prefix,
      url,
      ...(first !== undefined && first.length > 0 ? { language_hints: [first] } : {}),
    },
  };
}

/** 构造管理(query_voice/list_voice/delete_voice)请求体。 */
export function buildCosyManageBody(
  action: 'query_voice' | 'list_voice' | 'delete_voice',
  voiceId?: string,
  prefix?: string,
  pageSize: number = COSYVOICE_LIST_PAGE_SIZE,
): Record<string, unknown> {
  return {
    model: COSYVOICE_ENROLLMENT_MODEL,
    input: {
      action,
      ...(voiceId !== undefined ? { voice_id: voiceId } : {}),
      ...(action === 'list_voice'
        ? { page_index: 0, page_size: pageSize, ...(prefix !== undefined ? { prefix } : {}) }
        : {}),
    },
  };
}

/** 从 create/query 响应解析 voice_id。解析不到返回 undefined。 */
export function parseCosyVoiceId(resp: unknown): string | undefined {
  const output = pickOutput(resp);
  if (output === undefined) return undefined;
  const v = output['voice_id'];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** 从 query_voice 响应解析 status(归一到枚举;未知→UNKNOWN)。 */
export function parseCosyStatus(resp: unknown): CosyVoiceStatus {
  const output = pickOutput(resp);
  const raw = output === undefined ? undefined : output['status'];
  const s = typeof raw === 'string' ? raw.toUpperCase() : '';
  if (s === 'OK') return 'OK';
  if (s === 'DEPLOYING') return 'DEPLOYING';
  if (s === 'UNDEPLOYED') return 'UNDEPLOYED';
  return 'UNKNOWN';
}

/** 从 list_voice 响应解析 voice_id 列表(容忍多形态)。 */
export function parseCosyVoiceList(resp: unknown): string[] {
  const output = (resp as { output?: unknown } | null)?.output;
  const arr = pickArray(output);
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === 'string' && item.length > 0) out.push(item);
    else if (item !== null && typeof item === 'object') {
      const o = item as { voice_id?: unknown; voice?: unknown };
      const id =
        (typeof o.voice_id === 'string' && o.voice_id.length > 0 ? o.voice_id : undefined) ??
        (typeof o.voice === 'string' && o.voice.length > 0 ? o.voice : undefined);
      if (id !== undefined) out.push(id);
    }
  }
  return out;
}

function pickOutput(resp: unknown): Record<string, unknown> | undefined {
  if (resp === null || typeof resp !== 'object') return undefined;
  const output = (resp as { output?: unknown }).output;
  if (output === null || typeof output !== 'object') return undefined;
  return output as Record<string, unknown>;
}

function pickArray(output: unknown): unknown[] {
  if (Array.isArray(output)) return output;
  if (output !== null && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    for (const key of ['voice_list', 'voices', 'voiceList', 'list']) {
      if (Array.isArray(o[key])) return o[key] as unknown[];
    }
  }
  return [];
}

// ───────────────────────────── 公开 API ─────────────────────────────

/**
 * 创建专属音色:吃 URL / 本地字节 / 本地路径 → (本地则先临时上传得 oss:// URL) → create_voice →
 * (默认)轮询 query_voice 直到 OK → 返回 { voiceId, status }。
 * 缺 key fail-fast;非 2xx / 解析失败 / 部署失败 / 超时抛清晰中文错(**不含 key**)。
 */
export async function createCosyVoice(
  audio: CosyVoiceCloneAudio,
  opts: CreateCosyVoiceOptions,
  signal?: AbortSignal,
): Promise<CreateCosyVoiceResult> {
  assertApiKey(opts.apiKey);
  const prefix = opts.prefix ?? COSYVOICE_DEFAULT_PREFIX;
  assertCosyPrefix(prefix);
  const targetModel = opts.targetModel ?? COSYVOICE_DEFAULT_TARGET_MODEL;

  // 1) 解析音频为公网/oss:// URL(本地字节/路径 → 临时上传)。
  const url = await resolveAudioUrl(audio, opts, signal);

  // 2) create_voice(oss:// 时附加解析头)。
  const body = buildCosyCreateBody(url, targetModel, prefix, opts.languageHints);
  const json = await postJson(opts, body, ossResolveHeaders(url), signal, '创建音色');
  if (json === undefined) throw new DOMExceptionLike('音色复刻已取消', 'AbortError');
  const voiceId = parseCosyVoiceId(json);
  if (voiceId === undefined) {
    throw new Error(`音色复刻成功但未解析到 voice_id(output.voice_id 缺失);响应片段:${snippet(json)}`);
  }

  // 3) 轮询部署状态(默认开)。
  if (opts.waitForDeploy === false) {
    return { voiceId, status: 'DEPLOYING' };
  }
  const status = await pollUntilDeployed(voiceId, opts, signal);
  return { voiceId, status };
}

/** 查询单个音色部署状态。 */
export async function queryCosyVoice(
  voiceId: string,
  opts: CosyVoiceCommonOptions,
  signal?: AbortSignal,
): Promise<CosyVoiceStatus> {
  assertApiKey(opts.apiKey);
  if (typeof voiceId !== 'string' || voiceId.length === 0) {
    throw new Error('queryCosyVoice 需要非空 voiceId');
  }
  const json = await postJson(opts, buildCosyManageBody('query_voice', voiceId), {}, signal, '查询音色');
  if (json === undefined) return 'UNKNOWN';
  return parseCosyStatus(json);
}

/** 列举已创建音色(可按 prefix 过滤);返回 voice_id 列表。 */
export async function listCosyVoices(
  opts: CosyVoiceCommonOptions & { readonly prefix?: string },
  signal?: AbortSignal,
): Promise<string[]> {
  assertApiKey(opts.apiKey);
  const json = await postJson(
    opts,
    buildCosyManageBody('list_voice', undefined, opts.prefix),
    {},
    signal,
    '列举音色',
  );
  if (json === undefined) return [];
  return parseCosyVoiceList(json);
}

/** 删除指定音色。 */
export async function deleteCosyVoice(
  voiceId: string,
  opts: CosyVoiceCommonOptions,
  signal?: AbortSignal,
): Promise<void> {
  assertApiKey(opts.apiKey);
  if (typeof voiceId !== 'string' || voiceId.length === 0) {
    throw new Error('deleteCosyVoice 需要非空 voiceId');
  }
  await postJson(opts, buildCosyManageBody('delete_voice', voiceId), {}, signal, '删除音色');
}

// ───────────────────────────── 内部工具 ─────────────────────────────

/** 把音频入参解析为 URL:url 直用;data/path → 临时上传得 oss:// URL。 */
async function resolveAudioUrl(
  audio: CosyVoiceCloneAudio,
  opts: CreateCosyVoiceOptions,
  signal?: AbortSignal,
): Promise<string> {
  if ('url' in audio) {
    if (typeof audio.url !== 'string' || audio.url.length === 0) {
      throw new Error('CosyVoice 复刻缺少参考音频 url');
    }
    return audio.url;
  }
  let bytes: Uint8Array;
  let filename: string;
  if ('path' in audio) {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    try {
      bytes = new Uint8Array(fs.readFileSync(audio.path));
    } catch (err) {
      throw new Error(`读取参考音频失败(${audio.path}): ${describeErr(err)}`);
    }
    filename = path.basename(audio.path);
  } else {
    bytes = audio.data;
    filename = audio.filename ?? 'voice-sample.wav';
  }
  const uploadOpts = {
    apiKey: opts.apiKey,
    ...(opts.uploadModel !== undefined ? { model: opts.uploadModel } : {}),
    ...(opts.endpoint !== undefined ? { endpoint: opts.endpoint } : {}),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
  };
  return uploadToDashScopeTemp(bytes, filename, uploadOpts, signal);
}

/** 轮询 query_voice 直到 OK / UNDEPLOYED / 超时。 */
async function pollUntilDeployed(
  voiceId: string,
  opts: CreateCosyVoiceOptions,
  signal?: AbortSignal,
): Promise<CosyVoiceStatus> {
  const intervalMs = opts.pollIntervalMs ?? COSYVOICE_POLL_INTERVAL_MS;
  const maxAttempts = opts.maxPollAttempts ?? COSYVOICE_POLL_MAX_ATTEMPTS;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted === true) throw new DOMExceptionLike('音色复刻轮询已取消', 'AbortError');
    opts.onDeployPoll?.(attempt + 1, maxAttempts);
    const status = await queryCosyVoice(voiceId, opts, signal);
    if (status === 'OK') return 'OK';
    if (status === 'UNDEPLOYED') {
      throw new Error(`音色部署失败(status=UNDEPLOYED);voice_id=${voiceId}`);
    }
    // DEPLOYING / UNKNOWN → 等待后重试(最后一次不再等)。
    if (attempt < maxAttempts - 1) await sleep(intervalMs, signal);
  }
  throw new Error(
    `音色部署超时(轮询 ${maxAttempts} 次仍未就绪);voice_id=${voiceId};可稍后用 queryCosyVoice/listCosyVoices 复核`,
  );
}

/** 可取消 sleep(ms<=0 即时 resolve)。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(new DOMExceptionLike('音色复刻轮询已取消', 'AbortError'));
    };
    const cleanup = (): void => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function assertApiKey(apiKey: string): void {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error(
      'CosyVoice 声音复刻需要 DashScope API key;请设置环境变量 CHAT_A_DASHSCOPE_API_KEY(或在 .env.local 填写)',
    );
  }
}

/**
 * POST JSON 并解析响应。非 2xx / 解析失败抛中文错(不含 key);AbortError 返回 undefined(取消)。
 * `extraHeaders` 用于 oss:// 解析头。
 */
async function postJson(
  opts: CosyVoiceCommonOptions,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string>,
  signal: AbortSignal | undefined,
  what: string,
): Promise<unknown | undefined> {
  if (signal?.aborted === true) return undefined;
  const url = `${(opts.endpoint ?? COSYVOICE_CLONE_ENDPOINT).replace(/\/+$/, '')}${COSYVOICE_CLONE_PATH}`;
  const fetchImpl: UploadFetchLike =
    opts.fetch ?? ((u, init) => (globalThis.fetch as unknown as UploadFetchLike)(u, init));

  let res: Awaited<ReturnType<UploadFetchLike>>;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (isAbortError(err)) return undefined;
    throw new Error(`${what}请求 DashScope 失败: ${describeErr(err)}`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(
      `${what}失败:HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 500)}` : ''}`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${what}失败:响应非合法 JSON;片段:${text.slice(0, 300)}`);
  }
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
