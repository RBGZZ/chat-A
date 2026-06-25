import { describe, it, expect } from 'vitest';
import {
  CosyVoiceTts,
  createTts,
  listTtsKinds,
  loadTtsConfig,
  TTS_SAMPLE_RATE_HZ,
  buildRunTask,
  buildContinueTask,
  buildFinishTask,
  parseTextEvent,
  type PcmChunk,
  type CosyVoiceWsLike,
  type CosyVoiceWsFactory,
  type TtsConfig,
} from '../src/index';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** s16le 样本 → Uint8Array(模拟服务端二进制裸 PCM 帧)。 */
function int16ToBytes(samples: number[]): Uint8Array {
  const buf = new Uint8Array(samples.length * 2);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] as number, true);
  return buf;
}

type Script = (ws: MockWs) => void;

/** 脚本化 in-memory 假 WS:支持回放 JSON 事件帧与二进制音频帧。 */
class MockWs implements CosyVoiceWsLike {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  readonly #cbs: { [k: string]: ((...args: unknown[]) => void)[] } = {};
  readonly #script: Script;

  constructor(script: Script) {
    this.#script = script;
    queueMicrotask(() => {
      this.#emit('open');
      this.#script(this);
    });
  }

  send(data: string): void {
    if (this.closed) return;
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#emit('close', 1000, '');
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    (this.#cbs[event] ??= []).push(cb);
  }

  /** 回放一个 JSON 事件帧(header.event)。 */
  serverEvent(event: string, extra: Record<string, unknown> = {}): void {
    this.#emit('message', JSON.stringify({ header: { event, ...extra }, payload: {} }), false);
  }

  /** 回放一帧二进制音频(带 isBinary=true)。 */
  serverAudio(bytes: Uint8Array): void {
    this.#emit('message', bytes, true);
  }

  /** 回放二进制音频但不带 isBinary 标志(兜底路径)。 */
  serverAudioNoFlag(bytes: Uint8Array): void {
    this.#emit('message', bytes);
  }

  serverError(err: unknown): void {
    this.#emit('error', err);
  }

  sentActions(): string[] {
    return this.sent.map((m) => ((m['header'] as Record<string, unknown>)?.['action'] as string) ?? '');
  }

  #emit(event: string, ...args: unknown[]): void {
    for (const cb of this.#cbs[event] ?? []) cb(...args);
  }
}

function mockFactory(script: Script): { factory: CosyVoiceWsFactory; created: MockWs[] } {
  const created: MockWs[] = [];
  const factory: CosyVoiceWsFactory = () => {
    const ws = new MockWs(script);
    created.push(ws);
    return ws;
  };
  return { factory, created };
}

function newTts(factory: CosyVoiceWsFactory, extra: Record<string, unknown> = {}): CosyVoiceTts {
  return new CosyVoiceTts({
    apiKey: 'sk-test',
    voice: 'cosyvoice-v3.5-flash-xiaoxue-abc',
    wsFactory: factory,
    taskIdFactory: () => 'task-fixed-1',
    ...extra,
  });
}

describe('协议消息构造', () => {
  it('buildRunTask:run-task/duplex/task_group=audio/function=SpeechSynthesizer + parameters', () => {
    const m = buildRunTask('tid', 'cosyvoice-v3.5-flash', {
      voice: 'v',
      format: 'pcm',
      sampleRate: 24000,
    });
    const header = m['header'] as Record<string, unknown>;
    expect(header['action']).toBe('run-task');
    expect(header['task_id']).toBe('tid');
    expect(header['streaming']).toBe('duplex');
    const payload = m['payload'] as Record<string, unknown>;
    expect(payload['task_group']).toBe('audio');
    expect(payload['task']).toBe('tts');
    expect(payload['function']).toBe('SpeechSynthesizer');
    expect(payload['model']).toBe('cosyvoice-v3.5-flash');
    expect(payload['input']).toEqual({});
    const params = payload['parameters'] as Record<string, unknown>;
    expect(params['voice']).toBe('v');
    expect(params['format']).toBe('pcm');
    expect(params['sample_rate']).toBe(24000);
    expect(params['text_type']).toBe('PlainText');
  });

  it('buildContinueTask:input.text;buildFinishTask:input 空', () => {
    expect((buildContinueTask('t', 'hi')['payload'] as Record<string, unknown>)['input']).toEqual({
      text: 'hi',
    });
    expect((buildFinishTask('t')['payload'] as Record<string, unknown>)['input']).toEqual({});
  });

  it('parseTextEvent:JSON header.event → 事件;二进制 PCM → undefined', () => {
    expect(parseTextEvent(JSON.stringify({ header: { event: 'task-started' } }))?.event).toBe(
      'task-started',
    );
    // 纯 PCM 字节通常不是合法 JSON → 非事件。
    expect(parseTextEvent(int16ToBytes([1, 2, 3, 100, -50]))).toBeUndefined();
  });
});

describe('CosyVoiceTts(注入 mock WS,不触网)', () => {
  it('正常流式:task-started → 发 continue/finish → 二进制帧拼成 PcmChunk', async () => {
    const { factory, created } = mockFactory((ws) => {
      ws.serverEvent('task-started');
      ws.serverAudio(int16ToBytes([1, -1]));
      ws.serverAudio(int16ToBytes([100, -100, 32767]));
      ws.serverEvent('task-finished');
    });
    const tts = newTts(factory);
    const chunks = await collect(tts.synthesize('你好'));
    expect(chunks.length).toBe(2);
    const c0 = chunks[0] as PcmChunk;
    expect(c0.sampleRate).toBe(TTS_SAMPLE_RATE_HZ);
    expect(c0.channels).toBe(1);
    expect([...c0.samples]).toEqual([1, -1]);
    expect([...(chunks[1] as PcmChunk).samples]).toEqual([100, -100, 32767]);
    // 握手次序:run-task 先发;task-started 后才发 continue-task + finish-task。
    const actions = created[0]!.sentActions();
    expect(actions).toEqual(['run-task', 'continue-task', 'finish-task']);
    const cont = created[0]!.sent[1]!;
    expect(((cont['payload'] as Record<string, unknown>)['input'] as Record<string, unknown>)['text']).toBe(
      '你好',
    );
  });

  it('情感控制:instruction + enableSsml 进 parameters(单数 instruction / enable_ssml)', async () => {
    const { factory, created } = mockFactory((ws) => {
      ws.serverEvent('task-started');
      ws.serverEvent('task-finished');
    });
    const tts = newTts(factory, { instruction: '语速较快,带明显上扬语调', enableSsml: true });
    await collect(tts.synthesize('x'));
    const params = (created[0]!.sent[0]!['payload'] as Record<string, unknown>)[
      'parameters'
    ] as Record<string, unknown>;
    expect(params['instruction']).toBe('语速较快,带明显上扬语调');
    expect(params['enable_ssml']).toBe(true);
  });

  it('per-call:opts.instruction 覆盖构造期静态 instruction', async () => {
    const { factory, created } = mockFactory((ws) => {
      ws.serverEvent('task-started');
      ws.serverEvent('task-finished');
    });
    const tts = newTts(factory, { instruction: '静态:温柔' });
    await collect(tts.synthesize('x', { instruction: '逐回合:很开心上扬' }));
    const params = (created[0]!.sent[0]!['payload'] as Record<string, unknown>)[
      'parameters'
    ] as Record<string, unknown>;
    expect(params['instruction']).toBe('逐回合:很开心上扬');
  });

  it('per-call:未传 opts.instruction → 回落构造期静态', async () => {
    const { factory, created } = mockFactory((ws) => {
      ws.serverEvent('task-started');
      ws.serverEvent('task-finished');
    });
    const tts = newTts(factory, { instruction: '静态:温柔' });
    await collect(tts.synthesize('x'));
    const params = (created[0]!.sent[0]!['payload'] as Record<string, unknown>)[
      'parameters'
    ] as Record<string, unknown>;
    expect(params['instruction']).toBe('静态:温柔');
  });

  it('回归:不设 instruction/enableSsml → parameters 不含这两键', async () => {
    const { factory, created } = mockFactory((ws) => {
      ws.serverEvent('task-started');
      ws.serverEvent('task-finished');
    });
    await collect(newTts(factory).synthesize('x'));
    const params = (created[0]!.sent[0]!['payload'] as Record<string, unknown>)[
      'parameters'
    ] as Record<string, unknown>;
    expect('instruction' in params).toBe(false);
    expect('enable_ssml' in params).toBe(false);
  });

  it('run-task 用注入的 voiceId 作 parameters.voice', async () => {
    const { factory, created } = mockFactory((ws) => {
      ws.serverEvent('task-started');
      ws.serverEvent('task-finished');
    });
    const tts = newTts(factory);
    await collect(tts.synthesize('x', { voiceId: 'voice-override' }));
    const run = created[0]!.sent[0]!;
    const params = (run['payload'] as Record<string, unknown>)['parameters'] as Record<string, unknown>;
    expect(params['voice']).toBe('voice-override');
  });

  it('二进制帧无 isBinary 标志也能当音频(兜底)', async () => {
    const { factory } = mockFactory((ws) => {
      ws.serverEvent('task-started');
      ws.serverAudioNoFlag(int16ToBytes([7]));
      ws.serverEvent('task-finished');
    });
    const tts = newTts(factory);
    const chunks = await collect(tts.synthesize('x'));
    expect([...(chunks[0] as PcmChunk).samples]).toEqual([7]);
  });

  it('跨帧半样本:奇数字节进位到下一帧', async () => {
    const { factory } = mockFactory((ws) => {
      ws.serverEvent('task-started');
      ws.serverAudio(new Uint8Array([0x01, 0x00, 0x02])); // 1.5 样本
      ws.serverAudio(new Uint8Array([0x00])); // 补齐第 2 样本
      ws.serverEvent('task-finished');
    });
    const tts = newTts(factory);
    const chunks = await collect(tts.synthesize('x'));
    expect([...(chunks[0] as PcmChunk).samples]).toEqual([1]);
    expect([...(chunks[1] as PcmChunk).samples]).toEqual([2]);
  });

  it('task-failed → 抛清晰中文错(含 error_code/message,不含 key)', async () => {
    const { factory } = mockFactory((ws) => {
      ws.serverEvent('task-failed', { error_code: 'InvalidApiKey', error_message: 'auth failed' });
    });
    const tts = newTts(factory);
    await expect(collect(tts.synthesize('x'))).rejects.toThrow(/task-failed/);
    await expect(collect(newTts(factory).synthesize('x'))).rejects.not.toThrow(/sk-test/);
  });

  it('WS error → 抛连接错误', async () => {
    const { factory } = mockFactory((ws) => {
      ws.serverError(new Error('ECONNRESET'));
    });
    await expect(collect(newTts(factory).synthesize('x'))).rejects.toThrow(/WebSocket 连接错误/);
  });

  it('未收齐就 close → 抛"合成完成前关闭"', async () => {
    const { factory } = mockFactory((ws) => {
      ws.serverEvent('task-started');
      ws.serverAudio(int16ToBytes([5]));
      ws.close();
    });
    await expect(collect(newTts(factory).synthesize('x'))).rejects.toThrow(/合成完成前关闭/);
  });

  it('AbortSignal 中途取消:停止 + 发 finish-task + 关 WS', async () => {
    const ac = new AbortController();
    const { factory, created } = mockFactory((ws) => {
      ws.serverEvent('task-started');
      ws.serverAudio(int16ToBytes([5]));
      // 不发 finished,等 abort。
    });
    const tts = newTts(factory);
    const got: PcmChunk[] = [];
    for await (const c of tts.synthesize('长文本', undefined, ac.signal)) {
      got.push(c);
      ac.abort();
    }
    expect(got.length).toBe(1);
    expect(created[0]!.closed).toBe(true);
    expect(created[0]!.sentActions()).toContain('finish-task');
  });

  it('进入即已 aborted → 不建连、空产出', async () => {
    const ac = new AbortController();
    ac.abort();
    const { factory, created } = mockFactory(() => {});
    const chunks = await collect(newTts(factory).synthesize('x', undefined, ac.signal));
    expect(chunks).toEqual([]);
    expect(created.length).toBe(0);
  });

  it('缺 voiceId(无系统音色)→ fail-fast 不建连', async () => {
    const { factory, created } = mockFactory(() => {});
    const tts = new CosyVoiceTts({ apiKey: 'sk-test', wsFactory: factory });
    await expect(collect(tts.synthesize('x'))).rejects.toThrow(/voiceId/);
    expect(created.length).toBe(0);
  });

  it('能力声明:voiceCloning=true / 流式 / 无 voiceId 列表', () => {
    const { factory } = mockFactory(() => {});
    const tts = newTts(factory);
    expect(tts.capabilities.voiceCloning).toBe(true);
    expect(tts.capabilities.streaming).toBe(true);
    expect(tts.capabilities.sampleRate).toBe(TTS_SAMPLE_RATE_HZ);
    expect(tts.capabilities.voiceId).toBeUndefined();
  });

  it('缺 apiKey → 构造即 fail-fast', () => {
    const { factory } = mockFactory(() => {});
    expect(() => new CosyVoiceTts({ apiKey: '', wsFactory: factory })).toThrow(
      /CHAT_A_DASHSCOPE_API_KEY/,
    );
  });
});

describe('createTts / loadTtsConfig:cosyvoice', () => {
  it('createTts(kind:cosyvoice, 注入 wsFactory)→ CosyVoiceTts 并能流式合成', async () => {
    const { factory } = mockFactory((ws) => {
      ws.serverEvent('task-started');
      ws.serverAudio(int16ToBytes([9]));
      ws.serverEvent('task-finished');
    });
    const tts = createTts(
      { kind: 'cosyvoice', apiKey: 'sk-x', voice: 'v-clone' },
      { cosyVoiceWsFactory: factory },
    );
    expect(tts).toBeInstanceOf(CosyVoiceTts);
    const chunks = await collect(tts.synthesize('合成'));
    expect([...(chunks[0] as PcmChunk).samples]).toEqual([9]);
  });

  it('createTts(kind:cosyvoice)缺 apiKey → 明确报错', () => {
    expect(() => createTts({ kind: 'cosyvoice', apiKey: '' })).toThrow(/CHAT_A_DASHSCOPE_API_KEY/);
  });

  it('listTtsKinds 含 cosyvoice', () => {
    expect([...listTtsKinds()]).toContain('cosyvoice');
  });

  it('loadTtsConfig:CHAT_A_TTS_KIND=cosyvoice 解析(apiKey 回落 DASHSCOPE)', () => {
    const cfg = loadTtsConfig({
      CHAT_A_TTS_KIND: 'cosyvoice',
      CHAT_A_TTS_MODEL: 'cosyvoice-v3.5-flash',
      CHAT_A_DASHSCOPE_API_KEY: 'sk-dash',
      CHAT_A_VOICE_ID: 'ignored-here',
      CHAT_A_TTS_VOICE: 'v-clone',
    }) as Extract<TtsConfig, { kind: 'cosyvoice' }>;
    expect(cfg.kind).toBe('cosyvoice');
    expect(cfg.apiKey).toBe('sk-dash');
    expect(cfg.model).toBe('cosyvoice-v3.5-flash');
    expect(cfg.voice).toBe('v-clone');
  });

  it('loadTtsConfig:CHAT_A_TTS_INSTRUCTION / CHAT_A_TTS_ENABLE_SSML 解析', () => {
    const cfg = loadTtsConfig({
      CHAT_A_TTS_KIND: 'cosyvoice',
      CHAT_A_DASHSCOPE_API_KEY: 'sk-dash',
      CHAT_A_TTS_INSTRUCTION: '低沉一点,慢一些',
      CHAT_A_TTS_ENABLE_SSML: '1',
    }) as Extract<TtsConfig, { kind: 'cosyvoice' }>;
    expect(cfg.instruction).toBe('低沉一点,慢一些');
    expect(cfg.enableSsml).toBe(true);
  });
});
