import { describe, it, expect } from 'vitest';
import {
  makeBusEvent,
  isBusAction,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  SAMPLES_PER_FRAME,
  BYTES_PER_FRAME,
  bytesForMs,
  correlationKey,
  ok,
  err,
  type Correlation,
  type SessionId,
  type TurnId,
  type Generation,
} from '../src/index';

describe('protocol/pcm', () => {
  it('16k mono 10ms 帧 = 160 样本 / 320 字节', () => {
    expect(SAMPLES_PER_FRAME).toBe(160);
    expect(BYTES_PER_FRAME).toBe(320);
    expect(bytesForMs(10)).toBe(320);
    expect(bytesForMs(40)).toBe(1280);
  });
});

describe('protocol/bus-events (A 层)', () => {
  it('makeBusEvent 盖上 protocol/version/action 并携带 correlationId', () => {
    const ev = makeBusEvent('stt:final', { text: 'hi' }, 's1/t1/0');
    expect(ev.protocol).toBe(PROTOCOL_NAME);
    expect(ev.version).toBe(PROTOCOL_VERSION);
    expect(ev.action).toBe('stt:final');
    expect(ev.data.text).toBe('hi');
    expect(ev.correlationId).toBe('s1/t1/0');
    expect(ev.code).toBe(0);
  });

  it('isBusAction 守卫 A 层事件名,拒绝 B 层帧名', () => {
    expect(isBusAction('turn:interrupt')).toBe(true);
    expect(isBusAction('stt:final')).toBe(true);
    // B 层帧(audio:chunk / llm:token / tts:chunk / stt:partial)不在总线
    expect(isBusAction('audio:chunk')).toBe(false);
    expect(isBusAction('llm:token')).toBe(false);
    expect(isBusAction('nope')).toBe(false);
  });
});

describe('protocol/ids', () => {
  it('correlationKey 串联 session/turn/generation', () => {
    const c: Correlation = {
      sessionId: 's1' as SessionId,
      turnId: 't1' as TurnId,
      generation: 3 as Generation,
    };
    expect(correlationKey(c)).toBe('s1/t1/3');
  });
});

describe('protocol/errors', () => {
  it('Result ok/err 带 fault 归因', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
    const e = err('tool', 'boom');
    expect(e.ok).toBe(false);
    if (!e.ok) {
      expect(e.fault).toBe('tool');
      expect(e.message).toBe('boom');
    }
  });
});
