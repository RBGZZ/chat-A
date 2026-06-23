/**
 * B 层"帧"契约(承 §4.2 / §4.2.1):**高频流式、细粒度**——音频帧、`stt:partial`、
 * `llm:token`、`tts:chunk` 等。它们活在 `runtime` 帧管线内,**不上模块总线**(高频 +
 * deepFreeze 成本 + 破坏分层:cognition/providers 只见 A 层 BusEvent,不见帧内部)。
 *
 * 类型定义放在 `protocol` 是为了 **编译期分层**(§4.2.1 关键):Frame 与 BusEvent 是
 * 两套独立判别联合 + 各自的判别字段(`kind`/`type` vs `protocol`/`action`),让
 * "把 `tts:chunk` 误 emit 到模块总线" 在**类型层**就报错,而非运行时。
 *
 * 四态调度语义(承 §4.2 / §4.2.2):
 *   - SystemFrame        —— 插队、立即处理、**不受打断**(System 优先,双队列双任务的快道)。
 *   - DataFrame          —— 排队、**打断时丢弃**(高频载荷:音频/token/转写)。
 *   - ControlFrame       —— 排队、**打断时丢弃**(控制信令:开始/结束/刷新)。
 *   - UninterruptibleFrame mixin —— 给 Data/Control 打"打断也送达"标记(如结束信令、函数结果)。
 *
 * 模式与 A 层 `bus-events` 对齐:接口映射 → 派生判别联合,`kind`/`type` 与 `payload` 强关联。
 */
import {
  SAMPLE_RATE_HZ,
  CHANNELS,
  type PcmFrame,
} from './pcm';

/**
 * 音频采样格式(承用户强约束:音频帧务必基于真实音频格式,不得凭空设计)。
 * 取真实参考项目最常见编码:
 *   - `s16le` —— 16-bit signed PCM little-endian,STT 输入业界默认
 *     (voice-core ears/stt.py:80 `sample_rate=16000`;
 *      Open-LLM-VTuber asr/asr_interface.py:7 `SAMPLE_RATE=16000` +
 *      asr_interface.py:51 `(audio*32767).astype(np.int16)`;pipecat moonshine/stt.py:38)。
 *   - `f32le` —— 32-bit float PCM little-endian,Kokoro 等 TTS 模型原生输出
 *     (projectBEA kokoro_tts_wrapper.py:85-88 `np.float32`;voice-core voice/tts.py:33)。
 * 仅列实际用到的两种;新增编码须同步参考佐证,杜绝凭空占位。
 */
export type SampleFormat = 's16le' | 'f32le';

/**
 * 音频帧格式描述符(**显式格式字段**,绝不抽象占位):采样率 + 声道 + 样本编码。
 * 对接 `pcm.ts`:默认即 16kHz / mono / s16le(STT 输入硬约定,§4.2 10ms=160样本=320字节)。
 * TTS 输出常见 24kHz mono(Kokoro:voice-core voice/tts.py:33、projectBEA
 * kokoro_tts_wrapper.py:71、RealtimeVoiceChat audio_module.py:269 `SR,BPS=24000,2`),
 * 故 `sampleRate` 不写死、随生产/消费侧而定。
 */
export interface AudioFormat {
  /** 采样率(Hz):STT 典型 16000;TTS(Kokoro)典型 24000。 */
  readonly sampleRate: number;
  /** 声道数:语音链路恒 mono(=1),参考项目 STT/TTS 普遍单声道。 */
  readonly channels: number;
  /** 样本编码:STT 输入 s16le;TTS 模型原生输出多为 f32le。 */
  readonly sampleFormat: SampleFormat;
}

/** STT 输入默认格式:16kHz mono s16le(对齐 pcm.ts 硬约定)。 */
export const STT_AUDIO_FORMAT: AudioFormat = {
  sampleRate: SAMPLE_RATE_HZ, // 16000
  channels: CHANNELS, // 1
  sampleFormat: 's16le',
};

/** TTS 输出常见格式:24kHz mono(Kokoro 原生);此处取 s16le(链路落地多转 Int16 播放)。 */
export const TTS_AUDIO_FORMAT: AudioFormat = {
  sampleRate: 24_000,
  channels: CHANNELS, // 1
  sampleFormat: 's16le',
};

// ───────────────────────────── 调度态(四态)─────────────────────────────

/**
 * 帧调度态(承 §4.2 双队列双任务 + 打断语义):
 *   - `system`  —— 不排队、不受打断(快道)。
 *   - `data`    —— 排队、打断丢弃(高频载荷)。
 *   - `control` —— 排队、打断丢弃(控制信令)。
 * `UninterruptibleFrame` 是叠加在 data/control 上的 **mixin 标记**,不是独立调度态。
 */
export type FrameDisposition = 'system' | 'data' | 'control';

/**
 * 打断也送达 mixin(承 §4.2 `UninterruptibleFrame`):给 data/control 帧打标记,
 * 使其在 `turn:interrupt` 队列 reset 时**不被丢弃**(如结束信令、函数结果)。
 * exactOptionalPropertyTypes 下**省略键 = 可打断**,置 true = 不可打断;绝不显式赋 undefined。
 */
export interface Uninterruptible {
  /** 置 `true` 表示打断也送达;省略键即默认可被打断丢弃。 */
  readonly uninterruptible?: true;
}

// ───────────────────────────── B 层帧 payload 映射 ─────────────────────────────

/**
 * 高频帧载荷映射:`type` → payload。与 A 层 `BusEventMap` 同构(接口映射派生判别联合),
 * 但**键名空间刻意与总线区隔**(`audio:*` / `stt:partial` / `llm:token` / `tts:chunk`),
 * 这些名字 `isBusAction` 一律返回 false(见 bus-events 测试),编译期+运行期双重防串层。
 */
