import { describe, it, expect, afterEach } from 'vitest';
import { type Span, SpanStatusCode } from '@opentelemetry/api';
import { AlwaysOffSampler } from '@opentelemetry/sdk-trace-base';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SqliteSpanSink,
  SqliteSpanProcessor,
  createSpanProcessorFromEnv,
  initTelemetry,
  getTracer,
  GENAI,
  CHAT_A,
  type TelemetryHandle,
} from '../src/index';

/**
 * §8.1 自定义 SpanProcessor:span onEnd → 投影 → 异步落 SQLite;
 * forceFlush 后可查回;导出失败优雅降级;两侧分治采样;env 装配。
 */

const tmpFiles: string[] = [];
function tmpDb(name: string): string {
  const p = join(tmpdir(), `chat-a-span-proc-${process.pid}-${name}.db`);
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

describe('SqliteSpanProcessor 投影 + 落库', () => {
  it('span onEnd → 投影落库:字段 + GenAI 属性 + HrTime→ms + parent', async () => {
    const path = tmpDb('project');
    const processor = new SqliteSpanProcessor({ path });
    handle = initTelemetry({ console: false, spanProcessors: [processor] });

    let traceId = '';
    let parentId = '';
    let childId = '';
    getTracer().startActiveSpan('turn', (parent: Span) => {
      parentId = parent.spanContext().spanId;
      traceId = parent.spanContext().traceId;
      getTracer().startActiveSpan('llm', (child: Span) => {
        childId = child.spanContext().spanId;
        child.setAttribute(GENAI.OPERATION_NAME, 'chat');
        child.setAttribute(GENAI.PROVIDER_NAME, 'deepseek');
        child.setAttribute(GENAI.REQUEST_MODEL, 'deepseek-chat');
        child.setAttribute(GENAI.USAGE_INPUT_TOKENS, 120);
        child.setAttribute(GENAI.USAGE_OUTPUT_TOKENS, 64);
        child.setAttribute(GENAI.OUTPUT_TYPE, 'text');
        child.setAttribute(GENAI.CONVERSATION_ID, 's1');
        child.setAttribute(CHAT_A.SESSION_ID, 's1');
        child.setAttribute(CHAT_A.TURN_ID, 't1');
        child.setStatus({ code: SpanStatusCode.OK });
        child.end();
      });
      parent.end();
    });

    await processor.forceFlush();

    const reader = new SqliteSpanSink({ path });
    const llm = reader.getSpanById(traceId, childId);
    const turn = reader.getSpanById(traceId, parentId);
    reader.close();

    expect(turn?.name).toBe('turn');
    expect(turn?.parentSpanId).toBeUndefined(); // 根 span 无 parent
    expect(llm?.name).toBe('llm');
    expect(llm?.parentSpanId).toBe(parentId); // 缝合父子
    expect(llm?.operationName).toBe('chat');
    expect(llm?.provider).toBe('deepseek');
    expect(llm?.model).toBe('deepseek-chat');
    expect(llm?.inputTokens).toBe(120);
    expect(llm?.outputTokens).toBe(64);
    expect(llm?.outputType).toBe('text');
    expect(llm?.conversationId).toBe('s1');
    expect(llm?.sessionId).toBe('s1');
    expect(llm?.turnId).toBe('t1');
    expect(llm?.statusCode).toBe('ok');
    // 真实时刻 + 毫秒时长合理。
    expect(typeof llm?.startTimeMs).toBe('number');
    expect(llm?.durationMs).toBeGreaterThanOrEqual(0);
    expect((llm?.endTimeMs ?? 0) - (llm?.startTimeMs ?? 0)).toBeCloseTo(llm?.durationMs ?? -1, 0);
  });

  it('导出失败优雅降级:sink 已关后 onEnd/forceFlush 不抛', async () => {
    const path = tmpDb('degrade');
    const sink = new SqliteSpanSink({ path, onError: () => {} });
    sink.close(); // 制造写库失败
    const processor = new SqliteSpanProcessor({ sink, onError: () => {} });
    handle = initTelemetry({ console: false, spanProcessors: [processor] });

    expect(() => {
      getTracer().startActiveSpan('turn', (s: Span) => s.end());
    }).not.toThrow();
    await expect(processor.forceFlush()).resolves.not.toThrow();
  });
});

describe('两侧分治采样', () => {
  it('默认(不传 sampler)→ 全采:全部 span 落 SQLite', async () => {
    const path = tmpDb('allon');
    const processor = new SqliteSpanProcessor({ path });
    handle = initTelemetry({ console: false, spanProcessors: [processor] });
    let traceId = '';
    for (let i = 0; i < 3; i++) {
      getTracer().startActiveSpan(`s${i}`, (s: Span) => {
        traceId = s.spanContext().traceId;
        s.end();
      });
    }
    await processor.forceFlush();
    const reader = new SqliteSpanSink({ path });
    // 三个独立 trace,各 1 span;用最后一个 traceId 至少能取回 1。
    const last = reader.getSpansByTraceId(traceId);
    reader.close();
    expect(last.length).toBe(1);
  });

  it('provider 采掉(AlwaysOff)→ onEnd 不触发,SQLite 无 span(真相源须配全采)', async () => {
    const path = tmpDb('alloff');
    const processor = new SqliteSpanProcessor({ path });
    handle = initTelemetry({ console: false, sampler: new AlwaysOffSampler(), spanProcessors: [processor] });
    let traceId = '';
    getTracer().startActiveSpan('turn', (s: Span) => {
      traceId = s.spanContext().traceId;
      s.end();
    });
    await processor.forceFlush();
    const reader = new SqliteSpanSink({ path });
    const spans = reader.getSpansByTraceId(traceId);
    reader.close();
    expect(spans).toEqual([]);
  });
});

describe('createSpanProcessorFromEnv', () => {
  it('默认关 → enabled:false,无 processor', () => {
    const r = createSpanProcessorFromEnv({});
    expect(r.enabled).toBe(false);
  });

  it('CHAT_A_OTEL_SPAN_SQLITE=1 → enabled:true + dbPath + processor', async () => {
    const path = tmpDb('fromenv');
    const r = createSpanProcessorFromEnv({ CHAT_A_OTEL_SPAN_SQLITE: '1', CHAT_A_OTEL_SPAN_SQLITE_DB: path });
    expect(r.enabled).toBe(true);
    if (r.enabled) {
      expect(r.dbPath).toBe(path);
      expect(r.processor).toBeInstanceOf(SqliteSpanProcessor);
      await r.processor.shutdown();
    }
  });
});
