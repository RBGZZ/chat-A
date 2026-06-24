import { describe, it, expect } from 'vitest';
import { makeDataFrame, STT_AUDIO_FORMAT, TTS_AUDIO_FORMAT, type AudioFrame } from '@chat-a/protocol';
import { encodeAudio, decodeAudio, isAudioBinary, toBytes, toText } from '../src/index';

/** 造上行 audio:input 帧(16kHz mono s16le)。 */
function inputFrame(samples: number[], timestampMs: number): AudioFrame {
  return makeDataFrame('audio:input', {
    audio: { samples: Int16Array.from(samples), sampleRate: 16000, channels: 1, timestampMs },
    format: STT_AUDIO_FORMAT,
  });
}

/** 造下行 tts:chunk 帧(24kHz mono s16le)。 */
function ttsFrame(samples: number[], seq: number): AudioFrame {
  return makeDataFrame('tts:chunk', { format: TTS_AUDIO_FORMAT, samples: Int16Array.from(samples), seq });
}

describe('codec:音频帧二进制往返(PCM 等价)', () => {
  it('audio:input 往返:采样率/时间戳/样本一致', () => {
    const f = inputFrame([0, 1, -1, 32767, -32768], 1234.5);
    const buf = encodeAudio(f, 0);
    const dec = decodeAudio(new Uint8Array(buf));
    expect(dec).toBeDefined();
    expect(dec!.frame.type).toBe('audio:input');
    expect(dec!.generation).toBe(0);
    const payload = dec!.frame.type === 'audio:input' ? dec!.frame.payload : undefined;
    expect(payload!.audio.sampleRate).toBe(16000);
    expect(payload!.audio.channels).toBe(1);
    expect(payload!.audio.timestampMs).toBe(1234.5);
    expect([...payload!.audio.samples]).toEqual([0, 1, -1, 32767, -32768]);
  });

  it('tts:chunk 往返:采样率 24k + generation 标签随帧', () => {
    const f = ttsFrame([10, -10, 5], 7);
    const buf = encodeAudio(f, 42);
    const dec = decodeAudio(new Uint8Array(buf));
    expect(dec).toBeDefined();
    expect(dec!.frame.type).toBe('tts:chunk');
    expect(dec!.generation).toBe(42);
    const payload = dec!.frame.type === 'tts:chunk' ? dec!.frame.payload : undefined;
    expect(payload!.format.sampleRate).toBe(24000);
    expect([...payload!.samples]).toEqual([10, -10, 5]);
  });

  it('空样本帧也能往返(0 样本)', () => {
    const f = ttsFrame([], 0);
    const dec = decodeAudio(new Uint8Array(encodeAudio(f, 1)));
    expect(dec).toBeDefined();
    expect(dec!.frame.type === 'tts:chunk' ? [...dec!.frame.payload.samples] : null).toEqual([]);
  });

  it('非本协议二进制(无魔数)→ decode 返回 undefined,不抛', () => {
    expect(isAudioBinary(new Uint8Array([0x00, 0x01]))).toBe(false);
    expect(decodeAudio(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBeUndefined();
  });

  it('带 byteOffset 的 Int16Array 也正确编码(子视图)', () => {
    const big = Int16Array.from([99, 1, 2, 3]);
    const sub = big.subarray(1); // [1,2,3],byteOffset=2
    const f = makeDataFrame('tts:chunk', { format: TTS_AUDIO_FORMAT, samples: sub, seq: 0 });
    const dec = decodeAudio(new Uint8Array(encodeAudio(f, 0)));
    expect(dec!.frame.type === 'tts:chunk' ? [...dec!.frame.payload.samples] : null).toEqual([1, 2, 3]);
  });

  it('toBytes / toText:载荷规整', () => {
    expect(toText('hi')).toBe('hi');
    expect(toText(new Uint8Array([1]))).toBeUndefined();
    expect([...(toBytes(new Uint8Array([1, 2])) ?? [])]).toEqual([1, 2]);
    expect([...(toBytes(new ArrayBuffer(2)) ?? [])]).toEqual([0, 0]);
    expect(toBytes('hi')).toBeUndefined();
  });
});
