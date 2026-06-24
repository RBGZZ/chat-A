/**
 * 音频帧二进制编解码(承 design 决策 1 / Risks「二进制 vs base64」):
 * 跨网络承载 {@link AudioFrame}(`audio:input` 上行 / `tts:chunk` 下行),用紧凑头 + Int16 样本载荷,
 * **逐帧带 generation + timestampMs**(§4 跨网络打断 / §4.2 时间对齐硬约定)。
 *
 * 头布局(小端,与 s16le 一致,8 字节 + 样本):
 *   [0]    magic        u8   = 0xA1(chat-a 音频帧魔数,防把控制信令/杂帧误当音频)
 *   [1]    type         u8   = 0(audio:input 上行) | 1(tts:chunk 下行)
 *   [2..3] sampleRateK  u16  采样率/100(16000→160,24000→240;省字节,解码 ×100)
 *   [4..7] generation   i32  代际(下行打断丢弃据此;上行恒 0)
 *   [8..15] timestampMs f64  该帧真实时刻(ms;EOU/打断时间对齐)
 *   [16..] samples      i16[] Int16 PCM(mono,channels 恒 1,见 pcm.ts 硬约定)
 *
 * 注:`tts:chunk` 的 `seq` 不入线协议——跨网络打断用 generation(更强);`seq` 仅进程内回环用。
 * 解码侧据 `seq` 字段补 0(保持 AudioFrame 形状),消费者(VoiceLoop/设备)不依赖跨网 seq。
 */
import {
  STT_AUDIO_FORMAT,
  TTS_AUDIO_FORMAT,
  makeDataFrame,
  type AudioFrame,
  type AudioFormat,
} from '@chat-a/protocol';

const MAGIC = 0xa1;
const TYPE_INPUT = 0;
const TYPE_TTS = 1;
const HEADER_BYTES = 16;

/** 解码出的音频帧 + 其 generation 标签(终端据此比对当前代际,丢弃迟到帧)。 */
export interface DecodedAudio {
  readonly frame: AudioFrame;
  readonly generation: number;
}

/** 取一个 AudioFrame 的 Int16 样本载荷(两种帧类型样本字段不同)。 */
function framesSamples(frame: AudioFrame): Int16Array {
  return frame.type === 'audio:input' ? frame.payload.audio.samples : frame.payload.samples;
}

/** 取一个 AudioFrame 的格式(采样率/声道/编码)。 */
function frameFormat(frame: AudioFrame): AudioFormat {
  return frame.payload.format;
}

/** 取一个 AudioFrame 的真实时刻(ms):input 在 audio.timestampMs;tts:chunk 无显式时刻则取 0。 */
function frameTimestampMs(frame: AudioFrame): number {
  return frame.type === 'audio:input' ? frame.payload.audio.timestampMs : 0;
}

/**
 * 编码 {@link AudioFrame} → 二进制(ArrayBuffer)。`generation` 仅下行(tts:chunk)有意义;
 * 上行(audio:input)恒写 0(终端→大脑不打断)。
 */
export function encodeAudio(frame: AudioFrame, generation = 0): ArrayBuffer {
  const samples = framesSamples(frame);
  const fmt = frameFormat(frame);
  const buf = new ArrayBuffer(HEADER_BYTES + samples.length * 2);
  const view = new DataView(buf);
  view.setUint8(0, MAGIC);
  view.setUint8(1, frame.type === 'audio:input' ? TYPE_INPUT : TYPE_TTS);
  view.setUint16(2, Math.round(fmt.sampleRate / 100), true);
  view.setInt32(4, generation | 0, true);
  view.setFloat64(8, frameTimestampMs(frame), true);
  // 样本:小端 Int16(s16le);逐样本写以兼容任意 byteOffset 的 Int16Array。
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(HEADER_BYTES + i * 2, samples[i] as number, true);
  }
  return buf;
}

/** 是否一段二进制是本协议音频帧(看魔数;防把控制信令/杂帧误解码)。 */
export function isAudioBinary(bytes: Uint8Array): boolean {
  return bytes.length >= HEADER_BYTES && bytes[0] === MAGIC;
}

/**
 * 解码二进制 → {@link DecodedAudio};非本协议/长度不足返回 undefined(优雅降级,不抛)。
 * 还原成与进程内一致的 {@link AudioFrame}(DataFrame,打断丢弃语义),消费者零感知传输。
 */
export function decodeAudio(bytes: Uint8Array): DecodedAudio | undefined {
  if (!isAudioBinary(bytes)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(1);
  const sampleRate = view.getUint16(2, true) * 100;
  const generation = view.getInt32(4, true);
  const timestampMs = view.getFloat64(8, true);
  const sampleCount = (bytes.byteLength - HEADER_BYTES) >> 1;
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = view.getInt16(HEADER_BYTES + i * 2, true);
  }
  if (type === TYPE_INPUT) {
    const format: AudioFormat = { ...STT_AUDIO_FORMAT, sampleRate };
    const frame = makeDataFrame('audio:input', {
      audio: { samples, sampleRate, channels: 1, timestampMs },
      format,
    });
    return { frame, generation };
  }
  const format: AudioFormat = { ...TTS_AUDIO_FORMAT, sampleRate };
  // 跨网 seq 不承载(打断用 generation);补 0 保形,消费者不依赖跨网 seq。
  const frame = makeDataFrame('tts:chunk', { format, samples, seq: 0 });
  return { frame, generation };
}

/** 把任意 message 实参规整为 Uint8Array(吃 Buffer/ArrayBuffer/Uint8Array);非二进制返回 undefined。 */
export function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) return new Uint8Array(data);
  if (Array.isArray(data)) {
    // ws 在 fragmented 二进制下可能给 Buffer[];拼接。
    const parts = data.filter((d): d is Uint8Array => d instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(d)));
    if (parts.length === 0) return undefined;
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return out;
  }
  return undefined;
}

/** 把任意 message 实参规整为文本(吃 string;二进制不视为文本)。 */
export function toText(data: unknown): string | undefined {
  return typeof data === 'string' ? data : undefined;
}
