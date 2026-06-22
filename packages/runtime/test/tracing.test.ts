import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { initTelemetry, type TelemetryHandle } from '@chat-a/observability';
import { FakeLlm } from '@chat-a/providers';
import { LightVoiceBus } from '../src/bus';
import { Conversation } from '../src/conversation';

const exporter = new InMemorySpanExporter();
let telemetry: TelemetryHandle;

beforeAll(() => {
  telemetry = initTelemetry({ console: false, spanProcessors: [new SimpleSpanProcessor(exporter)] });
});
afterAll(async () => {
  await telemetry.shutdown();
});
beforeEach(() => {
  exporter.reset();
});

describe('runtime/tracing(OTel 骨架 §8.1)', () => {
  it('一回合产出 turn→llm span 树,带关联ID缝合键与 GenAI 属性', async () => {
    const bus = new LightVoiceBus();
    const convo = new Conversation({ bus, llm: new FakeLlm(), sessionId: 's1' });
    await convo.send('你好', () => {});

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === 'turn');
    const llm = spans.find((s) => s.name === 'llm');
    expect(turn).toBeDefined();
    expect(llm).toBeDefined();
    if (turn === undefined || llm === undefined) return;

    // 同一 trace,且 llm 是 turn 的子 span(span 树成形)。
    expect(llm.spanContext().traceId).toBe(turn.spanContext().traceId);
    expect(llm.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);

    // 关联 ID = OTel↔SQLite 决策 trace 的缝合键(§8.1)。
    expect(turn.attributes['chat_a.correlation_id']).toBe('s1/t1/0');
    expect(turn.attributes['chat_a.session_id']).toBe('s1');

    // GenAI 语义约定属性(id/model 仅供 trace)。
    expect(llm.attributes['gen_ai.operation.name']).toBe('chat');
    expect(llm.attributes['gen_ai.provider.name']).toBe('fake');
    expect(llm.attributes['gen_ai.conversation.id']).toBe('s1');
  });

  it('LLM 出错时 turn/llm span 标记 ERROR 状态', async () => {
    // 流式即抛的 provider,触发错误路径。
    const failing = {
      id: 'boom',
      model: 'boom-1',
      async *stream(): AsyncIterable<string> {
        throw new Error('llm 挂了');
      },
    };

    const bus = new LightVoiceBus();
    const convo = new Conversation({ bus, llm: failing, sessionId: 's2' });
    await expect(convo.send('你好', () => {})).rejects.toThrow('llm 挂了');

    const spans = exporter.getFinishedSpans();
    const llm = spans.find((s) => s.name === 'llm');
    const turn = spans.find((s) => s.name === 'turn');
    // SpanStatusCode.ERROR === 2
    expect(llm?.status.code).toBe(2);
    expect(turn?.status.code).toBe(2);
  });
});
