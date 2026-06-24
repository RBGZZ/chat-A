import { createRequire } from 'node:module';
import type { FetchLike } from './gpt-sovits-tts';

/**
 * Qwen(阿里 DashScope)千问声音复刻 —— 云端**音色复刻**(承 §4.1 音色复刻/音色自定义 v2.1)。
 *
 * 为什么:「小雪」做**长期伴侣**,专属声音是陪伴感的关键。本模块把"用户给一段 ~15s 干净录音
 * → 云端创建专属音色 → 拿 voice id → 实时合成直接用"这条**零复杂操作**链路打通:复用现有
 * CHAT_A_DASHSCOPE_API_KEY,无本地依赖(契合瘦终端 + 云端大脑)。复刻是**离线一次性**操作,
 * 不在首字延迟热路径上(§3.2 延迟预算无影响)。
 *
 * API(调研结论,**以官方当时版本为准**;详见 openspec/changes/qwen-voice-cloning/design.md):
 * - 端点 `POST {endpoint}/api/v1/services/audio/tts/customization`(北京区 dashscope;海外区 dashscope-intl);
 *   鉴权请求头 `Authorization: Bearer <key>`(**绝不打印 key**)、`Content-Type: application/json`。
 * - 创建:body `{ model:'qwen-voice-enrollment', input:{ action:'create', target_model, preferred_name?,
 *   audio:{ data:'data:audio/<mime>;base64,...' } } }`;返回 voice id 在 `output.voice`。
 *   参考音频走 **base64 data URI 内联**(本地文件零操作;也可放公网 URL,本期不用)。
 * - 管理(list/query/delete):同端点、同 model,`input.action` 取 'list'/'query'/'delete',
 *   delete/query 带 `input.voice`。⚠️ **list/delete 的 action 动词与 list 响应字段名官方未完整公开**,
 *   按 CosyVoice 同族 voice-enrollment 推断;真机不符——**改下面对应的可改函数一处即可**(§3.1 爆炸半径可控)。
 * - 音频要求:WAV(16bit)/MP3/M4A;时长 10~20s(≤60s);大小 < 10MB;采样率 ≥ 24kHz;单声道;
 *   ≥3s 连续清晰朗读、无背景音。配额:¥0.01/个、上限 1000、1 年未用自动删(以官方当时计费为准)。
 *
 * 可测试性(R1 注入接缝,镜像 GptSoVitsTts):fetch 经**注入端口** {@link FetchLike}(缺省 globalThis.fetch),
 * 单测注入 mock fetch、**全程不触网**。
 */

/** 北京区默认 DashScope HTTP 端点根(海外区 dashscope-intl 可覆盖)。 */
export const QWEN_VOICE_CLONE_ENDPOINT = 'https://dashscope.aliyuncs.com';
/** 复刻 customization 子路径。 */
export const QWEN_VOICE_CLONE_PATH = '/api/v1/services/audio/tts/customization';
/** 复刻所用顶层 model(固定;非合成 model)。 */
export const QWEN_VOICE_ENROLLMENT_MODEL = 'qwen-voice-enrollment';
/** 默认 target_model(实时复刻;**别写死日期快照**——可经 opts 覆盖)。 */
export const QWEN_VOICE_CLONE_DEFAULT_TARGET_MODEL = 'qwen3-tts-vc-realtime';
/** 参考音频原始字节上限(DashScope 文档:< 10MB)。 */
export const QWEN_VOICE_CLONE_MAX_BYTES = 10 * 1024 * 1024;
/** 创建音色时默认前缀名(preferred_name;仅命名用,可经 opts 覆盖)。 */
export const QWEN_VOICE_CLONE_DEFAULT_NAME = 'xiaoxue';

/** 参考音频:字节 + MIME(浏览器/主进程通用),或本地文件路径(仅 Node 侧,自动读盘)。 */
export type VoiceCloneAudio =
  | { readonly data: Uint8Array; readonly mime: string }
  | { readonly path: string };

/** 复刻通用选项(鉴权 + 端点 + 注入 fetch)。 */
export interface VoiceCloneCommonOptions {
  /** DASHSCOPE_API_KEY;缺失/空 → fail-fast(**绝不打印**)。 */
  readonly apiKey: string;
  /** HTTP 端点根(默认北京区;海外区 dashscope-intl 可覆盖)。 */
  readonly endpoint?: string;
  /** 注入的 fetch(测试用);缺省懒绑 globalThis.fetch。 */
  readonly fetch?: FetchLike;
}

