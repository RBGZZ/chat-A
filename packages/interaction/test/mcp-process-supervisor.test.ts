import { describe, it, expect } from 'vitest';
import {
  ProcessSupervisor,
  computeBackoff,
  DEFAULT_BACKOFF,
  type SupervisedUnit,
  type SupervisorEvent,
} from '../src/index';

/** 手动驱动 fake scheduler。 */
function makeFakeScheduler() {
  const pending: Array<{ fn: () => void; cancelled: boolean }> = [];
  const schedule = (fn: () => void): (() => void) => {
    const e = { fn, cancelled: false };
    pending.push(e);
    return () => {
      e.cancelled = true;
    };
  };
  const flush = async (): Promise<void> => {
    const due = pending.filter((e) => !e.cancelled);
    pending.length = 0;
    for (const e of due) e.fn();
    await Promise.resolve(); // 让重启 microtask 落定
    await Promise.resolve();
  };
  return { schedule, flush, pending };
}

/** 可控行为的 mock 单元。 */
function makeUnit(id: string, core: boolean) {
  const log: string[] = [];
  let startFailTimes = 0;
  let healthy = true;
  const unit: SupervisedUnit = {
    id,
    core,
    start(): Promise<void> {
      if (startFailTimes > 0) {
        startFailTimes -= 1;
        log.push('start-fail');
        return Promise.reject(new Error(`${id} 启动失败`));
      }
      log.push('start-ok');
      healthy = true;
      return Promise.resolve();
    },
    stop(): Promise<void> {
      log.push('stop');
      return Promise.resolve();
    },
    health: () => healthy,
  };
  return {
    unit,
    log,
    failNextStarts: (n: number): void => {
      startFailTimes = n;
    },
    setHealthy: (h: boolean): void => {
      healthy = h;
    },
  };
}

describe('mcp/computeBackoff(纯函数,golden)', () => {
  it('无 jitter(rand=0.5 → delta 0):指数增长封顶', () => {
    const cfg = { ...DEFAULT_BACKOFF, jitter: 0 };
    expect(computeBackoff(0, cfg)).toBe(200);
    expect(computeBackoff(1, cfg)).toBe(400);
    expect(computeBackoff(2, cfg)).toBe(800);
    expect(computeBackoff(10, cfg)).toBe(30_000); // 封顶 maxMs
  });

  it('jitter 在 ±范围内、非负', () => {
    const cfg = { ...DEFAULT_BACKOFF };
    const lo = computeBackoff(1, cfg, () => 0); // base 400, delta = 400*0.2*(-1) = -80 → 320
    const hi = computeBackoff(1, cfg, () => 1); // delta = +80 → 480
    expect(lo).toBe(320);
    expect(hi).toBe(480);
    expect(computeBackoff(0, cfg, () => 0)).toBeGreaterThanOrEqual(0);
  });
});

describe('mcp/ProcessSupervisor 监督与降级', () => {
  it('正常启动全部单元', async () => {
    const a = makeUnit('a', true);
    const b = makeUnit('b', false);
    const sup = new ProcessSupervisor();
    sup.add(a.unit).add(b.unit);
    await sup.start();
    expect(sup.isRunning('a')).toBe(true);
    expect(sup.isRunning('b')).toBe(true);
  });

  it('可选能力启动失败 → 不阻塞其它单元启动(降级,§3.2)', async () => {
    const sched = makeFakeScheduler();
    const optional = makeUnit('opt', false);
    optional.failNextStarts(99); // 一直失败
    const core = makeUnit('core', true);
    const events: SupervisorEvent[] = [];
    const sup = new ProcessSupervisor({ schedule: sched.schedule, onEvent: (e) => events.push(e) });
    sup.add(optional.unit).add(core.unit);
    await sup.start();
    // 可选启动失败,但 core 仍起来(不阻塞)。
    expect(sup.isRunning('core')).toBe(true);
    expect(sup.isRunning('opt')).toBe(false);
    expect(events.some((e) => e.type === 'start_failed' && e.id === 'opt')).toBe(true);
    await sup.stopAll();
  });

  it('核心能力崩溃 → 指数退避重启自愈', async () => {
    const sched = makeFakeScheduler();
    const core = makeUnit('core', true);
    const events: SupervisorEvent[] = [];
    const sup = new ProcessSupervisor({
      schedule: sched.schedule,
      onEvent: (e) => events.push(e),
    });
    sup.add(core.unit);
    await sup.start();
    expect(sup.isRunning('core')).toBe(true);

    sup.reportCrash('core');
    expect(sup.isRunning('core')).toBe(false);
    expect(events.some((e) => e.type === 'crashed')).toBe(true);
    expect(events.some((e) => e.type === 'restart_scheduled')).toBe(true);

    await sched.flush(); // 触发退避重启
    expect(sup.isRunning('core')).toBe(true);
    expect(events.some((e) => e.type === 'restarted')).toBe(true);
    await sup.stopAll();
  });

  it('重启仍失败 → 继续退避(attempt 自增,延迟更长)', async () => {
    const sched = makeFakeScheduler();
    const core = makeUnit('core', true);
    const delays: number[] = [];
    const sup = new ProcessSupervisor({
      schedule: sched.schedule,
      backoff: { ...DEFAULT_BACKOFF, jitter: 0 },
      onEvent: (e) => {
        if (e.type === 'restart_scheduled') delays.push(e.delayMs);
      },
    });
    sup.add(core.unit);
    await sup.start();
    core.failNextStarts(2); // 接下来两次重启失败
    sup.reportCrash('core');
    await sched.flush(); // 第一次重启失败 → 重排
    await sched.flush(); // 第二次重启失败 → 重排
    await sched.flush(); // 第三次重启成功
    expect(sup.isRunning('core')).toBe(true);
    // attempt 递增 → 退避延迟递增。
    expect(delays.length).toBeGreaterThanOrEqual(2);
    expect(delays[1]!).toBeGreaterThan(delays[0]!);
    await sup.stopAll();
  });

  it('pollHealth:不健康单元被判崩溃并重启', async () => {
    const sched = makeFakeScheduler();
    const core = makeUnit('core', true);
    const sup = new ProcessSupervisor({ schedule: sched.schedule });
    sup.add(core.unit);
    await sup.start();
    core.setHealthy(false);
    await sup.pollHealth();
    expect(sup.isRunning('core')).toBe(false);
    core.setHealthy(true);
    await sched.flush();
    expect(sup.isRunning('core')).toBe(true);
    await sup.stopAll();
  });

  it('stopAll = LIFO 优雅关闭(后启动先停)', async () => {
    const order: string[] = [];
    const mk = (id: string): SupervisedUnit => ({
      id,
      core: true,
      start: () => Promise.resolve(),
      stop: () => {
        order.push(id);
        return Promise.resolve();
      },
      health: () => true,
    });
    const sup = new ProcessSupervisor();
    sup.add(mk('first')).add(mk('second')).add(mk('third'));
    await sup.start();
    await sup.stopAll();
    expect(order).toEqual(['third', 'second', 'first']); // LIFO
  });

  it('崩溃后待重启期间 stopAll 取消重启', async () => {
    const sched = makeFakeScheduler();
    const core = makeUnit('core', true);
    const sup = new ProcessSupervisor({ schedule: sched.schedule });
    sup.add(core.unit);
    await sup.start();
    sup.reportCrash('core');
    expect(sched.pending.some((e) => !e.cancelled)).toBe(true);
    await sup.stopAll();
    expect(sched.pending.every((e) => e.cancelled)).toBe(true);
  });
});
