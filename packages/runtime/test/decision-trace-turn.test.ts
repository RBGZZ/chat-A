import { describe, it, expect } from 'vitest';
import type { LlmProvider } from '@chat-a/providers';
import type { DecisionTrace, DecisionTraceSink } from '@chat-a/observability';
import { initTelemetry } from '@chat-a/observability';
import { LightVoiceBus } from '../src/bus';
import { Conversation } from '../src/conversation';

function recordingLlm(): LlmProvider {
  return {
    id: 'rec',
    model: 'rec-1',
    async *stream() {
      yield 'ok';
    },
    async complete() {
      return 'ok';
    },
  };
}

/** 捕获 record 调用的 spy sink。 */
function spySink(): { sink: DecisionTraceSink; traces: DecisionTrace[] } {
  const traces: DecisionTrace[] = [];
  return {
    traces,
    sink: { record: (t) => traces.push(t), close: () => {} },
  };
}

describe('runtime/Conversation 决策 trace(§8.1)', () => {
  it('收尾写一条 trace,含组装 system/recalled/emotion/provider/reply', async () => {
    const { sink, traces } = spySink();
    const convo = new Conversation({ bus: new LightVoiceBus(), llm: recordingLlm(), traceSink: sink, sessionId: 's1' });
    await convo.send('你好', () => {});
    expect(traces).toHaveLength(1);
    const t = traces[0]!;
    expect(t.sessionId).toBe('s1');
    expect(t.turnId).toBe('t1');
    expect(t.userText).toBe('你好');
    expect(t.system).toContain('【当前情绪】'); // 组装出的 system 含 tone 段
    expect(t.emotion.length).toBeGreaterThan(0);
    expect(t.provider).toBe('rec');
    expect(t.model).toBe('rec-1');
    expect(t.reply).toBe('ok');
    expect(t.messages.at(-1)).toEqual({ role: 'user', content: '你好' });
    expect(t.latencyMs).toBeGreaterThanOrEqual(0);
    expect(t.pad).toBeDefined();
  });

  it('第二轮 trace 的 recalled 含上一轮落库后被召回的记忆', async () => {
    const { sink, traces } = spySink();
    const convo = new Conversation({ bus: new LightVoiceBus(), llm: recordingLlm(), traceSink: sink, sessionId: 's2' });
    await convo.send('我喜欢猫', () => {}); // naive 存原话
    await convo.send('猫', () => {}); // 关键词召回
    const second = traces[1]!;
    expect(second.recalled.some((r) => r.text.includes('猫'))).toBe(true);
    expect(second.recalled[0]?.subject).toBeDefined();
  });

  it('sink.record 抛错 → 回合仍正常返回回复(降级,§3.2)', async () => {
    const boom: DecisionTraceSink = {
      record: () => {
        throw new Error('sink boom');
      },
      close: () => {},
    };
    const convo = new Conversation({ bus: new LightVoiceBus(), llm: recordingLlm(), traceSink: boom, sessionId: 'b' });
    const reply = await convo.send('你好', () => {});
    expect(reply).toBe('ok');
  });

  it('默认无 sink(Noop)行为与现状一致(不抛、正常回复)', async () => {
    const convo = new Conversation({ bus: new LightVoiceBus(), llm: recordingLlm(), sessionId: 'n' });
    expect(await convo.send('你好', () => {})).toBe('ok');
  });

  it('有 OTel 时 traceId/spanId 非空且为合法长度(缝合键)', async () => {
    const telemetry = initTelemetry({ console: false, spanProcessors: [] });
    try {
      const { sink, traces } = spySink();
      const convo = new Conversation({ bus: new LightVoiceBus(), llm: recordingLlm(), traceSink: sink, sessionId: 'o' });
      await convo.send('你好', () => {});
      const t = traces[0]!;
      expect(t.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(t.spanId).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      await telemetry.shutdown();
    }
  });
});