/** 创建音色选项。 */
export interface CreateVoiceOptions extends VoiceCloneCommonOptions {
  /** 目标模型(创建时的 target_model **必须与合成时模型一致**);默认 qwen3-tts-vc-realtime。 */
  readonly targetModel?: string;
  /** 音色显示名前缀(preferred_name);默认 'xiaoxue'。 */
  readonly preferredName?: string;
}

/** 创建结果:复刻得到的 voice id。 */
export interface CreateVoiceResult {
  readonly voiceId: string;
}

// ───────────────────────────── 纯函数(契约可改;真机校准只改这里) ─────────────────────────────

/** 按文件扩展名推断 MIME(覆盖 DashScope 接受的 WAV/MP3/M4A;未知回落 octet-stream)。 */
export function mimeFromPath(path: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(path);
  const ext = (m?.[1] ?? '').toLowerCase();
  switch (ext) {
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
      return 'audio/mp4';
    case 'aac':
      return 'audio/aac';
    case 'ogg':
      return 'audio/ogg';
    case 'flac':
      return 'audio/flac';
    default:
      return 'application/octet-stream';
  }
}

/** 字节 + MIME → base64 data URI(`data:<mime>;base64,...`)。 */
export function audioToDataUri(data: Uint8Array, mime: string): string {
  const b64 =
    typeof Buffer !== 'undefined'
      ? Buffer.from(data).toString('base64')
      : btoaFallback(data);
  return `data:${mime};base64,${b64}`;
}

/** 构造创建音色请求体(契约可改函数:真机不符改此处)。 */
export function buildCreateBody(
  dataUri: string,
  targetModel: string,
  preferredName: string,
): Record<string, unknown> {
  return {
    model: QWEN_VOICE_ENROLLMENT_MODEL,
    input: {
      action: 'create',
      target_model: targetModel,
      preferred_name: preferredName,
      audio: { data: dataUri },
    },
  };
}

/**
 * 构造管理(list/query/delete)请求体(契约可改函数;**action 动词官方未完整公开,真机校准改此处**)。
 * delete/query 带 voiceId;list 不带。
 */
export function buildManageBody(
  action: 'list' | 'query' | 'delete',
  voiceId?: string,
): Record<string, unknown> {
  return {
    model: QWEN_VOICE_ENROLLMENT_MODEL,
    input: {
      action,
      ...(voiceId !== undefined ? { voice: voiceId } : {}),
    },
  };
}

/** 从创建/查询响应解析 voice id(契约可改函数:字段名真机校准改此处)。解析不到返回 undefined。 */
export function parseVoiceId(resp: unknown): string | undefined {
  if (resp === null || typeof resp !== 'object') return undefined;
  const output = (resp as { output?: unknown }).output;
  if (output === null || typeof output !== 'object') return undefined;
  const voice = (output as { voice?: unknown }).voice;
  return typeof voice === 'string' && voice.length > 0 ? voice : undefined;
}

/**
 * 从 list 响应解析 voice id 列表(契约可改函数:**响应数组字段名官方未公开,真机校准改此处**)。
 * 容忍多种可能形态:output.voices / output.voice_list / output 直接是数组;元素为字符串或带 voice 字段的对象。
 */
export function parseVoiceList(resp: unknown): string[] {
  if (resp === null || typeof resp !== 'object') return [];
  const output = (resp as { output?: unknown }).output;
  const arr = pickArray(output);
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === 'string' && item.length > 0) out.push(item);
    else if (item !== null && typeof item === 'object') {
      const v = (item as { voice?: unknown }).voice;
      if (typeof v === 'string' && v.length > 0) out.push(v);
    }
  }
  return out;
}

function pickArray(output: unknown): unknown[] {
  if (Array.isArray(output)) return output;
  if (output !== null && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    for (const key of ['voices', 'voice_list', 'voiceList', 'list']) {
      if (Array.isArray(o[key])) return o[key] as unknown[];
    }
  }
  return [];
}

// ───────────────────────────── 公开 API ─────────────────────────────

/**
 * 创建专属音色:吃本地音频(字节+MIME 或路径)→ 提交 DashScope 复刻端点 → 返回 { voiceId }。
 * 缺 key fail-fast;音频超 10MB 在发请求前拒绝;非 2xx / 解析失败抛清晰中文错(**不含 key**)。
 */
