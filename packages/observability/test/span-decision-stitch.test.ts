import { describe, it, expect, afterEach } from 'vitest';
import { type Span } from '@opentelemetry/api';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SqliteSpanSink,
  SqliteSpanProcessor,
  SqliteDecisionTraceSink,
  DecisionTraceReader,
  initTelemetry,
  getTracer,
  type DecisionTrace,
  type TelemetryHandle,
} from '../src/index';

/**
 * §8.1 同 ID 缝合闭环:同一活动 OTel span 内,既写决策记录(自动捕获 span_id)
 * 又结束 span 落 otel_spans(同库);断言 decision_traces.span_id === otel_spans.span_id,
 * 凭 trace_id+span_id 能同时取回决策链与 span 阶段耗时。
 */

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
  provider: 'deepseek',
  model: 'deepseek-chat',
  reply: '我倒觉得手冲更值得。',
};

const tmpFiles: string[] = [];
function tmpDb(name: string): string {
  const p = join(tmpdir(), `chat-a-span-stitch-${process.pid}-${name}.db`);
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

describe('决策记录 ←→ otel_spans 同库 span_id 缝合', () => {
  it('同 span 内写决策 + 落 span:span_id 相等,可凭 trace_id+span_id 取回两侧', async () => {
    const path = tmpDb('same-db');
    const processor = new SqliteSpanProcessor({ path });
    handle = initTelemetry({ console: false, spanProcessors: [processor] });

    const decisionSink = new SqliteDecisionTraceSink({ path });

    let traceId = '';
    let spanId = '';
    getTracer().startActiveSpan('turn', (span: Span) => {
      const sc = span.spanContext();
      traceId = sc.traceId;
      spanId = sc.spanId;
      decisionSink.record({ ...BASE, turnId: 'stitch' }); // 自动捕获活动 span_id
      span.end();
    });
    decisionSink.close();
    await processor.forceFlush();

    // 决策侧:span_id 取回。
    const reader = new DecisionTraceReader({ path });
    const decision = reader.getByTurnId('stitch');
    reader.close();
    expect(decision?.traceId).toBe(traceId);
    expect(decision?.spanId).toBe(spanId);

    // span 侧:同库同 span_id 取回。
    const spanSink = new SqliteSpanSink({ path });
    const span = spanSink.getSpanById(traceId, spanId);
    spanSink.close();
    expect(span?.spanId).toBe(spanId);
    expect(span?.traceId).toBe(traceId);
    expect(span?.name).toBe('turn');

    // 缝合等式:两侧 span_id 一致(§8.1)。
    expect(decision?.spanId).toBe(span?.spanId);
  });
});
