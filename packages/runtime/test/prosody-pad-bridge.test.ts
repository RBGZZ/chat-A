import { describe, it, expect, vi } from 'vitest';
import {
  InProcessAudioTransport,
  makeDataFrame,
  SAMPLE_RATE_HZ,
  CHANNELS,
  type AudioFrame,
  type PcmFrame,
} from '@chat-a/protocol';
import { StubVadDetector, TurnDetector, StubEouModel } from '@chat-a/voice-detect';
import { FakeStt, FakeTts, FakeLlm } from '@chat-a/providers';
import { InMemoryPersonaStore } from '@chat-a/persona';
import type { Pad, SttEmotionLike } from '@chat-a/persona';
import { LightVoiceBus } from '../src/bus';
import { Conversation, type TurnContext, type TurnStrategy } from '../src/conversation';
import { ToolCallingStrategy } from '../src/tool-calling-strategy';
import { VoiceLoop, type VoiceLoopDeps } from '../src/voice-loop';

// ───────────────────────────── §2 线程穿透:send → ctx.prosodyEmotion ─────────────────────────────

describe('runtime/prosody-pad-bridge:Conversation.send 透传 prosodyEmotion 进 TurnContext', () => {
  /** 自定义策略捕获 ctx,断言 send 第 4 参填入 ctx.prosodyEmotion。 */
  function captureStrategy(): { strategy: TurnStrategy; seen: TurnContext[] } {
    const seen: TurnContext[] = [];
    const strategy: TurnStrategy = {
      async run(ctx) {
        seen.push(ctx);
        ctx.onToken('ok');
        return 'ok';
      },
    };
    return { strategy, seen };
  }

  it('传 prosodyEmotion → ctx.prosodyEmotion 为同一值', async () => {
    const bus = new LightVoiceBus();
    const { strategy, seen } = captureStrategy();
    const convo = new Conversation({ bus, llm: new FakeLlm(), strategy, sessionId: 's1' });
    const emotion: SttEmotionLike = { label: 'sad', confidence: 0.8 };
    await convo.send('你好', () => {}, undefined, emotion);
    expect(seen[0]?.prosodyEmotion).toEqual(emotion);
  });

  it('不传 prosodyEmotion → ctx.prosodyEmotion 为 undefined(向后兼容)', async () => {
    const bus = new LightVoiceBus();
    const { strategy, seen } = captureStrategy();
    const convo = new Conversation({ bus, llm: new FakeLlm(), strategy, sessionId: 's1' });
    await convo.send('你好', () => {});
    expect(seen[0]?.prosodyEmotion).toBeUndefined();
  });
});

// ───────────────────── §1+§2 端到端:prosody 经 finalizeTurn → persona.advance 影响 PAD ─────────────────────

describe('runtime/prosody-pad-bridge:prosody 经回合收尾并入 PAD(两策略零漂移)', () => {
  /** 注入 InMemoryPersonaStore,回合后从 load() 读持久化 PAD(经既有公共接缝,不窥探内部)。 */
  function padAfter(store: InMemoryPersonaStore): Pad {
    const snap = store.load();
    if (snap === null) throw new Error('回合后 persona 快照应已落盘');
    return snap.pad;
  }

  it('SingleShot:sad prosody → 持久化 PAD pleasure 低于不传(语音真实影响心情)', async () => {
    const storeWith = new InMemoryPersonaStore();
    const storeWithout = new InMemoryPersonaStore();
    const withProsody = new Conversation({ bus: new LightVoiceBus(), llm: new FakeLlm(), personaStore: storeWith, sessionId: 'a' });
    const without = new Conversation({ bus: new LightVoiceBus(), llm: new FakeLlm(), personaStore: storeWithout, sessionId: 'b' });
    await withProsody.send('随便说点', () => {}, undefined, { label: 'sad' });
    await without.send('随便说点', () => {});
    expect(padAfter(storeWith).pleasure).toBeLessThan(padAfter(storeWithout).pleasure);
  });

  it('SingleShot:不传 prosody → 与现状逐字一致(纯加法回归)', async () => {
    const sa = new InMemoryPersonaStore();
    const sb = new InMemoryPersonaStore();
    const a = new Conversation({ bus: new LightVoiceBus(), llm: new FakeLlm(), personaStore: sa, sessionId: 'a' });
    const b = new Conversation({ bus: new LightVoiceBus(), llm: new FakeLlm(), personaStore: sb, sessionId: 'b' });
    await a.send('随便说点', () => {});
    await b.send('随便说点', () => {});
    expect(padAfter(sa)).toEqual(padAfter(sb));
  });

  it('ToolCalling(降级回 SingleShot,FakeLlm 无工具):同样把 prosody 并入 PAD', async () => {
    const registry = { toolDefs: () => [], execute: async () => ({}) } as never;
    const storeWith = new InMemoryPersonaStore();
    const storeWithout = new InMemoryPersonaStore();
    const withProsody = new Conversation({
      bus: new LightVoiceBus(),
      llm: new FakeLlm(),
      strategy: new ToolCallingStrategy({ registry }),
      personaStore: storeWith,
      sessionId: 'a',
    });
    const without = new Conversation({
      bus: new LightVoiceBus(),
      llm: new FakeLlm(),
      strategy: new ToolCallingStrategy({ registry }),
      personaStore: storeWithout,
      sessionId: 'b',
    });
    await withProsody.send('随便说点', () => {}, undefined, { label: 'sad' });
    await without.send('随便说点', () => {});
    expect(padAfter(storeWith).pleasure).toBeLessThan(padAfter(storeWithout).pleasure);
  });
});

