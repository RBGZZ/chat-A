import { describe, it, expect } from 'vitest';
import { QwenTtsRealtime, createTts, loadTtsConfig } from '../src/index';
import type { QwenWsLike, QwenWsFactory, TtsConfig } from '../src/index';

async function drain<T>(it: AsyncIterable<T>): Promise<void> {
  for await (const _ of it) {
    /* drain */
  }
}

type Script = (ws: MockWs) => void;

/** 最小脚本化假 WS(open 后回放服务端帧)。 */
class MockWs implements QwenWsLike {
  readonly sent: unknown[] = [];
  closed = false;
  readonly #cbs: { [k: string]: ((...args: unknown[]) => void)[] } = {};
  constructor(script: Script) {
    queueMicrotask(() => {
      this.#emit('open');
      script(this);
    });
  }
  send(data: string): void {
    if (!this.closed) this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
    this.#emit('close');
  }
  on(event: string, cb: (...args: unknown[]) => void): void {
    (this.#cbs[event] ??= []).push(cb);
  }
  serverSend(obj: unknown): void {
    this.#emit('message', JSON.stringify(obj));
  }
  #emit(event: string, ...args: unknown[]): void {
    for (const cb of this.#cbs[event] ?? []) cb(...args);
  }
}

function mockFactory(): { factory: QwenWsFactory; created: MockWs[] } {
  const created: MockWs[] = [];
  const factory: QwenWsFactory = () => {
    const ws = new MockWs((w) => w.serverSend({ type: 'response.done' }));
    created.push(ws);
    return ws;
  };
  return { factory, created };
}

describe('qwen-tts-realtime 复刻音色合成(VC)', () => {
  it('voiceCloning=true 时声明复刻能力位', () => {
    const { factory } = mockFactory();
    const tts = new QwenTtsRealtime({
      model: 'qwen3-tts-vc-realtime',
      apiKey: 'sk-test',
      voice: 'Cherry',
      voiceCloning: true,
      wsFactory: factory,
    });
    expect(tts.capabilities.voiceCloning).toBe(true);
  });

  it('默认(不设 voiceCloning)能力位为 false —— 内置音色路径回归硬线', () => {
    const { factory } = mockFactory();
    const tts = new QwenTtsRealtime({
      model: 'qwen3-tts-flash-realtime',
      apiKey: 'sk-test',
      voice: 'Cherry',
      wsFactory: factory,
    });
    expect(tts.capabilities.voiceCloning).toBe(false);
  });

  it('复刻 voiceId 作为 session.update.voice 透传', async () => {
    const { factory, created } = mockFactory();
    const tts = new QwenTtsRealtime({
      model: 'qwen3-tts-vc-realtime',
      apiKey: 'sk-test',
      voice: 'Cherry',
      voiceCloning: true,
      wsFactory: factory,
    });
    await drain(tts.synthesize('你好', { voiceId: 'qwen-tts-vc-xiaoxue-voice-123' }));
    const update = created[0]!.sent.find((m) => (m as { type: string }).type === 'session.update') as {
      session: { voice: string };
    };
    expect(update.session.voice).toBe('qwen-tts-vc-xiaoxue-voice-123');
  });
});

describe('loadTtsConfig / createTts 复刻能力位', () => {
  it('CHAT_A_TTS_VOICE_CLONING=1 + vc 模型 → config.voiceCloning + provider 能力位', () => {
    const cfg = loadTtsConfig({
      CHAT_A_TTS_KIND: 'qwen-tts',
      CHAT_A_TTS_MODEL: 'qwen3-tts-vc-realtime',
      CHAT_A_TTS_VOICE: 'Cherry',
      CHAT_A_DASHSCOPE_API_KEY: 'sk-test',
      CHAT_A_TTS_VOICE_CLONING: '1',
    } as NodeJS.ProcessEnv);
    expect(cfg.kind).toBe('qwen-tts');
    expect((cfg as Extract<TtsConfig, { kind: 'qwen-tts' }>).voiceCloning).toBe(true);
    const tts = createTts(cfg, { qwenWsFactory: mockFactory().factory });
    expect(tts.capabilities.voiceCloning).toBe(true);
  });

  it('默认不设 CHAT_A_TTS_VOICE_CLONING → config 不带该键(回归:行为不变)', () => {
    const cfg = loadTtsConfig({
      CHAT_A_TTS_KIND: 'qwen-tts',
      CHAT_A_TTS_MODEL: 'qwen3-tts-flash-realtime',
      CHAT_A_TTS_VOICE: 'Cherry',
      CHAT_A_DASHSCOPE_API_KEY: 'sk-test',
    } as NodeJS.ProcessEnv);
    expect('voiceCloning' in cfg).toBe(false);
    const tts = createTts(cfg, { qwenWsFactory: mockFactory().factory });
    expect(tts.capabilities.voiceCloning).toBe(false);
  });
});