export interface FramePayloadMap {
  /** 入站音频帧(终端→大脑,STT 前):带**显式格式** + Int16 样本载荷(对接 pcm.ts)。 */
  'audio:input': { readonly audio: PcmFrame; readonly format: AudioFormat };
  /** 出站音频块(TTS→终端):同样**带格式**;`seq` 配 wall-clock 配速 + 打断丢弃。 */
  'tts:chunk': {
    readonly format: AudioFormat;
    /** 音频样本载荷(Int16,对应 s16le);跨网络承载即字节序列。 */
    readonly samples: Int16Array;
    /** 块序号(单调递增):终端据此丢弃迟到块,对齐 generation 打断(§4)。 */
    readonly seq: number;
  };
  /** STT 临时转写(会被后续 partial/final 覆盖,典型高频)。 */
  'stt:partial': { readonly text: string };
  /** LLM 流式 token(逐 token 高频)。 */
  'llm:token': { readonly token: string };
}

export type FrameType = keyof FramePayloadMap;

// ───────────────────────────── 三态帧 + 判别联合 ─────────────────────────────

/**
 * B 层帧基座:判别字段 `kind`(调度态)+ `type`(载荷类型)+ `payload`。
 * **刻意不带** A 层 Envelope 的 `protocol`/`action`/`correlationId`/`code` 字段——
 * 这是编译期分层的物理基础:Frame 形状与 BusEvent 不交集,互相不可赋值(§4.2.1)。
 */
interface FrameBase<K extends FrameDisposition, T extends FrameType> {
  readonly kind: K;
  readonly type: T;
  readonly payload: FramePayloadMap[T];
}

/** SystemFrame:插队、立即处理、不受打断(快道;无 Uninterruptible mixin,本就不被丢)。 */
export type SystemFrame = {
  [T in FrameType]: FrameBase<'system', T>;
}[FrameType];

/** DataFrame:排队、打断丢弃(可叠 Uninterruptible 标记保活)。高频载荷主力。 */
export type DataFrame = {
  [T in FrameType]: FrameBase<'data', T> & Uninterruptible;
}[FrameType];

/** ControlFrame:排队、打断丢弃(可叠 Uninterruptible 标记保活)。控制信令。 */
export type ControlFrame = {
  [T in FrameType]: FrameBase<'control', T> & Uninterruptible;
}[FrameType];

/** B 层帧全集判别联合(高频流式;**不上总线**)。 */
export type Frame = SystemFrame | DataFrame | ControlFrame;

// ───────────────────────────── 工厂(对应 makeBusEvent)─────────────────────────────

/** 造 SystemFrame(快道:不受打断,故无 Uninterruptible 入参)。 */
export function makeSystemFrame<T extends FrameType>(
  type: T,
  payload: FramePayloadMap[T],
): FrameBase<'system', T> {
  return { kind: 'system', type, payload };
}

/**
 * 造 DataFrame;`uninterruptible` 省略 = 可打断丢弃,传 true = 打断也送达。
 * exactOptionalPropertyTypes 安全:用条件展开,绝不写 `uninterruptible: undefined`。
 */
export function makeDataFrame<T extends FrameType>(
  type: T,
  payload: FramePayloadMap[T],
  uninterruptible?: true,
): FrameBase<'data', T> & Uninterruptible {
  return uninterruptible === undefined
    ? { kind: 'data', type, payload }
    : { kind: 'data', type, payload, uninterruptible };
}

/** 造 ControlFrame;`uninterruptible` 语义同上(条件展开,exactOptional 安全)。 */
export function makeControlFrame<T extends FrameType>(
  type: T,
  payload: FramePayloadMap[T],
  uninterruptible?: true,
): FrameBase<'control', T> & Uninterruptible {
  return uninterruptible === undefined
    ? { kind: 'control', type, payload }
    : { kind: 'control', type, payload, uninterruptible };
}

// ───────────────────────────── 类型守卫(编译期分层的运行期对偶)─────────────────────────────

/**
 * 单一真相源:`Record<FrameType, true>` 强制"每个帧类型都登记"——
 * 给 FramePayloadMap 加帧却漏登记 → 编译报错(枚举完整性,对齐 bus-events 的 ACTION_PRESENCE)。
 */
const FRAME_TYPE_PRESENCE: Record<FrameType, true> = {
  'audio:input': true,
  'tts:chunk': true,
  'stt:partial': true,
  'llm:token': true,
};

const FRAME_TYPES: ReadonlySet<string> = new Set<string>(Object.keys(FRAME_TYPE_PRESENCE));

/** 守卫:`x` 是否 B 层帧类型名(与 `isBusAction` 互斥——A/B 名字空间不交集)。 */
export function isFrameType(x: string): x is FrameType {
  return FRAME_TYPES.has(x);
}

/**
 * 守卫:运行期判定一个对象是否 B 层 Frame(看判别字段 `kind`+`type`,而非 A 层的 `action`)。
 * 用于"误把 BusEvent 当 Frame 投喂帧管线"时的运行期兜底(类型层已先挡住,§4.2.1)。
 */
export function isFrame(x: unknown): x is Frame {
  if (x === null || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    (o['kind'] === 'system' || o['kind'] === 'data' || o['kind'] === 'control') &&
    typeof o['type'] === 'string' &&
    isFrameType(o['type']) &&
    'payload' in o
  );
}

/** 守卫:是否"打断也送达"帧(uninterruptible 标记;system 帧本就不被丢,亦视为保活)。 */
export function isUninterruptible(frame: Frame): boolean {
  return frame.kind === 'system' || frame.uninterruptible === true;
}
