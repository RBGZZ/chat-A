import { describe, it, expect } from 'vitest';
import {
  makeSystemFrame,
  makeDataFrame,
  makeControlFrame,
  isFrame,
  isFrameType,
  isUninterruptible,
  isBusAction,
  makeBusEvent,
  STT_AUDIO_FORMAT,
  TTS_AUDIO_FORMAT,
  SAMPLES_PER_FRAME,
  SAMPLE_RATE_HZ,
  type Frame,
  type BusEvent,
  type PcmFrame,
} from '../src/index';

// 构造一个真实的 16kHz mono Int16 PCM 帧(10ms=160样本),对接 pcm.ts。
function makePcm(): PcmFrame {
  return {
    samples: new Int16Array(SAMPLES_PER_FRAME),
    sampleRate: SAMPLE_RATE_HZ,
    channels: 1,
    timestampMs: 0,
  };
}

describe('protocol/frames (B 层) — 构造与判别字段', () => {
  it('makeSystemFrame 带 kind=system + type + payload', () => {
    const f = makeSystemFrame('stt:partial', { text: '你' });
    expect(f.kind).toBe('system');
    expect(f.type).toBe('stt:partial');
    expect(f.payload.text).toBe('你');
  });

  it('makeDataFrame/makeControlFrame 判别字段正确;默认可打断(省略 uninterruptible)', () => {
    const d = makeDataFrame('llm:token', { token: '雪' });
    expect(d.kind).toBe('data');
    expect(d.type).toBe('llm:token');
    // exactOptionalPropertyTypes:默认应**省略键**,而非 undefined。
    expect('uninterruptible' in d).toBe(false);

    const c = makeControlFrame('stt:partial', { text: '小' }, true);
    expect(c.kind).toBe('control');
    expect(c.uninterruptible).toBe(true);
  });
});

describe('protocol/frames — 音频帧格式字段完整(真实音频格式,非占位)', () => {
  it('audio:input 带显式 format(16kHz mono s16le)+ Int16 样本载荷', () => {
    const f = makeDataFrame('audio:input', { audio: makePcm(), format: STT_AUDIO_FORMAT });
    expect(f.payload.format.sampleRate).toBe(16_000);
    expect(f.payload.format.channels).toBe(1);
    expect(f.payload.format.sampleFormat).toBe('s16le');
    expect(f.payload.audio.samples).toBeInstanceOf(Int16Array);
    expect(f.payload.audio.samples.length).toBe(160);
  });

  it('tts:chunk 带显式 format(24kHz mono)+ Int16 样本 + 单调 seq', () => {
    const f = makeDataFrame('tts:chunk', {
      format: TTS_AUDIO_FORMAT,
      samples: new Int16Array([1, 2, 3]),
      seq: 7,
    });
    expect(f.payload.format.sampleRate).toBe(24_000);
    expect(f.payload.format.channels).toBe(1);
    expect(f.payload.samples).toBeInstanceOf(Int16Array);
    expect(f.payload.seq).toBe(7);
  });
});

describe('protocol/frames — 打断保活语义', () => {
  it('system 帧恒视为打断也送达;data/control 需显式 uninterruptible', () => {
    expect(isUninterruptible(makeSystemFrame('llm:token', { token: 'a' }))).toBe(true);
    expect(isUninterruptible(makeDataFrame('llm:token', { token: 'a' }))).toBe(false);
    expect(isUninterruptible(makeDataFrame('llm:token', { token: 'a' }, true))).toBe(true);
    expect(isUninterruptible(makeControlFrame('stt:partial', { text: 'x' }, true))).toBe(true);
  });
});

describe('protocol 分层守卫 — 区分 A 层 / B 层(运行期)', () => {
  it('isFrame 认 B 层帧、拒 A 层 BusEvent', () => {
    const frame = makeDataFrame('llm:token', { token: 't' });
    const event = makeBusEvent('stt:final', { text: 'hi' }, 's/t/0');
    expect(isFrame(frame)).toBe(true);
    expect(isFrame(event)).toBe(false); // BusEvent 无 kind 字段
    expect(isFrame(null)).toBe(false);
    expect(isFrame({})).toBe(false);
  });

  it('isFrameType 与 isBusAction 名字空间互斥', () => {
    // B 层帧名:isFrameType 认、isBusAction 拒
    for (const t of ['audio:input', 'tts:chunk', 'stt:partial', 'llm:token']) {
      expect(isFrameType(t)).toBe(true);
      expect(isBusAction(t)).toBe(false);
    }
    // A 层事件名:isBusAction 认、isFrameType 拒
    for (const a of ['stt:final', 'turn:interrupt', 'provider:failover']) {
      expect(isBusAction(a)).toBe(true);
      expect(isFrameType(a)).toBe(false);
    }
  });
});

describe('protocol 编译期分层 — Frame ⊥ BusEvent(类型测试)', () => {
  it('Frame 不能当 BusEvent 用、反之亦然', () => {
    const frame: Frame = makeDataFrame('llm:token', { token: 't' });
    const event: BusEvent = makeBusEvent('stt:final', { text: 'hi' }, 's/t/0');

    // @ts-expect-error Frame 缺 protocol/action/correlationId,不可赋给 BusEvent
    const asEvent: BusEvent = frame;
    // @ts-expect-error BusEvent 缺 kind/type/payload,不可赋给 Frame
    const asFrame: Frame = event;

    // 运行期断言留住变量,避免未使用告警;真正的检查在上面的 @ts-expect-error。
    expect(asEvent).toBeDefined();
    expect(asFrame).toBeDefined();
  });

  it('makeBusEvent 不接受 B 层帧名(action 限定为 A 层)', () => {
    // @ts-expect-error 'tts:chunk' 不是 BusAction,emit 到模块总线在类型层即报错
    const bad = makeBusEvent('tts:chunk', { text: 'x' }, 's/t/0');
    expect(bad).toBeDefined();
  });
});
