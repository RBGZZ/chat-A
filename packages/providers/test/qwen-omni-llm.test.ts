import { describe, it, expect } from 'vitest';
import {
  QwenOmniLlm,
  createLlm,
  listLlmProviders,
  QWEN_DASHSCOPE_REALTIME_URL,
} from '../src/index';
import type { OmniEvent, OmniWsLike, OmniWsFactory } from '../src/qwen-omni-llm';
import type { PcmChunk } from '../src/audio';

/**
 * FakeWs:同步驱动的 mock WebSocket(不触网)。
 * - 记录构造 url/headers 与所有 send 出的 JSON 帧;
 * - `emitOpen()` / `emitMessage(obj)` / `emitError(e)` / `emitClose(code)` 由测试驱动;
 * - `script` 钩子:每次收到某类型客户端帧后,自动回放服务端事件,模拟 DashScope 时序。
 */
class FakeWs implements OmniWsLike {
  static last: FakeWs | undefined;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;

  #handlers: { open?: () => void; message?: (d: unknown) => void; error?: (e: unknown) => void; close?: (c?: number) => void } =
    {};
  /** 收到某 type 的客户端帧后自动触发的服务端回放(测试装配)。 */
  onClientSend?: (frame: Record<string, unknown>, ws: FakeWs) => void;

  constructor(url: string, headers: Record<string, string>) {
    this.url = url;
    this.headers = headers;
    FakeWs.last = this;
  }

  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'error', cb: (err: unknown) => void): void;
  on(event: 'close', cb: (code?: number) => void): void;
  on(event: string, cb: (...args: never[]) => void): void {
    (this.#handlers as Record<string, unknown>)[event] = cb;
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    this.onClientSend?.(frame, this);
  }

  close(): void {
    this.closed = true;
  }

  // ── 测试驱动 ──
  emitOpen(): void {
    this.#handlers.open?.();
  }
  emitMessage(obj: unknown): void {
    this.#handlers.message?.(JSON.stringify(obj));
  }
  emitError(err: unknown): void {
    this.#handlers.error?.(err);
  }
  emitClose(code?: number): void {
    this.#handlers.close?.(code);
  }
  /** 取已 send 帧里某 type 的第一帧。 */
  sentOf(type: string): Record<string, unknown> | undefined {
    return this.sent.find((f) => f['type'] === type);
  }
}

function makeFactory(): { factory: OmniWsFactory; ws: () => FakeWs } {
  let created: FakeWs | undefined;
  const factory: OmniWsFactory = (url, opts) => {
    created = new FakeWs(url, opts.headers);
    return created;
  };
  return { factory, ws: () => created as FakeWs };
}

function makeOmni(over: Partial<ConstructorParameters<typeof QwenOmniLlm>[0]> = {}): {
  llm: QwenOmniLlm;
  ws: () => FakeWs;
} {
  const { factory, ws } = makeFactory();
  const llm = new QwenOmniLlm({
    id: 'qwen-omni',
    model: 'qwen3.5-omni-flash-realtime',
    apiKey: 'sk-test',
    baseURL: QWEN_DASHSCOPE_REALTIME_URL,
    wsFactory: factory,
    ...over,
  });
  return { llm, ws };
}

