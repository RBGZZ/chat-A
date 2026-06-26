import { describe, it, expect } from 'vitest';
import type { VoiceTraceEvent } from '@chat-a/protocol';
import { loadVoiceTrace } from '../src/cli-voice';

// 装配层语音可追溯(spec §6/§7/§8):默认零开销;CHAT_A_VOICE_TRACE=1 实时日志;
// CHAT_A_VOICE_TRACE_DB=:memory: 落库 + close 可调不抛。observer/sink 失败均不打断回合(§3.2)。

const sampleEv: VoiceTraceEvent = { kind: 'mic-sample', atMs: 1234, rmsNorm: 0.0001 };

describe('loadVoiceTrace', () => {
  it('默认(空 env)→ undefined(零开销,不注入)', () => {
    expect(loadVoiceTrace({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('CHAT_A_VOICE_TRACE 非真值(如 0/off)→ undefined', () => {
    expect(loadVoiceTrace({ CHAT_A_VOICE_TRACE: '0' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(loadVoiceTrace({ CHAT_A_VOICE_TRACE: 'off' } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('CHAT_A_VOICE_TRACE=1 → 有 observer,注入事件不抛', () => {
    const vt = loadVoiceTrace({ CHAT_A_VOICE_TRACE: '1' } as NodeJS.ProcessEnv);
    expect(vt).toBeDefined();
    expect(vt!.observer).toBeTypeOf('function');
    // 无库 → 无 close。
    expect(vt!.close).toBeUndefined();
    expect(() => vt!.observer!(sampleEv)).not.toThrow();
  });

  it('on/true 同样开启实时日志', () => {
    expect(loadVoiceTrace({ CHAT_A_VOICE_TRACE: 'on' } as NodeJS.ProcessEnv)?.observer).toBeTypeOf(
      'function',
    );
    expect(
      loadVoiceTrace({ CHAT_A_VOICE_TRACE: 'TRUE' } as NodeJS.ProcessEnv)?.observer,
    ).toBeTypeOf('function');
  });

  it('live observer 经 formatVoiceTrace 写 stdout(单行、含 [vtrace] 前缀)', () => {
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    // 拦截 stdout.write 断言实时日志确实落地(cli-voice 经 node:process stdout 写)。
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      writes.push(s);
      return true;
    };
    try {
      const vt = loadVoiceTrace({ CHAT_A_VOICE_TRACE: '1' } as NodeJS.ProcessEnv);
      vt!.observer!(sampleEv);
    } finally {
      (process.stdout as unknown as { write: typeof orig }).write = orig;
    }
    const line = writes.find((w) => w.includes('[vtrace]'));
    expect(line).toBeDefined();
    expect(line).toContain('mic');
    expect(line!.endsWith('\n')).toBe(true);
  });

  it('CHAT_A_VOICE_TRACE_DB=:memory: → observer 存在 + close 可调不抛(落库)', () => {
    const vt = loadVoiceTrace({ CHAT_A_VOICE_TRACE_DB: ':memory:' } as NodeJS.ProcessEnv);
    expect(vt).toBeDefined();
    expect(vt!.observer).toBeTypeOf('function');
    expect(vt!.close).toBeTypeOf('function');
    expect(() => vt!.observer!(sampleEv)).not.toThrow();
    expect(() => vt!.close!()).not.toThrow();
    // 幂等:再次 close 不抛(sink #closed 守卫)。
    expect(() => vt!.close!()).not.toThrow();
  });

  it('CHAT_A_DECISION_TRACE 开 → 复用决策库(此处用 :memory: 避免落盘),含 observer + close', () => {
    const vt = loadVoiceTrace({
      CHAT_A_DECISION_TRACE: '1',
      CHAT_A_DECISION_TRACE_DB: ':memory:',
    } as NodeJS.ProcessEnv);
    expect(vt).toBeDefined();
    expect(vt!.observer).toBeTypeOf('function');
    expect(vt!.close).toBeTypeOf('function');
    expect(() => vt!.observer!(sampleEv)).not.toThrow();
    vt!.close!();
  });

  it('决策 trace 未开 → 不复用其库(仅 DB 名不触发落库)', () => {
    // 只设 CHAT_A_DECISION_TRACE_DB 但未开 CHAT_A_DECISION_TRACE,且非 live → undefined。
    expect(
      loadVoiceTrace({ CHAT_A_DECISION_TRACE_DB: 'chat-a-trace.db' } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });

  it('显式 CHAT_A_VOICE_TRACE_DB 优先于决策库', () => {
    const vt = loadVoiceTrace({
      CHAT_A_VOICE_TRACE_DB: ':memory:',
      CHAT_A_DECISION_TRACE: '1',
      CHAT_A_DECISION_TRACE_DB: 'should-not-be-used.db',
    } as NodeJS.ProcessEnv);
    expect(vt).toBeDefined();
    expect(vt!.close).toBeTypeOf('function');
    vt!.close!();
  });
});
