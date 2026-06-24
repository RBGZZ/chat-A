import { describe, it, expect } from 'vitest';
import { LightVoiceBus } from '@chat-a/runtime';
import { FakeLlm } from '@chat-a/providers';
import { InMemoryAutonomyDecisionSink, isAutonomyEnabled } from '@chat-a/autonomy';
import { makeBusEvent } from '@chat-a/protocol';
import { assembleAutonomy, AUTONOMY_RUNNER_SKILL_ID, loadAutonomyTickMs, DEFAULT_AUTONOMY_TICK_MS } from '../src/assembly/autonomy';

/**
 * autonomy 装配薄壳测试(不触网):
 * FakeLlm(返回 speak JSON)+ 注入恒过概率闸 + InMemory 决策 sink + 手动 tick,
 * 断言:总线 signal:* → 队列 → 技能 tick → runner.run speak → 决策落 sink。
 */

const fixedClock = { now: () => 123_456 };

describe('client/assembleAutonomy 开关与端到端接线', () => {
  it('off(未设 CHAT_A_AUTONOMY)→ 返回 undefined,不订阅总线', () => {
    const bus = new LightVoiceBus();
    let anyCalls = 0;
    bus.onAny(() => (anyCalls += 1));
    const handle = assembleAutonomy({}, { bus, llm: new FakeLlm() });
    expect(handle).toBeUndefined();
    // 装配未订阅:emit 一条 signal 不触发任何 autonomy 侧逻辑(仅自己的计数订阅)。
    bus.emit(makeBusEvent('signal:perception', { kind: 'temporal:tick', description: 'tick', confidence: 1 }, 'c1'));
    expect(anyCalls).toBe(1);
  });

  it('on + FakeLlm(speak)+ 恒过闸 → signal 经总线驱动一次主动决策并落 sink', async () => {
    const bus = new LightVoiceBus();
    const sink = new InMemoryAutonomyDecisionSink();
    // FakeLlm.complete 返回 speak JSON(决策 LLM 解析后走 speak)。
    const llm = new FakeLlm('fake-1', {
      complete: JSON.stringify({ decision: 'speak', reason: '值得说', text: '在忙吗?' }),
    });
    const handle = assembleAutonomy(
      { CHAT_A_AUTONOMY: 'on' },
      {
        bus,
        llm,
        decisionSink: sink,
        clock: fixedClock,
        decisionRng: () => 0, // 恒过概率闸(0 < rate)→ 必问 LLM
        // 不注入 schedule:返回的 handle.tick 可手动驱动(内部 setInterval 不会在测试中触发)。
      },
    );
    expect(handle).toBeDefined();

    // 总线发一条感知信号 → 经 signal-adapter 入队。
    bus.emit(
      makeBusEvent(
        'signal:perception',
        { kind: 'temporal:tick', description: '已经到傍晚了', confidence: 1 },
        'corr-1',
      ),
    );

    // 第一次 tick:scheduler bringUp(initialize+start)技能;第二次 tick 才真正跑 skill.tick。
    await handle!.tick();
    await handle!.tick();
    // skill.tick 是 async,等其结算(runner.run → DecisionLlm.decide → sink.record)。
    await new Promise((r) => setTimeout(r, 0));

    expect(sink.traces.length).toBeGreaterThan(0);
    const t = sink.traces[0]!;
    expect(t.skillId).toBe(AUTONOMY_RUNNER_SKILL_ID);
    expect(t.decision).toBe('speak');
    handle!.stop();
  });

  it('on + 决策 sink 记录失败/降级:FakeLlm 返回非法 JSON → 退 silent 并落 trace', async () => {
    const bus = new LightVoiceBus();
    const sink = new InMemoryAutonomyDecisionSink();
    const llm = new FakeLlm('fake-1', { complete: '不是 JSON' });
    const handle = assembleAutonomy(
      { CHAT_A_AUTONOMY: 'on' },
      { bus, llm, decisionSink: sink, clock: fixedClock, decisionRng: () => 0 },
    );
    bus.emit(makeBusEvent('signal:perception', { kind: 'temporal:tick', description: 'x', confidence: 1 }, 'c'));
    await handle!.tick();
    await handle!.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(sink.traces.length).toBeGreaterThan(0);
    expect(sink.traces[0]!.decision).toBe('silent'); // 非法 JSON → 降级 silent
    handle!.stop();
  });

  it('开关常量与 tick 周期解析', () => {
    expect(isAutonomyEnabled({ CHAT_A_AUTONOMY: 'on' })).toBe(true);
    expect(isAutonomyEnabled({})).toBe(false);
    expect(loadAutonomyTickMs({})).toBe(DEFAULT_AUTONOMY_TICK_MS);
    expect(loadAutonomyTickMs({ CHAT_A_AUTONOMY_TICK_MS: '2000' })).toBe(2000);
    expect(loadAutonomyTickMs({ CHAT_A_AUTONOMY_TICK_MS: 'x' })).toBe(DEFAULT_AUTONOMY_TICK_MS);
  });
});