async function collectEvents(stream: AsyncIterable<OmniEvent>): Promise<OmniEvent[]> {
  const out: OmniEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

function pcm(samples: number[], sampleRate = 16000): PcmChunk {
  return { samples: Int16Array.from(samples), sampleRate, channels: 1 };
}

describe('QwenOmniLlm / 文本兼容面 stream', () => {
  it('建连→session.created→发 session.update(text)+文本项+response.create,聚合 text.delta', async () => {
    const { llm, ws } = makeOmni();
    // 服务端时序:open 后我们手动 emit session.created;Provider 据此发数据;然后回 delta + done。
    const stream = llm.stream({ system: '你是小雪', messages: [{ role: 'user', content: '你好呀' }] });
    const iter = (async () => {
      const out: string[] = [];
      for await (const t of stream) out.push(t);
      return out;
    })();

    // 驱动 WS 时序(microtask 让生成器先挂上监听)。
    await Promise.resolve();
    const w = ws();
    w.emitOpen();
    w.emitMessage({ type: 'session.created' });
    // 此时 Provider 应已发出 session.update / conversation.item.create / response.create
    w.emitMessage({ type: 'response.text.delta', delta: '你' });
    w.emitMessage({ type: 'response.text.delta', delta: '好' });
    w.emitMessage({ type: 'response.done' });

    const tokens = await iter;
    expect(tokens.join('')).toBe('你好');

    // 断言请求帧
    const upd = w.sentOf('session.update');
    expect((upd?.['session'] as { modalities?: unknown }).modalities).toEqual(['text']);
    const item = w.sentOf('conversation.item.create');
    const content = (item?.['item'] as { content?: Array<{ type: string; text: string }> }).content;
    expect(content?.[0]).toEqual({ type: 'input_text', text: '你好呀' });
    expect(w.sentOf('response.create')).toBeDefined();
    // 鉴权 header 带上,但只在 headers,不泄进帧体
    expect(w.headers['Authorization']).toBe('Bearer sk-test');
    // URL 带 ?model=
    expect(w.url).toContain(`?model=${encodeURIComponent('qwen3.5-omni-flash-realtime')}`);
    expect(w.closed).toBe(true); // done 后关 WS
  });

  it('complete 聚合为整串', async () => {
    const { llm, ws } = makeOmni();
    const p = llm.complete({ system: '', messages: [{ role: 'user', content: 'hi' }] });
    await Promise.resolve();
    const w = ws();
    w.emitOpen();
    w.emitMessage({ type: 'session.created' });
    w.emitMessage({ type: 'response.text.delta', delta: 'A' });
    w.emitMessage({ type: 'response.text.delta', delta: 'B' });
    w.emitMessage({ type: 'response.completed' });
    expect(await p).toBe('AB');
  });
});

describe('QwenOmniLlm / 真多模态面 respondToAudio', () => {
  it('喂 PCM → input_audio_buffer.append(base64);收 transcript + text + end', async () => {
    const { llm, ws } = makeOmni();
    async function* audio(): AsyncIterable<PcmChunk> {
      yield pcm([1, 2, 3]);
      yield pcm([4, 5]);
    }
    const evPromise = collectEvents(llm.respondToAudio(audio()));
    await Promise.resolve();
    const w = ws();
    w.emitOpen();
    w.emitMessage({ type: 'session.created' });
    // session.created 后 Provider 开始 pump 音频(异步)。等几个 microtask 让 append 发出。
    await new Promise((r) => setTimeout(r, 0));
    w.emitMessage({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: '今天天气不错',
    });
    w.emitMessage({ type: 'response.text.delta', delta: '是' });
    w.emitMessage({ type: 'response.text.delta', delta: '呢' });
    w.emitMessage({ type: 'response.done' });

    const events = await evPromise;
    expect(events).toEqual([
      { type: 'transcript', text: '今天天气不错' },
      { type: 'text', text: '是' },
      { type: 'text', text: '呢' },
      { type: 'end' },
    ]);

    // 音频被 base64 送出(至少一帧 append),且 session.update 用 server_vad。
    const appends = w.sent.filter((f) => f['type'] === 'input_audio_buffer.append');
    expect(appends.length).toBeGreaterThanOrEqual(2);
    expect(typeof appends[0]?.['audio']).toBe('string');
    const upd = w.sentOf('session.update');
    expect((upd?.['session'] as { turn_detection?: { type?: string } }).turn_detection?.type).toBe('server_vad');
  });
});

describe('QwenOmniLlm / AbortSignal 真取消', () => {
  it('已 abort → fail-fast 不建连', async () => {
    const { llm, ws } = makeOmni();
    const ac = new AbortController();
    ac.abort();
    await expect(
      (async () => {
        for await (const _ of llm.stream({ system: '', messages: [{ role: 'user', content: 'x' }] }, ac.signal)) {
          /* noop */
        }
      })(),
    ).rejects.toThrow(/abort/i);
    expect(ws()).toBeUndefined(); // 未建连
  });

  it('流式中 abort → 关 WS、生成器终止(不再 yield)', async () => {
    const { llm, ws } = makeOmni();
    const ac = new AbortController();
    const collected: string[] = [];
    const run = (async () => {
      try {
        for await (const t of llm.stream(
          { system: '', messages: [{ role: 'user', content: 'x' }] },
          ac.signal,
        )) {
          collected.push(t);
        }
      } catch (err) {
        return err;
      }
      return undefined;
    })();

    await Promise.resolve();
    const w = ws();
    w.emitOpen();
    w.emitMessage({ type: 'session.created' });
    w.emitMessage({ type: 'response.text.delta', delta: '半' });
    await new Promise((r) => setTimeout(r, 0));
    ac.abort(); // 中途打断
    const err = await run;
    expect(collected).toEqual(['半']); // abort 前的已收
    expect(w.closed).toBe(true); // WS 被关
    expect((err as Error)?.name === 'AbortError' || /abort/i.test(String(err))).toBe(true);
  });
});

describe('QwenOmniLlm / 错误降级', () => {
  it('error 事件 → 抛清晰错误(供上层 catch 降级)', async () => {
    const { llm, ws } = makeOmni();
    const run = (async () => {
      for await (const _ of llm.stream({ system: '', messages: [{ role: 'user', content: 'x' }] })) {
        /* noop */
      }
    })();
    await Promise.resolve();
    const w = ws();
    w.emitOpen();
    w.emitMessage({ type: 'session.created' });
    w.emitMessage({ type: 'error', error: { code: 'InvalidApiKey', message: '鉴权失败' } });
    await expect(run).rejects.toThrow(/qwen-omni 服务端错误.*鉴权失败|InvalidApiKey/);
    expect(w.closed).toBe(true);
  });

  it('WS error(连接层) → 抛清晰错误', async () => {
    const { llm, ws } = makeOmni();
    const run = (async () => {
      for await (const _ of llm.stream({ system: '', messages: [{ role: 'user', content: 'x' }] })) {
        /* noop */
      }
    })();
    await Promise.resolve();
    const w = ws();
    w.emitError(new Error('ECONNREFUSED'));
    await expect(run).rejects.toThrow(/qwen-omni WS 连接错误.*ECONNREFUSED/);
  });

  it('意外 close(未 done 就关) → 抛错', async () => {
    const { llm, ws } = makeOmni();
    const run = (async () => {
      for await (const _ of llm.stream({ system: '', messages: [{ role: 'user', content: 'x' }] })) {
        /* noop */
      }
    })();
    await Promise.resolve();
    const w = ws();
    w.emitOpen();
    w.emitMessage({ type: 'session.created' });
    w.emitClose(1006);
    await expect(run).rejects.toThrow(/qwen-omni WS 意外关闭/);
  });
});

describe('providers/registry(qwen-omni 装配)', () => {
  it('qwen-omni 已登记,与纯文本 qwen 区分', () => {
    expect(listLlmProviders()).toContain('qwen-omni');
    expect(listLlmProviders()).toContain('qwen');
  });

  it('createLlm(qwen-omni) 返回 QwenOmniLlm,id=qwen-omni,baseURL=realtime 端点', () => {
    const llm = createLlm({ provider: 'qwen-omni', model: 'qwen3.5-omni-flash-realtime', apiKey: 'sk-x' });
    expect(llm).toBeInstanceOf(QwenOmniLlm);
    expect(llm.id).toBe('qwen-omni');
    expect((llm as QwenOmniLlm).baseURL).toBe(QWEN_DASHSCOPE_REALTIME_URL);
    expect(llm.supportsTools).toBe(false);
  });

  it('缺 apiKey 抛清晰错误', () => {
    expect(() => createLlm({ provider: 'qwen-omni', model: 'm' })).toThrow(/qwen-omni/);
    expect(() => createLlm({ provider: 'qwen-omni', model: 'm' })).toThrow(
      /API key|CHAT_A_LLM_API_KEY|DASHSCOPE/,
    );
    expect(() => createLlm({ provider: 'qwen-omni', model: 'm', apiKey: '' })).toThrow(
      /API key|CHAT_A_LLM_API_KEY|DASHSCOPE/,
    );
  });

  it('baseURL 可覆盖(去尾随斜杠)', () => {
    const llm = createLlm({
      provider: 'qwen-omni',
      model: 'm',
      apiKey: 'sk-x',
      baseURL: 'wss://self-hosted/realtime/',
    });
    expect((llm as QwenOmniLlm).baseURL).toBe('wss://self-hosted/realtime');
  });
});