export async function createVoice(
  audio: VoiceCloneAudio,
  opts: CreateVoiceOptions,
  signal?: AbortSignal,
): Promise<CreateVoiceResult> {
  assertApiKey(opts.apiKey);
  const { data, mime } = await resolveAudio(audio);
  if (data.length > QWEN_VOICE_CLONE_MAX_BYTES) {
    throw new Error(
      `参考音频过大(${(data.length / 1024 / 1024).toFixed(1)}MB,上限 10MB);请压缩或截取更短片段(推荐 10~20 秒)`,
    );
  }
  const dataUri = audioToDataUri(data, mime);
  const targetModel = opts.targetModel ?? QWEN_VOICE_CLONE_DEFAULT_TARGET_MODEL;
  const preferredName = opts.preferredName ?? QWEN_VOICE_CLONE_DEFAULT_NAME;
  const body = buildCreateBody(dataUri, targetModel, preferredName);

  const json = await postJson(opts, body, signal, '创建音色');
  if (json === undefined) {
    // AbortSignal 取消:静默返回(由调用方据 signal 判断);抛 AbortError 风格更一致。
    throw new DOMExceptionLike('音色复刻已取消', 'AbortError');
  }
  const voiceId = parseVoiceId(json);
  if (voiceId === undefined) {
    throw new Error(
      `音色复刻成功但未解析到 voice id(output.voice 缺失);响应片段:${snippet(json)}`,
    );
  }
  return { voiceId };
}

/** 列举已创建音色(管理/校验存活用)。返回 voice id 列表。 */
export async function listVoices(
  opts: VoiceCloneCommonOptions,
  signal?: AbortSignal,
): Promise<string[]> {
  assertApiKey(opts.apiKey);
  const json = await postJson(opts, buildManageBody('list'), signal, '列举音色');
  if (json === undefined) return [];
  return parseVoiceList(json);
}

/** 删除指定音色。成功 resolve(void);失败抛中文错。 */
export async function deleteVoice(
  voiceId: string,
  opts: VoiceCloneCommonOptions,
  signal?: AbortSignal,
): Promise<void> {
  assertApiKey(opts.apiKey);
  if (typeof voiceId !== 'string' || voiceId.length === 0) {
    throw new Error('deleteVoice 需要非空 voiceId');
  }
  await postJson(opts, buildManageBody('delete', voiceId), signal, '删除音色');
}

// ───────────────────────────── 内部工具 ─────────────────────────────

function assertApiKey(apiKey: string): void {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error(
      '声音复刻需要 DashScope API key;请设置环境变量 CHAT_A_DASHSCOPE_API_KEY(或在 .env.local 填写)',
    );
  }
}

/** 解析音频入参为 { data, mime }:path 形态在 Node 侧读盘并按扩展名推 MIME。 */
async function resolveAudio(audio: VoiceCloneAudio): Promise<{ data: Uint8Array; mime: string }> {
  if ('data' in audio) {
    return { data: audio.data, mime: audio.mime };
  }
  // path 形态:仅 Node 侧;懒加载 fs 避免污染浏览器/测试链路。
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  let buf: Buffer;
  try {
    buf = fs.readFileSync(audio.path);
  } catch (err) {
    throw new Error(`读取参考音频失败(${audio.path}): ${describeErr(err)}`);
  }
  return { data: new Uint8Array(buf), mime: mimeFromPath(audio.path) };
}

/**
 * POST JSON 并解析响应。非 2xx / 解析失败抛中文错(不含 key);AbortError 返回 undefined(取消)。
 * `what` 用于错误前缀(如 "创建音色")。
 */
async function postJson(
  opts: VoiceCloneCommonOptions,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  what: string,
): Promise<unknown | undefined> {
  if (signal?.aborted === true) return undefined;
  const url = `${(opts.endpoint ?? QWEN_VOICE_CLONE_ENDPOINT).replace(/\/+$/, '')}${QWEN_VOICE_CLONE_PATH}`;
  const fetchImpl: FetchLike =
    opts.fetch ?? ((u, init) => (globalThis.fetch as unknown as FetchLike)(u, init));

  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (isAbortError(err)) return undefined;
    // 注意:describeErr 只取 message,绝不序列化含鉴权头的 init。
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

function btoaFallback(data: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i] as number);
  return btoa(bin);
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
    err !== null &&
    typeof err === 'object' &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

/** 轻量 AbortError(避免依赖 DOM lib 的 DOMException 类型)。 */
class DOMExceptionLike extends Error {
  constructor(message: string, name: string) {
    super(message);
    this.name = name;
  }
}
