import { describe, it, expect, vi } from 'vitest';
import {
  makeSystemFrame,
  makeDataFrame,
  makeControlFrame,
  STT_AUDIO_FORMAT,
  TTS_AUDIO_FORMAT,
} from '@chat-a/protocol';
import {
  FrameProcessor,
  FramePipeline,
  makeInterruptionFrame,
  isInterruptionFrame,
  AudioPacer,
  sliceAudio,
  samplesPerSlice,
  bytesPerSlice,
  type RuntimeFrame,
  type PacerClock,
} from '../src/index';

// ── 测试用帧工厂(载荷取真实类型,值无关紧要)──
const stt = (text: string) => makeDataFrame('stt:partial', { text });
const token = (t: string) => makeDataFrame('llm:token', { token: t });
const ctrl = (uninterruptible?: true) =>
  makeControlFrame('stt:partial', { text: 'ctrl' }, uninterruptible);
const sysFrame = () => makeSystemFrame('stt:partial', { text: 'sys' });

// 顺序收集帧 type(透传骨架下,record 下游所见)。
function collector() {
  const seen: string[] = [];
  const sink = (f: RuntimeFrame) => seen.push(f.type);
  return { seen, sink };
}

describe('runtime/FrameProcessor 双队列双任务', () => {
  it('① System 帧插队先于排队的 Data(快道,不等异步泵)', async () => {
    const order: string[] = [];
    // Data 走异步泵(每帧 await);System 走快道**同步**处理,绕过泵 → 先于排队 Data 产出。
    const fp = new FrameProcessor({
      onFrame: (f, push) => {
        if (isInterruptionFrame(f) || f.kind === 'system') {
          order.push('system'); // 快道,同步
          push(f);
          return;
        }
        // data/control:异步,模拟真实处理延迟。
        return Promise.resolve().then(() => {
          order.push('data');
          push(f);
        });
      },
    });
    fp.setSink(() => {});

    fp.process(stt('a')); // data 入队(异步泵)
    fp.process(sysFrame()); // system 快道:同步处理,不等泵
    // system 同步产出在前(此刻 data 仍卡在异步泵的 await)。
    expect(order).toEqual(['system']);
    await vi.waitFor(() => expect(order.length).toBe(2));
    expect(order).toEqual(['system', 'data']);
  });

  it('② 顺序处理 Data/Control(单消费者保序)', async () => {
    const order: string[] = [];
    const fp = new FrameProcessor({
      onFrame: async (f, push) => {
        await Promise.resolve();
        // 本用例只灌 data/control 帧(均有 payload);打断信令不进此用例。
        if (!isInterruptionFrame(f)) {
          order.push((f.payload as { text?: string; token?: string }).text ?? '');
        }
        push(f);
      },
    });
    fp.setSink(() => {});
    fp.process(stt('1'));
    fp.process(ctrl()); // control 文本 'ctrl'
    fp.process(stt('3'));
    await vi.waitFor(() => expect(order.length).toBe(3));
    expect(order).toEqual(['1', 'ctrl', '3']);
  });

  it('③ InterruptionFrame 清空 Data/Control 队列,但 Uninterruptible 仍送达', async () => {
    const { seen, sink } = collector();
    // 用可控的 gate 让首帧"卡住",从而排队若干帧后再打断,验证清队列。
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const fp = new FrameProcessor({
      onFrame: async (f, push) => {
        if (first) {
          first = false;
          await gate; // 首帧阻塞,后续帧堆在队列
        }
        push(f);
      },
    });
    fp.setSink(sink);

    fp.process(stt('keep-first')); // 进入 onFrame 并阻塞
    fp.process(token('drop-me')); // 可打断,排队
    fp.process(makeDataFrame('llm:token', { token: 'survive' }, true)); // Uninterruptible 保活
    fp.process(token('drop-me-2')); // 可打断,排队
    expect(fp.queueLength).toBe(3);

    // 打断:清可打断帧,保活帧留下;打断信令本身广播给下游。
    fp.process(makeInterruptionFrame('user-barge-in'));
    // 队列只剩 1 个保活帧(首帧已在 onFrame 中,不在队列)。
    expect(fp.queueLength).toBe(1);

    release(); // 放行首帧 → 继续泵剩余(保活帧)
    await vi.waitFor(() => expect(seen).toContain('interruption'));
    await vi.waitFor(() => expect(seen.filter((t) => t === 'llm:token').length).toBe(1));

    // 被丢弃的 token 帧未送达;保活 token 与首帧送达;打断信令广播。
    expect(seen).toContain('interruption');
    expect(seen.filter((t) => t === 'stt:partial')).toEqual(['stt:partial']); // 首帧
    expect(seen.filter((t) => t === 'llm:token')).toEqual(['llm:token']); // 仅保活那帧
  });

  it('普通 SystemFrame 不受打断、立即处理', () => {
    const { seen, sink } = collector();
    const fp = new FrameProcessor(); // 默认透传(同步)
    fp.setSink(sink);
    fp.process(sysFrame());
    fp.process(makeInterruptionFrame());
    expect(seen).toEqual(['stt:partial', 'interruption']);
  });
});

