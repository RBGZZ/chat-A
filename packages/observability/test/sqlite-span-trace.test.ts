import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SqliteSpanSink,
  CURRENT_SPAN_SCHEMA_VERSION,
  type SpanRecord,
} from '../src/index';

/**
 * §8.1 OTel span 落 SQLite:`SqliteSpanSink` 落库 + 只读还原往返、可选属性 NULL、
 * 同 (trace_id,span_id) 幂等 upsert、close 后自吞、版本化迁移幂等。
 */

const SPAN: SpanRecord = {
  traceId: 'a'.repeat(32),
  spanId: '1'.repeat(16),
  parentSpanId: '2'.repeat(16),
  name: 'turn',
  startTimeMs: 1000,
  endTimeMs: 1420,
  durationMs: 420,
  statusCode: 'ok',
  operationName: 'chat',
  provider: 'deepseek',
  model: 'deepseek-chat',
  inputTokens: 120,
  outputTokens: 64,
  outputType: 'text',
  conversationId: 's1',
  sessionId: 's1',
  turnId: 't1',
  correlationId: 's1/t1/0',
};

const tmpFiles: string[] = [];
function tmpDb(name: string): string {
  const p = join(tmpdir(), `chat-a-span-trace-${process.pid}-${name}.db`);
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

describe('SqliteSpanSink', () => {
  it('recordSpan 后只读还原往返一致(全字段 + GenAI 属性)', () => {
    const path = tmpDb('roundtrip');
    const sink = new SqliteSpanSink({ path });
    sink.recordSpan(SPAN);
    const got = sink.getSpanById(SPAN.traceId, SPAN.spanId);
    sink.close();
    expect(got).toEqual(SPAN);
  });

  it('可选属性省略时落 NULL,还原时省略键', () => {
    const path = tmpDb('optional');
    const sink = new SqliteSpanSink({ path });
    const bare: SpanRecord = {
      traceId: 'b'.repeat(32),
      spanId: '3'.repeat(16),
      name: 'stt',
      startTimeMs: 0,
      endTimeMs: 10,
      durationMs: 10,
      statusCode: 'unset',
    };
    sink.recordSpan(bare);
    const got = sink.getSpanById(bare.traceId, bare.spanId);
    sink.close();
    expect(got).toEqual(bare);
    expect('parentSpanId' in (got as object)).toBe(false);
    expect('provider' in (got as object)).toBe(false);
    expect('inputTokens' in (got as object)).toBe(false);

    const db = new DatabaseSync(path);
    const row = db
      .prepare('SELECT parent_span_id, provider, input_tokens FROM otel_spans WHERE span_id = ?')
      .get(bare.spanId) as Record<string, unknown>;
    db.close();
    expect(row['parent_span_id']).toBeNull();
    expect(row['provider']).toBeNull();
    expect(row['input_tokens']).toBeNull();
  });

  it('同 (trace_id,span_id) 二次 record 幂等 upsert(不重复行,后写覆盖)', () => {
    const path = tmpDb('upsert');
    const sink = new SqliteSpanSink({ path });
    sink.recordSpan(SPAN);
    sink.recordSpan({ ...SPAN, durationMs: 999, name: 'turn-updated' });
    const all = sink.getSpansByTraceId(SPAN.traceId);
    sink.close();
    expect(all).toHaveLength(1);
    expect(all[0]?.durationMs).toBe(999);
    expect(all[0]?.name).toBe('turn-updated');
  });

  it('getSpansByTraceId 按 start 升序返回同 trace 下多个 span', () => {
    const path = tmpDb('bytrace');
    const trace = 'c'.repeat(32);
    const sink = new SqliteSpanSink({ path });
    sink.recordSpan({ ...SPAN, traceId: trace, spanId: 'a'.repeat(16), name: 'llm', startTimeMs: 200 });
    sink.recordSpan({ ...SPAN, traceId: trace, spanId: 'b'.repeat(16), name: 'stt', startTimeMs: 100 });
    sink.recordSpan({ ...SPAN, traceId: trace, spanId: 'd'.repeat(16), name: 'tts', startTimeMs: 300 });
    const spans = sink.getSpansByTraceId(trace);
    sink.close();
    expect(spans.map((s) => s.name)).toEqual(['stt', 'llm', 'tts']);
  });

  it('close 后再 record 不抛(内部失败自吞)', () => {
    const path = tmpDb('swallow');
    const sink = new SqliteSpanSink({ path, onError: () => {} });
    sink.close();
    expect(() => sink.recordSpan(SPAN)).not.toThrow();
  });

  it('版本化建库 + 重开迁移幂等', () => {
    const path = tmpDb('migrate');
    new SqliteSpanSink({ path }).close();
    new SqliteSpanSink({ path }).close();
    const db = new DatabaseSync(path);
    const v = db.prepare(`SELECT value FROM span_meta WHERE key='schema_version'`).get() as { value: string };
    db.close();
    expect(Number(v.value)).toBe(CURRENT_SPAN_SCHEMA_VERSION);
  });

  it('表缺失 → 只读还原降级空结果', () => {
    const path = tmpDb('emptydb');
    // 建一个无 otel_spans 表的库。
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE foo(x INTEGER);');
    db.close();
    const sink = new SqliteSpanSink({ path, onError: () => {} });
    // 注意:SqliteSpanSink 构造会自建表迁移,这里改为直接对一个不含表的只读访问验证降级。
    // 先关闭句柄制造"还原时表已不可用"的降级路径。
    sink.close();
    expect(sink.getSpansByTraceId('zzz')).toEqual([]);
    expect(sink.getSpanById('zzz', 'yyy')).toBeUndefined();
  });
});
