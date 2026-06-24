import { describe, it, expect } from 'vitest';
import {
  QwenTtsRealtime,
  createTts,
  listTtsKinds,
  loadTtsConfig,
  TTS_SAMPLE_RATE_HZ,
} from '../src/index';
import type { PcmChunk, QwenWsLike, QwenWsFactory, TtsConfig } from '../src/index';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** s16le 样本数组 → base64(模拟服务端 response.audio.delta 的 PCM)。 */
function int16ToBase64(samples: number[]): string {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i] as number, i * 2);
  return buf.toString('base64');
}

type Script = (ws: MockWs) => void;

/** 脚本化 in-memory 假 WS:记录收发,open 后由脚本回放服务端帧。 */
class MockWs implements QwenWsLike {
  readonly sent: unknown[] = [];
  closed = false;
  closeCode: number | undefined;
  readonly #cbs: { [k: string]: ((...args: unknown[]) => void)[] } = {};
  readonly #script: Script;

  constructor(script: Script) {
    this.#script = script;
    // 下一 tick 触发 open(模拟异步连接),让 synthesize 先挂上监听。
    queueMicrotask(() => {
      this.#emit('open');
      this.#script(this);
    });
  }

  send(data: string): void {
    if (this.closed) return;
    this.sent.push(JSON.parse(data));
  }

  close(code?: number): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.#emit('close', code);
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    (this.#cbs[event] ??= []).push(cb);
  }

  /** 测试驱动:回放一帧服务端消息。 */
  serverSend(obj: unknown): void {
    this.#emit('message', JSON.stringify(obj));
  }

  /** 测试驱动:触发连接错误。 */
  serverError(err: unknown): void {
    this.#emit('error', err);
  }

  #emit(event: string, ...args: unknown[]): void {
    for (const cb of this.#cbs[event] ?? []) cb(...args);
  }
}

/** 构造一个注入工厂 + 暴露所建的 MockWs(供断言收发)。 */
function mockFactory(script: Script): { factory: QwenWsFactory; created: MockWs[] } {
  const created: MockWs[] = [];
  const factory: QwenWsFactory = () => {
    const ws = new MockWs(script);
    created.push(ws);
    return ws;
  };
  return { factory, created };
}

function newTts(factory: QwenWsFactory, extra: Record<string, unknown> = {}): QwenTtsRealtime {
  return new QwenTtsRealtime({
    model: 'qwen3-tts-flash-realtime',
    apiKey: 'sk-test',
    voice: 'Cherry',
    wsFactory: factory,
    ...extra,
  });
}

