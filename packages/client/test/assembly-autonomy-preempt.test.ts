import { describe, it, expect, vi } from 'vitest';
import { LightVoiceBus, type SpeakStateView } from '@chat-a/runtime';
import { FakeLlm } from '@chat-a/providers';
import {
  InMemoryAutonomyDecisionSink,
  type ProactiveCandidateSource,
} from '@chat-a/autonomy';
import { makeBusEvent } from '@chat-a/protocol';
import { assembleAutonomy } from '../src/assembly/autonomy';

/**
 * 缝 1+2+3 接通单测(不触网):
 * - 缝 2:注入 voiceState(isSpeaking=true)→ arbiter 据真状态抢占。
 * - 缝 1:shouldPreempt 时回落 preempt 被调用(模拟触发 VoiceLoop 真打断)。
 * - 缝 3:注入 candidateSource → 决策用真候选(trace.input.candidates 含真候选)。
 */

const fixedClock = { now: () => 123_456 };

function emitSignal(bus: LightVoiceBus, description = '已经到傍晚了'): void {
  bus.emit(
    makeBusEvent('signal:perception', { kind: 'temporal:tick', description, confidence: 1 }, 'corr-1'),
  );
}

describe('client/assembleAutonomy 三缝接通', () => {
  it('缝 2+1:voiceState(isSpeaking=true)+ URGENT → 抢占 → preempt 被调用', async () => {
    const bus = new LightVoiceBus();
    const sink = new InMemoryAutonomyDecisionSink();
    const llm = new FakeLlm('f', {
      complete: JSON.stringify({ decision: 'speak', reason: '危机', text: '等一下!' }),
    });
    const preempt = vi.fn();
    // 信号 kind 以 signal:user: 开头 → signal-adapter 映射为 URGENT;在说者优先级缺省 → 可抢占。
    const handle = assembleAutonomy(
      { CHAT_A_AUTONOMY: 'on' },
      {
        bus,
        llm,
        decisionSink: sink,
        clock: fixedClock,
        decisionRng: () => 0,
        voiceState: (): SpeakStateView => ({ isSpeaking: true }),
        preempt,
      },
    );
    expect(handle).toBeDefined();
    bus.emit(makeBusEvent('signal:user:speech', { kind: 'user:speech', description: '危机', confidence: 1 }, 'c'));
    await handle!.tick();
    await handle!.tick();
    await new Promise((r) => setTimeout(r, 0));

    expect(sink.traces[0]?.decision).toBe('speak');
    expect(preempt).toHaveBeenCalledWith('autonomy_preempt'); // 缝 1:真打断被触发
    handle!.stop();
  });

  it('缝 2:voiceState(isSpeaking=true)同级不可延续 → drop,不抢占、preempt 不调用', async () => {
    const bus = new LightVoiceBus();
    const sink = new InMemoryAutonomyDecisionSink();
    const llm = new FakeLlm('f', {
      complete: JSON.stringify({ decision: 'speak', reason: '跟进', text: '在忙吗?' }),
    });
    const preempt = vi.fn();
    const handle = assembleAutonomy(
      { CHAT_A_AUTONOMY: 'on' },
      {
        bus,
        llm,
        decisionSink: sink,
        clock: fixedClock,
        decisionRng: () => 0,
        // 在说者 URGENT,来者(感知 PERCEPTION)更低 → 不抢占。deferrable=true → defer(非 drop,非 preempt)。
        voiceState: (): SpeakStateView => ({ isSpeaking: true, speakingPriority: 'URGENT' }),
        preempt,
      },
    );
    emitSignal(bus); // signal:perception → PERCEPTION
    await handle!.tick();
    await handle!.tick();
    await new Promise((r) => setTimeout(r, 0));

    expect(sink.traces[0]?.decision).toBe('speak'); // 决策 speak
    expect(preempt).not.toHaveBeenCalled(); // 但仲裁 defer(忙、低优先、可延续)→ 不抢占
    handle!.stop();
  });

  it('缝 3:候选源产真候选 → 喂决策 LLM(trace.input.candidates 为真候选)', async () => {
    const bus = new LightVoiceBus();
    const sink = new InMemoryAutonomyDecisionSink();
    const llm = new FakeLlm('f', {
      complete: JSON.stringify({ decision: 'speak', reason: '跟进', text: '你昨天的事怎么样?' }),
    });
    const candidateSource: ProactiveCandidateSource = {
      gather: () => ['阿杰,之前说到「面试」,后来怎么样了?'],
    };
    const handle = assembleAutonomy(
      { CHAT_A_AUTONOMY: 'on' },
      { bus, llm, decisionSink: sink, clock: fixedClock, decisionRng: () => 0, candidateSource },
    );
    emitSignal(bus);
    await handle!.tick();
    await handle!.tick();
    await new Promise((r) => setTimeout(r, 0));

    const t = sink.traces[0]!;
    expect(t.input.candidates).toEqual(['阿杰,之前说到「面试」,后来怎么样了?']); // 真候选,非 signal 描述
    handle!.stop();
  });

  it('缝 3:候选源返回空 → 回落现状占位(signal 描述)', async () => {
    const bus = new LightVoiceBus();
    const sink = new InMemoryAutonomyDecisionSink();
    const llm = new FakeLlm('f', { complete: JSON.stringify({ decision: 'silent', reason: '克制' }) });
    const candidateSource: ProactiveCandidateSource = { gather: () => [] };
    const handle = assembleAutonomy(
      { CHAT_A_AUTONOMY: 'on' },
      { bus, llm, decisionSink: sink, clock: fixedClock, decisionRng: () => 0, candidateSource },
    );
    emitSignal(bus, '占位描述');
    await handle!.tick();
    await handle!.tick();
    await new Promise((r) => setTimeout(r, 0));

    expect(sink.traces[0]?.input.candidates).toEqual(['占位描述']); // 空候选源回落占位
    handle!.stop();
  });

  it('off / 未注入新端口:仍回落现状(undefined / 仅记录)', async () => {
    // off → undefined
    expect(assembleAutonomy({}, { bus: new LightVoiceBus(), llm: new FakeLlm() })).toBeUndefined();
  });
});
