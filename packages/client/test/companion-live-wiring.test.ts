import { describe, it, expect, vi } from 'vitest';
import { LightVoiceBus } from '@chat-a/runtime';
import { FakeLlm } from '@chat-a/providers';
import { InMemoryAutonomyDecisionSink } from '@chat-a/autonomy';
import { makeBusEvent } from '@chat-a/protocol';
import type { MemoryRecord } from '@chat-a/memory';
import { assembleAutonomy } from '../src/assembly/autonomy';
import {
  createPresencePort,
  createCompanionCandidateSource,
  type OpenThreadStore,
} from '../src/assembly/memory-autonomy-ports';
import { startVoiceMode } from '../src/cli-voice';

const fixedClock = { now: () => 10_000_000 };

function openThreadRec(text: string): MemoryRecord {
  return {
    id: 1,
    text,
    kind: undefined,
    createdAtMs: 0,
    lastSeenAtMs: fixedClock.now() - 2 * 60 * 60 * 1000, // 2h ago:稳落新鲜度窗(>1h 不急 & <7d 不陈旧)
    hits: 0,
    subject: 'person',
    personId: 'primary',
    openThread: true,
  };
}

describe('companion-live-wiring / 文字路:真候选源喂决策(autonomy on)', () => {
  it('on + FakeLlm(speak) + 未了话题候选源 → 主动 tick 落决策(候选来自真候选源)', async () => {
    const bus = new LightVoiceBus();
    const sink = new InMemoryAutonomyDecisionSink();
    const llm = new FakeLlm('fake-1', {
      complete: JSON.stringify({ decision: 'speak', reason: '值得跟进', text: '那个旅行计划后来呢?' }),
    });
    const store: OpenThreadStore = { openThreads: () => [openThreadRec('上次说的旅行计划')] };
    const presence = createPresencePort({ clock: fixedClock });
    const candidateSource = createCompanionCandidateSource({ store, presence, clock: fixedClock });

    const handle = assembleAutonomy(
      { CHAT_A_AUTONOMY: 'on' },
      { bus, llm, decisionSink: sink, clock: fixedClock, decisionRng: () => 0, candidateSource },
    );
    expect(handle).toBeDefined();

    bus.emit(
      makeBusEvent('signal:perception', { kind: 'temporal:tick', description: 'tick', confidence: 1 }, 'c1'),
    );
    await handle!.tick(); // bringUp
    await handle!.tick(); // skill.tick → 候选 gather → 决策
    await new Promise((r) => setTimeout(r, 0));

    expect(sink.traces.length).toBeGreaterThan(0);
    expect(sink.traces[0]!.decision).toBe('speak');
    handle!.stop();
  });

  it('off(缺省)→ 候选源不被构造也不影响:assembleAutonomy 返回 undefined', () => {
    const bus = new LightVoiceBus();
    const handle = assembleAutonomy({}, { bus, llm: new FakeLlm() });
    expect(handle).toBeUndefined();
  });
});

describe('companion-live-wiring / 语音路:VoiceLoop 真闸 + 抢占接通', () => {
  const baseDeps = () => ({
    send: async (_t: string, onToken: (s: string) => void) => {
      onToken('收到。');
      return '收到。';
    },
    memory: { appendMessage: vi.fn() },
    bus: new LightVoiceBus(),
    sessionId: 'voice-1',
  });

  it('on:startVoiceMode 用 VoiceLoop(暴露 speakState/requestAutonomyPreempt)回调装配钩子', async () => {
    let seenSpeakState: (() => { isSpeaking: boolean }) | undefined;
    let seenPreempt: ((r?: string) => boolean) | undefined;
    const stop = vi.fn();

    const assembleVoiceAutonomy = vi.fn((loop, _bus) => {
      // 钩子拿到的 loop 必须暴露真闸 + 抢占(只读 API)。
      seenSpeakState = () => loop.speakState();
      seenPreempt = (r?: string) => loop.requestAutonomyPreempt(r);
      return { stop };
    });

    const env: NodeJS.ProcessEnv = { CHAT_A_AUDIO_DEVICE: 'fake', CHAT_A_VAD: 'energy' };
    const handle = await startVoiceMode({ ...baseDeps(), env, assembleVoiceAutonomy });

    expect(assembleVoiceAutonomy).toHaveBeenCalledTimes(1);
    // speakState 真闸可读(真 VoiceLoop 初始未说话)
    expect(seenSpeakState!()).toEqual({ isSpeaking: false });
    // preempt 可调用(真 VoiceLoop 未在说时返回 false,不抛)
    expect(typeof seenPreempt!('autonomy_preempt')).toBe('boolean');

    handle.stop();
    expect(stop).toHaveBeenCalled(); // 语音 stop 收尾停 autonomy
  });

  it('off(未传钩子)→ 语音侧不装配 autonomy(逐字不变)', async () => {
    const env: NodeJS.ProcessEnv = { CHAT_A_AUDIO_DEVICE: 'fake', CHAT_A_VAD: 'energy' };
    const handle = await startVoiceMode({ ...baseDeps(), env });
    // 无钩子:正常装配语音,info 反映档位
    expect(handle.info.transport).toBe('inprocess');
    handle.stop();
  });
});
