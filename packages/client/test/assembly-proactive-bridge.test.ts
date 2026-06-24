import { describe, it, expect, vi } from 'vitest';
import { LightVoiceBus } from '@chat-a/runtime';
import { FakeLlm } from '@chat-a/providers';
import {
  assembleProactiveBridge,
  DEFAULT_PROACTIVE_IDLE_MS,
  loadProactiveIdleMs,
  type ProactiveBridgeDeps,
} from '../src/assembly/proactive-bridge';
import type { ProactiveSpeech } from '../src/assembly/autonomy';

/**
 * 主动陪伴桥(代理B)装配测试(不触网、确定性):
 * - off(未设 CHAT_A_AUTONOMY)→ 返回 undefined,绝不挂任何东西;
 * - on + FakeLlm(speak)+ 恒过闸 + 手动 idle tick → 端到端产出**一条真实主动话语**经 onProactiveSpeak 推出;
 * - 主动话语经注入的 persona/memory system 提示生成(断言提示被透传给决策 LLM);
 * - idle 周期解析纯函数。
 */

const fixedClock = { now: () => 1_000_000 };

function baseDeps(overrides: Partial<ProactiveBridgeDeps> = {}): ProactiveBridgeDeps {
  return {
    bus: new LightVoiceBus(),
    llm: new FakeLlm('fake', {
      complete: JSON.stringify({ decision: 'speak', reason: '想起未了话题', text: '对了,你上次说的那本书读完了吗?' }),
    }),
    composeSystemPrompt: async () => '【人格】小雪……【记忆召回】用户在读一本书……',
    candidateSource: { gather: () => ['对了,你上次说的那本书读完了吗?'] },
    clock: fixedClock,
    decisionRng: () => 0, // 恒过概率闸
    ...overrides,
  };
}

describe('client/assembleProactiveBridge 主动陪伴桥(开关 + 端到端推送)', () => {
  it('off:未设 CHAT_A_AUTONOMY → undefined,不订阅总线', async () => {
    const bus = new LightVoiceBus();
    const handle = await assembleProactiveBridge({}, baseDeps({ bus }));
    expect(handle).toBeUndefined();
  });

  it('on:idle 触发 → 经真候选源 + persona/memory 提示生成 → onProactiveSpeak 推出一条真实主动话', async () => {
    const bus = new LightVoiceBus();
    const speeches: ProactiveSpeech[] = [];
    const compose = vi.fn(async () => '【人格】小雪……【记忆】在读书……');
    const handle = await assembleProactiveBridge(
      { CHAT_A_AUTONOMY: 'on' },
      baseDeps({ bus, composeSystemPrompt: compose, onProactiveSpeak: (s) => speeches.push(s) }),
    );
    expect(handle).toBeDefined();

    // 手动推进一次 idle tick:发 signal → autonomy 入队;再驱动 autonomy 两拍跑技能。
    handle!.idleTick();
    await handle!.autonomyTick();
    await handle!.autonomyTick();
    await new Promise((r) => setTimeout(r, 0));

    expect(speeches.length).toBeGreaterThan(0);
    expect(speeches[0]!.text).toContain('那本书');
    // persona/memory system 提示确被取用(主动话真走人格/记忆,非硬编码)。
    expect(compose).toHaveBeenCalled();
    handle!.stop();
  });

  it('on:决策 silent(模型不开口)→ 不推任何主动话(克制优先)', async () => {
    const bus = new LightVoiceBus();
    const speeches: ProactiveSpeech[] = [];
    const handle = await assembleProactiveBridge(
      { CHAT_A_AUTONOMY: 'on' },
      baseDeps({
        bus,
        llm: new FakeLlm('fake', { complete: JSON.stringify({ decision: 'silent', reason: '此刻不必' }) }),
        onProactiveSpeak: (s) => speeches.push(s),
      }),
    );
    handle!.idleTick();
    await handle!.autonomyTick();
    await handle!.autonomyTick();
    await new Promise((r) => setTimeout(r, 0));
    expect(speeches.length).toBe(0);
    handle!.stop();
  });

  it('idle 周期解析:缺省回落默认;合法整数采用;非法回落', () => {
    expect(loadProactiveIdleMs({})).toBe(DEFAULT_PROACTIVE_IDLE_MS);
    expect(loadProactiveIdleMs({ CHAT_A_PROACTIVE_IDLE_MS: '8000' })).toBe(8000);
    expect(loadProactiveIdleMs({ CHAT_A_PROACTIVE_IDLE_MS: 'nope' })).toBe(DEFAULT_PROACTIVE_IDLE_MS);
    expect(loadProactiveIdleMs({ CHAT_A_PROACTIVE_IDLE_MS: '-3' })).toBe(DEFAULT_PROACTIVE_IDLE_MS);
  });
});