// ───────────────────────────── §3 voice-loop 捕获 STT 情绪并透传给 send ─────────────────────────────

function micFrame(timestampMs: number): AudioFrame {
  const pcm: PcmFrame = {
    samples: new Int16Array(160),
    sampleRate: SAMPLE_RATE_HZ,
    channels: CHANNELS,
    timestampMs,
  };
  return makeDataFrame('audio:input', {
    audio: pcm,
    format: { sampleRate: SAMPLE_RATE_HZ, channels: CHANNELS, sampleFormat: 's16le' },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

async function driveSpeechThenSilence(transport: InProcessAudioTransport): Promise<void> {
  transport.sendAudio(micFrame(0));
  transport.sendAudio(micFrame(10));
  transport.sendAudio(micFrame(20));
  transport.sendAudio(micFrame(30));
  transport.sendAudio(micFrame(40));
  transport.sendAudio(micFrame(50));
  transport.sendAudio(micFrame(10_050));
  await flush();
}

function makeVoiceDeps(over: Partial<VoiceLoopDeps>): {
  deps: VoiceLoopDeps;
  transport: InProcessAudioTransport;
} {
  const transport = new InProcessAudioTransport();
  const bus = new LightVoiceBus();
  const deps: VoiceLoopDeps = {
    transport,
    vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.0]),
    turnDetector: new TurnDetector(new StubEouModel([0.9])),
    stt: new FakeStt({ script: [{ text: '你好小雪', isFinal: true }] }),
    tts: new FakeTts({ samplesPerChar: 4 }),
    send: async (_t, onToken) => {
      onToken('回应');
      return '回应';
    },
    memory: { appendMessage: vi.fn() },
    bus,
    sessionId: 's1',
    clock: () => 1000,
    ...over,
  };
  return { deps, transport };
}

describe('runtime/prosody-pad-bridge:VoiceLoop STT 路把 emotion 透传进 #send', () => {
  it('STT 结果带 emotion → send 第 4 参收到该 emotion', async () => {
    const sendArgs: { text: string; emotion?: SttEmotionLike }[] = [];
    const { deps, transport } = makeVoiceDeps({
      stt: new FakeStt({ script: [{ text: '你好小雪', isFinal: true, emotion: { label: 'happy', confidence: 0.9 } }] }),
      send: async (text, onToken, _signal, prosodyEmotion) => {
        sendArgs.push({ text, ...(prosodyEmotion ? { emotion: prosodyEmotion } : {}) });
        onToken('回应');
        return '回应';
      },
    });
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveSpeechThenSilence(transport);
    expect(sendArgs[0]?.text).toBe('你好小雪');
    expect(sendArgs[0]?.emotion).toEqual({ label: 'happy', confidence: 0.9 });
  });

  it('STT 结果无 emotion → send 第 4 参为 undefined(既有 provider 行为不变)', async () => {
    let captured: SttEmotionLike | undefined = { label: 'sentinel' };
    const { deps, transport } = makeVoiceDeps({
      stt: new FakeStt({ script: [{ text: '你好小雪', isFinal: true }] }),
      send: async (_text, onToken, _signal, prosodyEmotion) => {
        captured = prosodyEmotion;
        onToken('回应');
        return '回应';
      },
    });
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveSpeechThenSilence(transport);
    expect(captured).toBeUndefined();
  });
});