describe('QwenTtsRealtime(注入 mock WS,不触网)', () => {
  it('正常流式:audio.delta×N → response.done → 产对应 PcmChunk(24kHz/mono/Int16)', async () => {
    const { factory } = mockFactory((ws) => {
      ws.serverSend({ type: 'session.created', session: { id: 's1' } });
      ws.serverSend({ type: 'response.audio.delta', delta: int16ToBase64([1, -1]) });
      ws.serverSend({ type: 'response.audio.delta', delta: int16ToBase64([100, -100, 32767]) });
      ws.serverSend({ type: 'response.done' });
    });
    const tts = newTts(factory);
    const chunks = await collect(tts.synthesize('你好'));
    expect(chunks.length).toBe(2);
    const c0 = chunks[0] as PcmChunk;
    expect(c0.sampleRate).toBe(TTS_SAMPLE_RATE_HZ);
    expect(c0.channels).toBe(1);
    expect([...c0.samples]).toEqual([1, -1]);
    expect([...(chunks[1] as PcmChunk).samples]).toEqual([100, -100, 32767]);
  });

  it('握手次序:open 后发 session.update + input_text_buffer.append + session.finish', async () => {
    const { factory, created } = mockFactory((ws) => {
      ws.serverSend({ type: 'response.done' });
    });
    const tts = newTts(factory);
    await collect(tts.synthesize('讲个故事', { voiceId: 'Serena' }));
    const types = created[0]!.sent.map((m) => (m as { type: string }).type);
    expect(types).toContain('session.update');
    expect(types).toContain('input_text_buffer.append');
    expect(types).toContain('session.finish');
    // server_commit 模式默认不发 commit。
    expect(types).not.toContain('input_text_buffer.commit');
    const update = created[0]!.sent.find((m) => (m as { type: string }).type === 'session.update') as {
      session: { voice: string; response_format: string };
    };
    expect(update.session.voice).toBe('Serena'); // voiceId 覆盖默认音色。
    expect(update.session.response_format).toBe('PCM_24000HZ_MONO_16BIT');
    const append = created[0]!.sent.find(
      (m) => (m as { type: string }).type === 'input_text_buffer.append',
    ) as { text: string };
    expect(append.text).toBe('讲个故事');
  });

  it('commit 模式:发显式 input_text_buffer.commit', async () => {
    const { factory, created } = mockFactory((ws) => {
      ws.serverSend({ type: 'response.done' });
    });
    const tts = newTts(factory, { mode: 'commit' });
    await collect(tts.synthesize('一句话'));
    const types = created[0]!.sent.map((m) => (m as { type: string }).type);
    expect(types).toContain('input_text_buffer.commit');
  });

  it('跨帧半样本:奇数字节帧进位到下一帧,不产半样本', async () => {
    // 第一帧 3 字节(1.5 样本),第二帧 1 字节 → 合并成 2 字节 = 1 样本。
    const { factory } = mockFactory((ws) => {
      ws.serverSend({ type: 'response.audio.delta', delta: Buffer.from([0x01, 0x00, 0x02]).toString('base64') });
      ws.serverSend({ type: 'response.audio.delta', delta: Buffer.from([0x00]).toString('base64') });
      ws.serverSend({ type: 'response.done' });
    });
    const tts = newTts(factory);
    const chunks = await collect(tts.synthesize('x'));
    // 第一帧:1 样本(0x0001=1);残留 0x02 + 第二帧 0x00 → 0x0002=2。
    expect(chunks.length).toBe(2);
    expect([...(chunks[0] as PcmChunk).samples]).toEqual([1]);
    expect([...(chunks[1] as PcmChunk).samples]).toEqual([2]);
  });

  it('AbortSignal 中途取消:停止产出 + 发 input_text_buffer.clear + 关 WS', async () => {
    const ac = new AbortController();
    const { factory, created } = mockFactory((ws) => {
      ws.serverSend({ type: 'response.audio.delta', delta: int16ToBase64([5]) });
      // 第一帧后不再回放 done,等测试 abort。
    });
    const tts = newTts(factory);
    const got: PcmChunk[] = [];
    const iter = tts.synthesize('长文本', undefined, ac.signal);
    const p = (async () => {
      for await (const c of iter) {
        got.push(c);
        ac.abort(); // 收到首帧即打断。
      }
    })();
    await p;
    expect(got.length).toBe(1);
    const ws = created[0]!;
    const types = ws.sent.map((m) => (m as { type: string }).type);
    expect(types).toContain('input_text_buffer.clear');
    expect(ws.closed).toBe(true);
  });

  it('进入即已 aborted → 不建连、空产出', async () => {
    const ac = new AbortController();
    ac.abort();
    const { factory, created } = mockFactory(() => {});
    const tts = newTts(factory);
    const chunks = await collect(tts.synthesize('x', undefined, ac.signal));
    expect(chunks).toEqual([]);
    expect(created.length).toBe(0); // 未建连。
  });

  it('优雅降级:服务端 error 事件 → 抛清晰中文错误(不含 key)', async () => {
    const { factory } = mockFactory((ws) => {
      ws.serverSend({ type: 'error', error: { code: 'InvalidApiKey', message: 'auth failed' } });
    });
    const tts = newTts(factory);
    await expect(collect(tts.synthesize('x'))).rejects.toThrow(/服务端 error/);
    await expect(collect(newTts(factory).synthesize('x'))).rejects.not.toThrow(/sk-test/);
  });

  it('优雅降级:WS error 回调 → 抛连接错误', async () => {
    const { factory } = mockFactory((ws) => {
      ws.serverError(new Error('ECONNRESET'));
    });
    const tts = newTts(factory);
    await expect(collect(tts.synthesize('x'))).rejects.toThrow(/WebSocket 连接错误/);
  });

  it('优雅降级:未收齐就 close → 抛"合成完成前关闭"', async () => {
    const { factory } = mockFactory((ws) => {
      ws.serverSend({ type: 'response.audio.delta', delta: int16ToBase64([7]) });
      ws.close(1006);
    });
    const tts = newTts(factory);
    // 首帧能产出,随后 close 触发异常。
    await expect(collect(tts.synthesize('x'))).rejects.toThrow(/合成完成前关闭/);
  });

  it('能力声明:多语种 / 24kHz / 流式 / voiceCloning=false', () => {
    const { factory } = mockFactory(() => {});
    const tts = newTts(factory);
    expect(tts.capabilities).toEqual({
      languages: ['*'],
      voiceId: ['Cherry'],
      sampleRate: TTS_SAMPLE_RATE_HZ,
      streaming: true,
      voiceCloning: false,
    });
  });

  it('能力门:不支持复刻却传 refAudio → fail-fast(不建连)', async () => {
    const { factory, created } = mockFactory(() => {});
    const tts = newTts(factory);
    await expect(
      collect(tts.synthesize('x', { refAudio: { source: '/r.wav' } })),
    ).rejects.toThrow(/不支持音色复刻/);
    expect(created.length).toBe(0);
  });

  it('能力门:限定语种 + 外语种 → fail-fast', async () => {
    const { factory } = mockFactory(() => {});
    const tts = newTts(factory, { languages: ['en'] });
    await expect(collect(tts.synthesize('你好', { language: 'zh' }))).rejects.toThrow(/不支持语种 "zh"/);
  });

  it('缺 apiKey → 构造即 fail-fast(提示环境变量)', () => {
    const { factory } = mockFactory(() => {});
    expect(
      () => new QwenTtsRealtime({ model: 'm', apiKey: '', voice: 'Cherry', wsFactory: factory }),
    ).toThrow(/CHAT_A_DASHSCOPE_API_KEY/);
  });
});

