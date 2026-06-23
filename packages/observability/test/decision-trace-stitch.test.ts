import { describe, it, expect, afterEach } from 'vitest';
import { trace, context, TraceFlags, type Span } from '@opentelemetry/api';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SqliteDecisionTraceSink,
  DecisionTraceReader,
  captureActiveSpanContext,
  getTracer,
  initTelemetry,
  type DecisionTrace,
  type TelemetryHandle,
} from '../src/index';

/**
 * §8.1「两层追踪,同 ID 缝合」专项测试:
 * 落决策 trace 时自动捕获活动 OTel span 的 trace_id/span_id,使「OTel 发现慢回合 →
 * 跳到 SQLite 完整决策记录」可缝合;无活动 span 时优雅缺省(NULL,不写垃圾)。
 */

// 基础 trace 模板:刻意**不带** traceId/spanId,以验证「自动从活动 span 捕获」。
const BASE: DecisionTrace = {
  correlationId: 's1/t1/0',
  sessionId: 's1',
  turnId: 't1',
  createdAtMs: 1000,
  latencyMs: 42,
  userText: '速溶咖啡更好',
  recalled: [],
  emotion: 'content',
  assertiveness: 0.8,
  stanceNotions: [],
  system: '[骨架]...',
  messages: [{ role: 'user', content: '速溶咖啡更好' }],
  provider: 'fake',
  model: 'fake-1',
  reply: '我倒觉得手冲更值得。',
};

const tmpFiles: string[] = [];
function tmpDb(name: string): string {
  const p = join(tmpdir(), `chat-a-trace-stitch-${process.pid}-${name}.db`);
  tmpFiles.push(p);
  return p;
}

