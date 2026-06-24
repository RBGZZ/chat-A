import { describe, it, expect } from 'vitest';
import {
  PerceptionHub,
  CollectingPublisher,
  createSystemTickSource,
  createSystemNotificationSource,
  createMicSource,
  type PerceptionSource,
  type RawEmit,
} from '../src/index';

/** 手动驱动的 fake scheduler:收集待执行回调,test 显式触发。 */
function makeFakeScheduler() {
  const pending: Array<{ fn: () => void; delayMs: number; cancelled: boolean }> = [];
  const schedule = (fn: () => void, delayMs: number): (() => void) => {
    const entry = { fn, delayMs, cancelled: false };
    pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  const flushAll = (): void => {
    const due = pending.filter((e) => !e.cancelled);
    pending.length = 0;
    for (const e of due) e.fn();
  };
  return { schedule, flushAll, pending };
}

describe('perception/PerceptionHub 聚合窗 + 总线发布', () => {
  it('system.tick 注入 clock/timer → 经聚合窗 fire signal:perception(带 correlationId)', async () => {
    const pub = new CollectingPublisher('cid-1');
    const tickTimer = makeFakeScheduler();
    const aggTimer = makeFakeScheduler();
    let nowMs = 1000;

    const tick = createSystemTickSource({
      periodMs: 60_000,
      now: () => nowMs,
      schedule: tickTimer.schedule,
    });
    const hub = new PerceptionHub({
      publisher: pub,
      now: () => nowMs,
      schedule: aggTimer.schedule,
    });
    hub.register(tick);
    await hub.start();

    // 驱动一次 tick:源 emit raw → hub 开聚合窗。
    tickTimer.flushAll();
    expect(pub.events).toHaveLength(0); // 聚合窗未到期,尚未 fire
    // 聚合窗到期 → fire signal。
    nowMs = 1300;
    aggTimer.flushAll();

    const signals = pub.byAction('signal:perception');
    expect(signals).toHaveLength(1);
    const ev = signals[0]!;
    expect(ev.correlationId).toBe('cid-1');
    expect(ev.data).toMatchObject({ kind: 'temporal:tick', confidence: 1 });

    await hub.stop();
  });

  it('多源/多次抖动 → 聚合窗合并(防七嘴八舌)', async () => {
    const pub = new CollectingPublisher('cid-2');
    const aggTimer = makeFakeScheduler();
    let nowMs = 0;
    const notif = createSystemNotificationSource({ now: () => nowMs });
    const hub = new PerceptionHub({ publisher: pub, now: () => nowMs, schedule: aggTimer.schedule });
    hub.register(notif);
    await hub.start();

    // 同一聚合窗内连推 3 条同类通知。
    notif.push({ title: 'A' });
    nowMs = 100;
    notif.push({ title: 'B' });
    nowMs = 200;
    notif.push({ title: 'C' });
    nowMs = 250;
    aggTimer.flushAll();

    const signals = pub.byAction('signal:perception');
    expect(signals).toHaveLength(1); // 3 条合并成 1 条
    expect(signals[0]!.data).toMatchObject({ kind: 'system:notification' });

    await hub.stop();
  });

  it('stop 后源不再 fire signal', async () => {
    const pub = new CollectingPublisher();
    const aggTimer = makeFakeScheduler();
    const notif = createSystemNotificationSource({ now: () => 0 });
    const hub = new PerceptionHub({ publisher: pub, now: () => 0, schedule: aggTimer.schedule });
    hub.register(notif);
    await hub.start();
    await hub.stop();
    notif.push({ title: 'after-stop' });
    aggTimer.flushAll();
    expect(pub.byAction('signal:perception')).toHaveLength(0);
  });

  it('mic 接入点:语音管线 feed → raw:heard 进同一通道', async () => {
    const pub = new CollectingPublisher('cid-mic');
    const aggTimer = makeFakeScheduler();
    let nowMs = 5;
    const mic = createMicSource({ now: () => nowMs });
    const hub = new PerceptionHub({ publisher: pub, now: () => nowMs, schedule: aggTimer.schedule });
    hub.register(mic);
    await hub.start();
    mic.feed({ kind: 'speech_end', value: { text: '你好' } });
    nowMs = 100;
    aggTimer.flushAll();
    const signals = pub.byAction('signal:perception');
    expect(signals).toHaveLength(1);
    expect(signals[0]!.data).toMatchObject({ kind: 'heard:speech_end' });
    await hub.stop();
  });
});

describe('perception/优雅降级:源崩溃不拖垮其它源(§3.2)', () => {
  it('一个源 start 抛错 → 其它源照常工作,signal 仍 fire', async () => {
    const pub = new CollectingPublisher('cid-3');
    const aggTimer = makeFakeScheduler();
    let nowMs = 0;
    const errors: string[] = [];

    const boom: PerceptionSource = {
      id: 'boom',
      modality: 'felt',
      start(): void {
        throw new Error('源炸了');
      },
      stop(): void {},
      health: () => ({ healthy: false }),
    };
    const notif = createSystemNotificationSource({ now: () => nowMs });

    const hub = new PerceptionHub({
      publisher: pub,
      now: () => nowMs,
      schedule: aggTimer.schedule,
      onError: (_e, where) => errors.push(where),
    });
    hub.register(boom).register(notif);
    await hub.start(); // 不应抛

    expect(errors.some((w) => w.includes('boom'))).toBe(true);
    notif.push({ title: '仍工作' });
    nowMs = 100;
    aggTimer.flushAll();
    expect(pub.byAction('signal:perception')).toHaveLength(1);
    await hub.stop();
  });

  it('源 health() 可探测、stop 幂等', async () => {
    let nowMs = 0;
    const tickTimer = makeFakeScheduler();
    const tick = createSystemTickSource({ now: () => nowMs, schedule: tickTimer.schedule });
    const emitNoop: RawEmit = () => {};
    expect(tick.health().healthy).toBe(false);
    await tick.start(emitNoop);
    expect(tick.health().healthy).toBe(true);
    await tick.stop();
    await tick.stop(); // 幂等
    expect(tick.health().healthy).toBe(false);
  });
});
