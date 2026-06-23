import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SqliteDecisionTraceSink,
  NoopDecisionTraceSink,
  DecisionTraceReader,
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

describe('SqliteDecisionTraceSink: posture(§7#6)+ v1→v2 迁移', () => {
  it('posture 往返:写 sulking 查回 sulking;无姿态 → NULL', () => {
    const path = tmpDb('posture');
    const sink = new SqliteDecisionTraceSink({ path });
    sink.record({ ...TRACE, turnId: 't1', posture: 'sulking' });
    sink.record({ ...TRACE, turnId: 't2' }); // 无 posture
    sink.close();
    const db = new DatabaseSync(path);
    const rows = db.prepare('SELECT turn_id, posture FROM decision_traces ORDER BY turn_id').all() as Record<
      string,
      unknown
    >[];
    db.close();
    expect(rows[0]).toMatchObject({ turn_id: 't1', posture: 'sulking' });
    expect(rows[1]).toMatchObject({ turn_id: 't2', posture: null });
  });

  it('v1 旧库重开 → 迁移到 v2 补 posture 列,历史行不丢、posture=NULL', () => {
    const path = tmpDb('v1migrate');
    // 手工建一个 v1 库(无 posture 列)+ 一条历史行。
    const v1 = new DatabaseSync(path);
    v1.exec(`
      CREATE TABLE trace_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE decision_traces(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        correlation_id TEXT NOT NULL, trace_id TEXT, span_id TEXT,
        session_id TEXT NOT NULL, turn_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL, user_text TEXT NOT NULL, recalled TEXT NOT NULL,
        emotion TEXT NOT NULL, pad TEXT, assertiveness REAL NOT NULL, stance_notions TEXT NOT NULL,
        system TEXT NOT NULL, messages TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, reply TEXT NOT NULL
      );
      INSERT INTO trace_meta(key,value) VALUES('schema_version','1');
      INSERT INTO decision_traces(correlation_id,session_id,turn_id,created_at,latency_ms,user_text,recalled,emotion,assertiveness,stance_notions,system,messages,provider,model,reply)
        VALUES('old/t0/0','old','t0',1,1,'hi','[]','neutral',0.5,'[]','sys','[]','fake','fake-1','hello');
    `);
    v1.close();

    // 用当前代码打开 → 应迁移到 v2(加 posture 列),不抛、不丢历史。
    const sink = new SqliteDecisionTraceSink({ path });
    sink.record({ ...TRACE, turnId: 't1', posture: 'withdrawn' });
    sink.close();

    const db = new DatabaseSync(path);
    const ver = db.prepare(`SELECT value FROM trace_meta WHERE key='schema_version'`).get() as { value: string };
    const rows = db.prepare('SELECT turn_id, posture FROM decision_traces ORDER BY id').all() as Record<
      string,
      unknown
    >[];
    db.close();
    expect(Number(ver.value)).toBe(CURRENT_TRACE_SCHEMA_VERSION);
    expect(rows[0]).toMatchObject({ turn_id: 't0', posture: null }); // 历史行保留,新列 NULL
    expect(rows[1]).toMatchObject({ turn_id: 't1', posture: 'withdrawn' });
  });
});

describe('SqliteDecisionTraceSink: 语义召回元数据(§5.5/§8.1)', () => {
  it('记录可带语义召回元数据(向后兼容:省略不写)', () => {
    const path = tmpDb('semantic');
    const sink = new SqliteDecisionTraceSink({ path });
    sink.record({
      ...TRACE,
      turnId: 't1',
      semanticUsed: true,
      embedLatencyMs: 42,
      embedTimedOut: false,
      embedCacheHit: true,
    });
    sink.record({ ...TRACE, turnId: 't2' }); // 不带语义字段:不应报错
    sink.close();

    const reader = new DecisionTraceReader({ path });
    const withSemantic = reader.getByTurnId('t1');
    const without = reader.getByTurnId('t2');
    reader.close();

    expect(withSemantic?.semanticUsed).toBe(true);
    expect(withSemantic?.embedLatencyMs).toBe(42);
    expect(withSemantic?.embedTimedOut).toBe(false);
    expect(withSemantic?.embedCacheHit).toBe(true);
    // 省略时:reader 不写这些字段(exactOptionalPropertyTypes 条件展开)。
    expect(without).toBeDefined();
    expect(without?.semanticUsed).toBeUndefined();
    expect(without?.embedLatencyMs).toBeUndefined();
    expect(without?.embedTimedOut).toBeUndefined();
    expect(without?.embedCacheHit).toBeUndefined();
  });

  it('语义可空列落库:省略字段 → NULL', () => {
    const path = tmpDb('semantic-null');
    const sink = new SqliteDecisionTraceSink({ path });
    sink.record({ ...TRACE, turnId: 't0' }); // 完全不带语义字段
    sink.close();
    const db = new DatabaseSync(path);
    const row = db
      .prepare('SELECT semantic_used, embed_latency_ms, embed_timed_out, embed_cache_hit FROM decision_traces')
      .get() as Record<string, unknown>;
    db.close();
    expect(row['semantic_used']).toBeNull();
    expect(row['embed_latency_ms']).toBeNull();
    expect(row['embed_timed_out']).toBeNull();
    expect(row['embed_cache_hit']).toBeNull();
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