let handle: TelemetryHandle | undefined;
afterEach(async () => {
  if (handle !== undefined) {
    await handle.shutdown();
    handle = undefined;
  }
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

describe('captureActiveSpanContext', () => {
  it('无活动 span(未 init):返回空对象,不含 traceId/spanId 键', () => {
    const cap = captureActiveSpanContext();
    expect('traceId' in cap).toBe(false);
    expect('spanId' in cap).toBe(false);
  });

  it('有活动 span:返回该 span 的 traceId/spanId', () => {
    handle = initTelemetry({ console: false }); // register() 装上 ALS context manager
    getTracer().startActiveSpan('turn', (span: Span) => {
      const cap = captureActiveSpanContext();
      const sc = span.spanContext();
      expect(cap.traceId).toBe(sc.traceId);
      expect(cap.spanId).toBe(sc.spanId);
      span.end();
    });
  });

  it('span context 无效(全零 id):降级为空对象', () => {
    handle = initTelemetry({ console: false });
    // 手工塞一个无效 span context(全零 traceId/spanId)作为活动 span。
    const invalid = trace.wrapSpanContext({
      traceId: '0'.repeat(32),
      spanId: '0'.repeat(16),
      traceFlags: TraceFlags.NONE,
    });
    context.with(trace.setSpan(context.active(), invalid), () => {
      const cap = captureActiveSpanContext();
      expect('traceId' in cap).toBe(false);
      expect('spanId' in cap).toBe(false);
    });
  });
});

describe('SqliteDecisionTraceSink 自动缝合活动 span', () => {
  it('① 有活动 span 时,决策记录带上该 span 的 trace_id/span_id', () => {
    handle = initTelemetry({ console: false });
    const path = tmpDb('with-span');
    const sink = new SqliteDecisionTraceSink({ path });

    let expectedTraceId = '';
    let expectedSpanId = '';
    getTracer().startActiveSpan('turn', (span: Span) => {
      const sc = span.spanContext();
      expectedTraceId = sc.traceId;
      expectedSpanId = sc.spanId;
      sink.record({ ...BASE, turnId: 'auto' }); // 在 span 内落库
      span.end();
    });
    sink.close();

    const reader = new DecisionTraceReader({ path });
    const t = reader.getByTurnId('auto');
    expect(t?.traceId).toBe(expectedTraceId);
    expect(t?.spanId).toBe(expectedSpanId);
    // 精确缝合查询能取回。
    expect(reader.getByTraceAndSpanId(expectedTraceId, expectedSpanId)?.turnId).toBe('auto');
    reader.close();
  });

  it('② 无活动 span 时优雅缺省:trace_id/span_id 落 NULL,还原时省略键', () => {
    // 不 init telemetry → 无活动 span。
    const path = tmpDb('no-span');
    const sink = new SqliteDecisionTraceSink({ path });
    sink.record({ ...BASE, turnId: 'bare' });
    sink.close();

    const reader = new DecisionTraceReader({ path });
    const t = reader.getByTurnId('bare');
    expect(t).toBeDefined();
    expect('traceId' in (t as object)).toBe(false);
    expect('spanId' in (t as object)).toBe(false);
    reader.close();
  });

  it('trace 自身显式带 traceId 时以 trace 为准(编排层覆盖优先,即便有活动 span)', () => {
    handle = initTelemetry({ console: false });
    const path = tmpDb('explicit-wins');
    const sink = new SqliteDecisionTraceSink({ path });

    const explicitTrace = 'c'.repeat(32);
    const explicitSpan = 'd'.repeat(16);
    getTracer().startActiveSpan('turn', (span: Span) => {
      sink.record({ ...BASE, turnId: 'explicit', traceId: explicitTrace, spanId: explicitSpan });
      span.end();
    });
    sink.close();

    const reader = new DecisionTraceReader({ path });
    const t = reader.getByTurnId('explicit');
    expect(t?.traceId).toBe(explicitTrace); // 显式值赢,未被活动 span 覆盖
    expect(t?.spanId).toBe(explicitSpan);
    reader.close();
  });

  it('captureActiveSpan=false:即便有活动 span 也不自动缝合(NULL)', () => {
    handle = initTelemetry({ console: false });
    const path = tmpDb('opt-out');
    const sink = new SqliteDecisionTraceSink({ path, captureActiveSpan: false });
    getTracer().startActiveSpan('turn', (span: Span) => {
      sink.record({ ...BASE, turnId: 'optout' });
      span.end();
    });
    sink.close();

    const reader = new DecisionTraceReader({ path });
    const t = reader.getByTurnId('optout');
    expect('traceId' in (t as object)).toBe(false);
    reader.close();
  });
});

describe('DecisionTraceReader.getByTraceAndSpanId', () => {
  it('③ 按 trace_id + span_id 精确取回完整决策记录', () => {
    const path = tmpDb('precise');
    const traceId = 'a'.repeat(32);
    const sink = new SqliteDecisionTraceSink({ path, captureActiveSpan: false });
    // 同一 trace_id 下两个不同 span/回合。
    sink.record({ ...BASE, turnId: 'turnA', traceId, spanId: '1'.repeat(16) });
    sink.record({ ...BASE, turnId: 'turnB', traceId, spanId: '2'.repeat(16) });
    sink.close();

    const reader = new DecisionTraceReader({ path });
    expect(reader.getByTraceAndSpanId(traceId, '1'.repeat(16))?.turnId).toBe('turnA');
    expect(reader.getByTraceAndSpanId(traceId, '2'.repeat(16))?.turnId).toBe('turnB');
    reader.close();
  });

  it('无效 / 未命中 id:返回 undefined,不抛', () => {
    const path = tmpDb('miss');
    const sink = new SqliteDecisionTraceSink({ path, captureActiveSpan: false });
    sink.record({ ...BASE, turnId: 'x', traceId: 'a'.repeat(32), spanId: '1'.repeat(16) });
    sink.close();

    const reader = new DecisionTraceReader({ path });
    expect(reader.getByTraceAndSpanId('a'.repeat(32), 'f'.repeat(16))).toBeUndefined(); // span 不匹配
    expect(reader.getByTraceAndSpanId('nope', '1'.repeat(16))).toBeUndefined(); // trace 不匹配
    expect(() => reader.getByTraceAndSpanId('', '')).not.toThrow(); // 空串不崩
    reader.close();
  });
});
