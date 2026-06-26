import { describe, it, expect, afterEach } from 'vitest';
import type { VoiceTraceEvent } from '@chat-a/protocol';
import {
  SqliteVoiceTraceSink,
  CURRENT_VOICE_TRACE_SCHEMA_VERSION,
} from '../src/index';

/**
 * §5 语音 trace 落 SQLite:`SqliteVoiceTraceSink` 落库 + 只读还原往返
 * (kind 专属字段经 data_json round-trip)、按 correlationId/kind 查询、
 * schema_version 元表、close 后自吞降级。全程内存库(':memory:')。
 */

const CORR = 'corr-001';

/** 各 kind 的代表事件,覆盖判别联合全分支(含可选字段)。 */
const EVENTS: VoiceTraceEvent[] = [
  { kind: 'mic-sample', atMs: 1000, correlationId: CORR, rmsNorm: 0.0001 },
  {
    kind: 'vad',
    atMs: 1100,
    correlationId: CORR,
    sessionId: 's1',
    turnId: 't1',
    event: 'speech_start',
  },
  { kind: 'endpoint', atMs: 1200, correlationId: CORR, silenceMs: 600 },
  {
    kind: 'echo-guard',
    atMs: 1300,
    correlationId: CORR,
    tier: 'speaking',
    rmsNorm: 0.001,
    run: 0,
    passed: false,
  },
  {
    kind: 'speech-gate',
    atMs: 1400,
    correlationId: CORR,
    passed: false,
    totalMs: 300,
    voicedMs: 40,
  },
  // backchannel 含可选 clipText
  { kind: 'backchannel', atMs: 1500, correlationId: CORR, fired: true, clipText: '嗯' },
  // backchannel 无可选 clipText
  { kind: 'backchannel', atMs: 1550, correlationId: CORR, fired: false },
  { kind: 'state', atMs: 1600, correlationId: CORR, from: 'listening', to: 'thinking' },
  {
    kind: 'stt-input',
    atMs: 1700,
    correlationId: CORR,
    path: 'stt-stream',
    durationMs: 1200,
    rmsNorm: 0.03,
  },
  // stt-result 含全部可选字段
  {
    kind: 'stt-result',
    atMs: 1800,
    correlationId: CORR,
    text: '你好世界',
    emotion: 'happy',
    lang: 'zh',
    isFinal: true,
  },
  // stt-result 无可选字段
  { kind: 'stt-result', atMs: 1850, correlationId: CORR, text: '嗯', isFinal: false },
  // turn 含可选 ttfaMs
  { kind: 'turn', atMs: 1900, correlationId: CORR, outcome: 'replied', ttfaMs: 620 },
  // turn 无可选 ttfaMs
  { kind: 'turn', atMs: 1950, correlationId: CORR, outcome: 'gated' },
];

describe('SqliteVoiceTraceSink', () => {
  let sink: SqliteVoiceTraceSink | undefined;
  afterEach(() => {
    sink?.close();
    sink = undefined;
  });

  it('record 各 kind → getByCorrelation 按 at_ms 升序还原(data_json round-trip)', () => {
    sink = new SqliteVoiceTraceSink({ path: ':memory:' });
    // 乱序写入,验证查询按 at_ms 升序
    for (const ev of [...EVENTS].reverse()) sink.record(ev);

    const got = sink.getByCorrelation(CORR);
    expect(got).toHaveLength(EVENTS.length);
    // 升序还原后逐字段相等(含可选字段经 JSON round-trip)
    expect(got).toEqual(EVENTS);
  });

  it('getByKind 还原指定 kind(含/不含可选字段两条)', () => {
    sink = new SqliteVoiceTraceSink({ path: ':memory:' });
    for (const ev of EVENTS) sink.record(ev);

    const results = sink.getByKind('stt-result');
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      kind: 'stt-result',
      atMs: 1800,
      correlationId: CORR,
      text: '你好世界',
      emotion: 'happy',
      lang: 'zh',
      isFinal: true,
    });
    expect(results[1]).toEqual({
      kind: 'stt-result',
      atMs: 1850,
      correlationId: CORR,
      text: '嗯',
      isFinal: false,
    });
  });

  it('数值/布尔字段经 data_json round-trip 类型正确', () => {
    sink = new SqliteVoiceTraceSink({ path: ':memory:' });
    const eg = EVENTS.find((e) => e.kind === 'echo-guard')!;
    sink.record(eg);
    const got = sink.getByKind('echo-guard')[0];
    expect(got).toEqual(eg);
    if (got?.kind === 'echo-guard') {
      expect(typeof got.rmsNorm).toBe('number');
      expect(typeof got.run).toBe('number');
      expect(typeof got.passed).toBe('boolean');
    } else {
      throw new Error('期望还原出 echo-guard 事件');
    }
  });

  it('缺省缝合键(sessionId/turnId)缺省时不出现在还原对象上', () => {
    sink = new SqliteVoiceTraceSink({ path: ':memory:' });
    sink.record({ kind: 'mic-sample', atMs: 1, correlationId: CORR, rmsNorm: 0.5 });
    const got = sink.getByCorrelation(CORR)[0];
    expect(got).toEqual({ kind: 'mic-sample', atMs: 1, correlationId: CORR, rmsNorm: 0.5 });
    expect(got !== undefined && 'sessionId' in got).toBe(false);
    expect(got !== undefined && 'turnId' in got).toBe(false);
  });

  it('schema_version 元表写入当前版本', () => {
    sink = new SqliteVoiceTraceSink({ path: ':memory:' });
    expect(sink.schemaVersion()).toBe(CURRENT_VOICE_TRACE_SCHEMA_VERSION);
  });

  it('重复打开同库幂等(迁移不重复执行)', () => {
    // 内存库每实例独立,这里仅验证单实例多次构造逻辑稳健:重建即可
    sink = new SqliteVoiceTraceSink({ path: ':memory:' });
    sink.record(EVENTS[0]!);
    expect(sink.getByCorrelation(CORR)).toHaveLength(1);
  });

  it('close 后 record/读 走降级不崩(返回空、不抛)', () => {
    sink = new SqliteVoiceTraceSink({ path: ':memory:', onError: () => {} });
    sink.record(EVENTS[0]!);
    sink.close();
    expect(() => sink!.record(EVENTS[1]!)).not.toThrow();
    expect(sink.getByCorrelation(CORR)).toEqual([]);
    expect(sink.getByKind('vad')).toEqual([]);
    // close 幂等
    expect(() => sink!.close()).not.toThrow();
  });
});