describe('runtime/FramePipeline 串链', () => {
  it('④ 帧依次流过链上每个 processor(上游产出喂下游)', async () => {
    const tagA: string[] = [];
    const tagB: string[] = [];
    const a = new FrameProcessor({
      onFrame: (f, push) => {
        tagA.push('A');
        push(f);
      },
    });
    const b = new FrameProcessor({
      onFrame: (f, push) => {
        tagB.push('B');
        push(f);
      },
    });
    const tailSeen: string[] = [];
    const pipe = new FramePipeline([a, b], (f) => tailSeen.push(f.type));
    expect(pipe.length).toBe(2);

    pipe.push(stt('flow'));
    await vi.waitFor(() => expect(tailSeen.length).toBe(1));
    expect(tagA).toEqual(['A']);
    expect(tagB).toEqual(['B']);
    expect(tailSeen).toEqual(['stt:partial']);
  });

  it('打断信令沿链广播,每个 processor 各自清队列', async () => {
    // 两个 processor 都阻塞首帧,堆积可打断帧,然后链首灌打断。
    const make = () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let first = true;
      const fp = new FrameProcessor({
        onFrame: async (f, push) => {
          if (first) {
            first = false;
            await gate;
          }
          push(f);
        },
      });
      return { fp, release: () => release() };
    };
    const A = make();
    const tail: string[] = [];
    const pipe = new FramePipeline([A.fp], (f) => tail.push(f.type));

    A.fp.process(stt('block')); // 卡在 onFrame
    A.fp.process(token('drop')); // 排队
    expect(A.fp.queueLength).toBe(1);
    pipe.push(makeInterruptionFrame()); // 链首广播打断
    expect(A.fp.queueLength).toBe(0); // 可打断帧被清

    A.release();
    await vi.waitFor(() => expect(tail).toContain('interruption'));
    expect(tail).not.toContain('llm:token'); // drop 帧未送达
  });
});

describe('runtime/AudioPacer 10ms 切片 + wall-clock 配速', () => {
  it('每片样本/字节数:16k=160/320、24k=240/480', () => {
    expect(samplesPerSlice(STT_AUDIO_FORMAT.sampleRate)).toBe(160);
    expect(bytesPerSlice(STT_AUDIO_FORMAT.sampleRate)).toBe(320);
    expect(samplesPerSlice(TTS_AUDIO_FORMAT.sampleRate)).toBe(240);
    expect(bytesPerSlice(TTS_AUDIO_FORMAT.sampleRate)).toBe(480);
  });

  it('sliceAudio 按每片样本数切片(末片不足整片原样保留)', () => {
    // 16k:每片 160 样本;给 370 样本 → 160 + 160 + 50。
    const s = new Int16Array(370);
    const slices = sliceAudio(s, 16_000);
    expect(slices.map((x) => x.length)).toEqual([160, 160, 50]);
  });

  it('⑤ 按注入时钟逐片配速:每 10ms 投放一片,时钟推进才出片', () => {
    // 假时钟:确定性推进,不依赖真实时间。
    let now = 0;
    const timers: { at: number; cb: () => void }[] = [];
    const clock: PacerClock = {
      now: () => now,
      setTimer: (ms, cb) => {
        const entry = { at: now + ms, cb };
        timers.push(entry);
        return () => {
          const i = timers.indexOf(entry);
          if (i >= 0) timers.splice(i, 1);
        };
      },
    };
    // 推进到 `target`:触发所有到期定时器(单飞行,逐个)。
    const advance = (ms: number) => {
      now += ms;
      // 触发 at<=now 的(本测试每次只排 1 个,故顺序触发即可)。
      for (;;) {
        const idx = timers.findIndex((t) => t.at <= now);
        if (idx < 0) break;
        const [t] = timers.splice(idx, 1);
        t!.cb();
      }
    };

    const out: number[] = [];
    // 24k:每片 240 样本;给 720 样本 → 3 片。
    const samples = new Int16Array(720);
    const pacer = new AudioPacer({
      sampleRate: 24_000,
      clock,
      onSlice: (_slice, i) => out.push(i),
    });

    pacer.start(samples);
    // t=0:第 0 片立即投放;第 1/2 片各等 10ms。
    expect(out).toEqual([0]);
    expect(pacer.emittedCount).toBe(1);

    advance(10); // → 第 1 片
    expect(out).toEqual([0, 1]);
    advance(10); // → 第 2 片
    expect(out).toEqual([0, 1, 2]);
    advance(10); // 无更多片 → 收尾
    expect(out).toEqual([0, 1, 2]);
    expect(pacer.running).toBe(false);
  });

  it('stop() 干净打断:清未触发定时器,停止后续投放', () => {
    let now = 0;
    const timers: { at: number; cb: () => void }[] = [];
    const clock: PacerClock = {
      now: () => now,
      setTimer: (ms, cb) => {
        const entry = { at: now + ms, cb };
        timers.push(entry);
        return () => {
          const i = timers.indexOf(entry);
          if (i >= 0) timers.splice(i, 1);
        };
      },
    };
    const out: number[] = [];
    const pacer = new AudioPacer({
      sampleRate: 16_000,
      clock,
      onSlice: (_s, i) => out.push(i),
    });
    pacer.start(new Int16Array(160 * 5)); // 5 片
    expect(out).toEqual([0]); // 仅首片投放
    expect(timers.length).toBe(1); // 排了下一片定时器
    pacer.stop(); // 干净打断
    expect(timers.length).toBe(0); // 定时器被清
    expect(pacer.running).toBe(false);
    // 推进时间也不会再出片(定时器已清)。
    now += 100;
    for (const t of [...timers]) t.cb();
    expect(out).toEqual([0]);
  });
});
