import { describe, it, expect } from 'vitest';
import { QwenOmniLlm, QWEN_DASHSCOPE_REALTIME_URL } from '../src/index';
import type { OmniEvent, OmniWsLike, OmniWsFactory } from '../src/qwen-omni-llm';
import type { PcmChunk } from '../src/audio';

/**
 * FakeWs:同步驱动的 mock WebSocket(不触网)。
 * - 记录构造 url/headers 与所有 send 出的 JSON 帧;
 * - `emitOpen()` / `emitMessage(obj)` / `emitError(e)` / `emitClose(code)` 由测试驱动。
 */
class FakeWs implements OmniWsLike {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;

  #handlers: {
    open?: () => void;
    message?: (d: unknown) => void;
    error?: (e: unknown) => void;
    close?: (c?: number) => void;
  } = {};

  constructor(url: string, headers: Record<string, string>) {
    this.url = url;
    this.headers = headers;
  }

  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'error', cb: (err: unknown) => void): void;
  on(event: 'close', cb: (code?: number) => void): void;
  on(event: string, cb: (...args: never[]) => void): void {
    (this.#handlers as Record<string, unknown>)[event] = cb;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
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

function makeFactory(): { factory: OmniWsFactory; ws: () => FakeWs | undefined } {
  let created: FakeWs | undefined;
  const factory: OmniWsFactory = (url, opts) => {
    created = new FakeWs(url, opts.headers);
    return created;
  };
  return { factory, ws: () => created };
}

function makeOmni(over: Partial<ConstructorParameters<typeof QwenOmniLlm>[0]> = {}): {
  llm: QwenOmniLlm;
  ws: () => FakeWs | undefined;
} {
  const { factory, ws } = makeFactory();
  const llm = new QwenOmniLlm({
    id: 'qwen-omni',
    model: 'qwen3-omni-flash-realtime',
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

async function* audioOf(...chunks: PcmChunk[]): AsyncIterable<PcmChunk> {
  for (const c of chunks) yield c;
}

describe('QwenOmniLlm / 构造', () => {
  it('id/model 透传;baseURL 去尾随斜杠', () => {
    const { llm } = makeOmni({ baseURL: 'wss://self-hosted/realtime/' });
    expect(llm.id).toBe('qwen-omni');
    expect(llm.model).toBe('qwen3-omni-flash-realtime');
    expect(llm.baseURL).toBe('wss://self-hosted/realtime');
  });

  it('不再实现 LlmProvider(无 stream/complete)——音频面专用', () => {
    const { llm } = makeOmni();
    expect((llm as unknown as { stream?: unknown }).stream).toBeUndefined();
    expect((llm as unknown as { complete?: unknown }).complete).toBeUndefined();
    expect(typeof llm.respondToAudio).toBe('function');
  });
});

describe('QwenOmniLlm / respondToAudio(audio-in → 文本流)', () => {
  it('manual 默认:turn_detection=null;送完发 commit+response.create;收 transcript+text+end', async () => {
    const { llm, ws } = makeOmni();
    const evPromise = collectEvents(llm.respondToAudio(audioOf(pcm([1, 2, 3]), pcm([4, 5]))));
    await Promise.resolve();
    const w = ws() as FakeWs;
    w.emitOpen();
    w.emitMessage({ type: 'session.created' });
    // session.created 后开始 pump 音频(异步)。等一个宏任务让 append+commit+response.create 发出。
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

    // 音频被 base64 送出(至少两帧 append)。
    const appends = w.sent.filter((f) => f['type'] === 'input_audio_buffer.append');
    expect(appends.length).toBeGreaterThanOrEqual(2);
    expect(typeof appends[0]?.['audio']).toBe('string');
    // manual 模式:turn_detection=null + 显式 commit + response.create。
    const upd = w.sentOf('session.update');
    expect((upd?.['session'] as { turn_detection?: unknown }).turn_detection).toBeNull();
    expect((upd?.['session'] as { modalities?: unknown }).modalities).toEqual(['text']);
    expect((upd?.['session'] as { input_audio_format?: unknown }).input_audio_format).toBe('pcm');
    expect(w.sentOf('input_audio_buffer.commit')).toBeDefined();
    expect(w.sentOf('response.create')).toBeDefined();
    // 鉴权只在 header,URL 带 ?model=。
    expect(w.headers['Authorization']).toBe('Bearer sk-test');
    expect(w.url).toContain(`?model=${encodeURIComponent('qwen3-omni-flash-realtime')}`);
    expect(w.closed).toBe(true);
  });

  it('server_vad 模式:turn_detection=server_vad;不发手动 commit/response.create', async () => {
    const { llm, ws } = makeOmni();
    const evPromise = collectEvents(
      llm.respondToAudio(audioOf(pcm([1, 2])), { turnDetection: 'server_vad' }),
    );
    await Promise.resolve();
    const w = ws() as FakeWs;
    w.emitOpen();
    w.emitMessage({ type: 'session.created' });
    await new Promise((r) => setTimeout(r, 0));
    w.emitMessage({ type: 'response.text.delta', delta: '好' });
    w.emitMessage({ type: 'response.done' });

    const events = await evPromise;
    expect(events).toEqual([{ type: 'text', text: '好' }, { type: 'end' }]);

    const upd = w.sentOf('session.update');
    expect((upd?.['session'] as { turn_detection?: { type?: string } }).turn_detection?.type).toBe('server_vad');
    // server_vad 自动触发:不发手动 commit/response.create(避免冲突)。
    expect(w.sentOf('input_audio_buffer.commit')).toBeUndefined();
    expect(w.sentOf('response.create')).toBeUndefined();
  });

  it('instructions 映射 session.instructions', async () => {
    const { llm, ws } = makeOmni();
    const evPromise = collectEvents(llm.respondToAudio(audioOf(pcm([1])), { instructions: '你是小雪' }));
    await Promise.resolve();
    const w = ws() as FakeWs;
    w.emitOpen();
    w.emitMessage({ type: 'session.created' });
    await new Promise((r) => setTimeout(r, 0));
    w.emitMessage({ type: 'response.done' });
    await evPromise;
    const upd = w.sentOf('session.update');
    expect((upd?.['session'] as { instructions?: string }).instructions).toBe('你是小雪');
  });
});

describe('QwenOmniLlm / AbortSignal 真取消', () => {
  it('已 abort → fail-fast 不建连', async () => {
    const { llm, ws } = makeOmni();
    const ac = new AbortController();
    ac.abort();
    await expect(collectEvents(llm.respondToAudio(audioOf(pcm([1])), undefined, ac.signal))).rejects.toThrow(
      /abort/i,
    );
    expect(ws()).toBeUndefined(); // 未建连
  });

  it('流式中 abort → 关 WS、生成器终止(不再 yield)', async () => {
    const { llm, ws } = makeOmni();
    const ac = new AbortController();
    const collected: OmniEvent[] = [];
    const run = (async () => {
      try {
        for await (const e of llm.respondToAudio(audioOf(pcm([1])), undefined, ac.signal)) {
          collected.push(e);
        }
      } catch (err) {
        return err;
      }
      return undefined;
    })();

    await Promise.resolve();
    const w = ws() as FakeWs;
    w.emitOpen();
    w.emitMessage({ type: 'session.created' });
    w.emitMessage({ type: 'response.text.delta', delta: '半' });
    await new Promise((r) => setTimeout(r, 0));
    ac.abort(); // 中途打断
    const err = await run;
    expect(collected).toEqual([{ type: 'text', text: '半' }]); // abort 前已收
    expect(w.closed).toBe(true); // WS 被关
    expect((err as Error)?.name === 'AbortError' || /abort/i.test(String(err))).toBe(true);
  });
});

describe('QwenOmniLlm / 错误降级', () => {
  it('error 事件 → 抛清晰错误(供上层 catch 降级)', async () => {
    const { llm, ws } = makeOmni();
    const run = collectEvents(llm.respondToAudio(audioOf(pcm([1]))));
    await Promise.resolve();
    const w = ws() as FakeWs;
    w.emitOpen();
    w.emitMessage({ type: 'session.created' });
    w.emitMessage({ type: 'error', error: { code: 'InvalidApiKey', message: '鉴权失败' } });
    await expect(run).rejects.toThrow(/qwen-omni 服务端错误.*鉴权失败|InvalidApiKey/);
    expect(w.closed).toBe(true);
  });

  it('WS error(连接层) → 抛清晰错误', async () => {
    const { llm, ws } = makeOmni();
    const run = collectEvents(llm.respondToAudio(audioOf(pcm([1]))));
    await Promise.resolve();
    const w = ws() as FakeWs;
    w.emitError(new Error('ECONNREFUSED'));
    await expect(run).rejects.toThrow(/qwen-omni WS 连接错误.*ECONNREFUSED/);
  });

  it('意外 close(未 done 就关) → 抛错', async () => {
    const { llm, ws } = makeOmni();
    const run = collectEvents(llm.respondToAudio(audioOf(pcm([1]))));
    await Promise.resolve();
    const w = ws() as FakeWs;
    w.emitOpen();
    w.emitMessage({ type: 'session.created' });
    w.emitClose(1006);
    await expect(run).rejects.toThrow(/qwen-omni WS 意外关闭/);
  });
});

// 注:QwenOmniLlm 已在文件顶部从 '../src/index' 导入,此处直接复用(不重复 import)。
describe('QwenOmniLlm 采样率/回合模式解耦', () => {
  const base = { id: 'qwen-omni', model: 'qwen3.5-omni-flash-realtime', apiKey: 'k', baseURL: 'wss://x' };
  it('默认 inputSampleRate=16000', () => {
    expect(new QwenOmniLlm(base).inputSampleRate).toBe(16000);
  });
  it('inputSampleRate 可经选项覆盖', () => {
    expect(new QwenOmniLlm({ ...base, inputSampleRate: 24000 }).inputSampleRate).toBe(24000);
  });
  it('turnDetection 接受 semantic_vad（类型层）', () => {
    const llm = new QwenOmniLlm({ ...base, turnDetection: 'semantic_vad' });
    expect(llm).toBeTruthy();
  });
});
