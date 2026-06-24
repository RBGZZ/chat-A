/**
 * WAV(RIFF/WAVE)编/解码纯函数 —— 供 {@link WavFileAudioDevice} 用,**仅用 JS,无原生依赖**。
 *
 * 范围:只处理**非压缩 PCM s16le**(`audioFormat=1`、`bitsPerSample=16`)——本项目语音链路恒 Int16,
 * 不引入通用 WAV 解析库(避免范围膨胀 / 新依赖)。编码侧沿用 openai-compat-stt 已验证的 RIFF 写法思路,
 * 但 client 侧**独立实现一份**(不跨包 import provider 私有函数,§3.1 隔离)。
 *
 * 解码会断言关键字段;不符(如非 PCM / 非 16bit)即明确报错(不静默吞),让上层据此提示用户。
 */
import { Buffer } from 'node:buffer';

/** 解码出的 PCM:Int16 样本 + 采样率 + 声道(交错;mono 时即单序列)。 */
export interface DecodedWav {
  readonly samples: Int16Array;
  readonly sampleRate: number;
  readonly channels: number;
}

/**
 * 解码 WAV 字节 → PCM(只支持非压缩 PCM s16le)。
 * 容错地按 chunk 扫描找 `fmt ` 与 `data`(不假定紧邻);字段不符明确报错。
 */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('WAV 解码失败:不是合法的 RIFF/WAVE 文件');
  }

  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | undefined;
  let dataOffset = -1;
  let dataLen = 0;

  // 从 12 起逐 chunk 扫:每个 chunk = 4 字节 id + 4 字节 size + size 字节体(偶对齐)。
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      fmt = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataLen = Math.min(size, bytes.length - body);
    }
    offset = body + size + (size % 2); // chunk 体偶字节对齐
  }

  if (fmt === undefined) throw new Error('WAV 解码失败:缺少 fmt 块');
  if (fmt.audioFormat !== 1) {
    throw new Error(`WAV 解码失败:仅支持非压缩 PCM(audioFormat=1),实际=${fmt.audioFormat}`);
  }
  if (fmt.bitsPerSample !== 16) {
    throw new Error(`WAV 解码失败:仅支持 16-bit PCM,实际 bitsPerSample=${fmt.bitsPerSample}`);
  }
  if (dataOffset < 0) throw new Error('WAV 解码失败:缺少 data 块');

  const sampleCount = dataLen >> 1; // s16le:每样本 2 字节
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = view.getInt16(dataOffset + i * 2, true);
  }
  return { samples, sampleRate: fmt.sampleRate, channels: fmt.channels };
}

/** 编码 Int16 PCM → WAV(RIFF/WAVE,16-bit PCM)字节流。 */
export function encodeWav(samples: Int16Array, sampleRate: number, channels = 1): Uint8Array {
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk 大小
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true); // byte rate
  view.setUint16(32, channels * bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(offset, samples[i] ?? 0, true);
    offset += 2;
  }
  return new Uint8Array(buf);
}

/** 把 Int16Array 编为 Node Buffer 的 WAV(便于落盘)。 */
export function encodeWavBuffer(samples: Int16Array, sampleRate: number, channels = 1): Buffer {
  return Buffer.from(encodeWav(samples, sampleRate, channels));
}

function readAscii(view: DataView, offset: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}