describe('createTts / loadTtsConfig:qwen-tts 工厂与配置', () => {
  it('createTts(kind:qwen-tts, 注入 wsFactory)→ QwenTtsRealtime 并能流式合成', async () => {
    const { factory } = mockFactory((ws) => {
      ws.serverSend({ type: 'response.audio.delta', delta: int16ToBase64([9]) });
      ws.serverSend({ type: 'response.done' });
    });
    const tts = createTts(
      { kind: 'qwen-tts', model: 'qwen3-tts-flash-realtime', apiKey: 'sk-x', voice: 'Cherry' },
      { qwenWsFactory: factory },
    );
    expect(tts).toBeInstanceOf(QwenTtsRealtime);
    const chunks = await collect(tts.synthesize('合成'));
    expect([...(chunks[0] as PcmChunk).samples]).toEqual([9]);
  });

  it('createTts(kind:qwen-tts)缺 apiKey → 明确报错', () => {
    expect(() =>
      createTts({ kind: 'qwen-tts', model: 'm', apiKey: '', voice: 'Cherry' }),
    ).toThrow(/CHAT_A_DASHSCOPE_API_KEY/);
  });

  it('listTtsKinds 含 qwen-tts', () => {
    expect([...listTtsKinds()]).toContain('qwen-tts');
  });

  it('loadTtsConfig:CHAT_A_TTS_KIND=qwen-tts 解析(apiKey 回落 DASHSCOPE)', () => {
    const cfg = loadTtsConfig({
      CHAT_A_TTS_KIND: 'qwen-tts',
      CHAT_A_TTS_MODEL: 'qwen3-tts-flash-realtime',
      CHAT_A_DASHSCOPE_API_KEY: 'sk-dash',
      CHAT_A_TTS_VOICE: 'Chelsie',
      CHAT_A_TTS_MODE: 'commit',
      CHAT_A_TTS_INSTRUCTIONS: '温柔一点',
    });
    expect(cfg).toEqual({
      kind: 'qwen-tts',
      model: 'qwen3-tts-flash-realtime',
      apiKey: 'sk-dash',
      voice: 'Chelsie',
      mode: 'commit',
      instructions: '温柔一点',
    });
  });

  it('loadTtsConfig:CHAT_A_TTS_API_KEY 优先于 DASHSCOPE', () => {
    const cfg = loadTtsConfig({
      CHAT_A_TTS_KIND: 'qwen-tts',
      CHAT_A_TTS_MODEL: 'm',
      CHAT_A_TTS_API_KEY: 'sk-explicit',
      CHAT_A_DASHSCOPE_API_KEY: 'sk-dash',
      CHAT_A_TTS_VOICE: 'Cherry',
    }) as Extract<TtsConfig, { kind: 'qwen-tts' }>;
    expect(cfg.apiKey).toBe('sk-explicit');
  });
});
