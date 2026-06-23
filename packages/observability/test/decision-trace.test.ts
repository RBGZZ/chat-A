import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SqliteDecisionTraceSink,
  NoopDecisionTraceSink,
  createDecisionTraceSinkFromEnv,
  CURRENT_TRACE_SCHEMA_VERSION,
  type DecisionTrace,
} from '../src/index';

const TRACE: DecisionTrace = {
  correlationId: 's1/t1/0',
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  sessionId: 's1',
  turnId: 't1',
  createdAtMs: 1000,
  latencyMs: 42,
  userText: '速溶咖啡更好',
  recalled: [{ text: '用户喜欢猫', subject: 'person', hits: 2, kind: 'user_profile' }],
  emotion: 'content',
  pad: { pleasure: 0.3, arousal: 0.1, dominance: 0 },
  assertiveness: 0.8,
  stanceNotions: ['手冲比速溶值得。'],
  system: '[骨架]...\n\n[立场]...',
  messages: [{ role: 'user', content: '速溶咖啡更好' }],
  provider: 'fake',
  model: 'fake-1',
  reply: '我倒觉得手冲更值得。',
};

const tmpFiles: string[] = [];
function tmpDb(name: string): string {
  const p = join(tmpdir(), `chat-a-trace-test-${process.pid}-${name}.db`);
  tmpFiles.push(p);
  return p;
}
afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(f + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
});

describe('SqliteDecisionTraceSink', () => {
  it('record 后能查回该行,标量 + JSON 列往返一致', () => {
    const path = tmpDb('roundtrip');
    const sink = new SqliteDecisionTraceSink({ path });
    sink.record(TRACE);
    sink.close();

    const db = new DatabaseSync(path);
    const row = db.prepare('SELECT * FROM decision_traces').get() as Record<string, unknown>;
    db.close();
    expect(row['correlation_id']).toBe('s1/t1/0');
    expect(row['trace_id']).toBe('a'.repeat(32));
    expect(row['emotion']).toBe('content');
    expect(row['assertiveness']).toBe(0.8);
    expect(row['reply']).toBe('我倒觉得手冲更值得。');
    // JSON 列往返。
    expect(JSON.parse(row['recalled'] as string)).toEqual([
      { text: '用户喜欢猫', subject: 'person', hits: 2, kind: 'user_profile' },
    ]);
    expect(JSON.parse(row['messages'] as string)).toEqual([{ role: 'user', content: '速溶咖啡更好' }]);
    expect(JSON.parse(row['pad'] as string)).toEqual({ pleasure: 0.3, arousal: 0.1, dominance: 0 });
    expect(JSON.parse(row['stance_notions'] as string)).toEqual(['手冲比速溶值得。']);
  });

  it('版本化建库 + 重开迁移幂等', () => {
    const path = tmpDb('migrate');
    new SqliteDecisionTraceSink({ path }).close();
    // 重开同库:不重建、不报错,版本号稳定。
    new SqliteDecisionTraceSink({ path }).close();
    const db = new DatabaseSync(path);
    const v = db.prepare(`SELECT value FROM trace_meta WHERE key='schema_version'`).get() as { value: string };
    db.close();
    expect(Number(v.value)).toBe(CURRENT_TRACE_SCHEMA_VERSION);
  });

  it('record 内部失败自吞(已 close 后再 record 不抛)', () => {
    const path = tmpDb('swallow');
    const sink = new SqliteDecisionTraceSink({ path, onError: () => {} });
    sink.close();
    expect(() => sink.record(TRACE)).not.toThrow(); // 句柄已关 → 内部失败被自吞
  });

  it('可选字段省略时也能落库(无 traceId/pad/kind)', () => {
    const path = tmpDb('optional');
    const sink = new SqliteDecisionTraceSink({ path });
    // 省略可选字段(不写 undefined,合 exactOptionalPropertyTypes)。
    const { traceId: _t, spanId: _s, pad: _p, ...rest } = TRACE;
    void _t;
    void _s;
    void _p;
    sink.record({ ...rest, recalled: [] });
    sink.close();
    const db = new DatabaseSync(path);
    const row = db.prepare('SELECT trace_id, pad FROM decision_traces').get() as Record<string, unknown>;
    db.close();
    expect(row['trace_id']).toBeNull();
    expect(row['pad']).toBeNull();
  });
});

describe('createDecisionTraceSinkFromEnv', () => {
  it('默认关 → Noop', () => {
    const s = createDecisionTraceSinkFromEnv({});
    expect(s.enabled).toBe(false);
    expect(s.sink).toBeInstanceOf(NoopDecisionTraceSink);
  });

  it('CHAT_A_DECISION_TRACE=1 → SQLite sink + 库路径', () => {
    const path = tmpDb('fromenv');
    const s = createDecisionTraceSinkFromEnv({ CHAT_A_DECISION_TRACE: '1', CHAT_A_DECISION_TRACE_DB: path });
    expect(s.enabled).toBe(true);
    expect(s.dbPath).toBe(path);
    s.sink.close();
  });
});
