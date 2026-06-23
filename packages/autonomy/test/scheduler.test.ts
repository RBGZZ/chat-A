import { describe, expect, it } from 'vitest';
import { enabledSetConfig, resolveAutonomyConfig } from '../src/config';
import { SkillScheduler } from '../src/scheduler';
import type { BaseSkill } from '../src/skill';

/** 记录各钩子调用次数的 fake 技能。 */
interface RecordingSkill extends BaseSkill {
  readonly calls: { initialize: number; start: number; tick: number; stop: number; reload: number };
}

function recordingSkill(id: string): RecordingSkill {
  const calls = { initialize: 0, start: 0, tick: 0, stop: 0, reload: 0 };
  return {
    id,
    calls,
    initialize: () => void calls.initialize++,
    start: () => void calls.start++,
    tick: () => void calls.tick++,
    stop: () => void calls.stop++,
    onConfigReload: () => void calls.reload++,
  };
}

/** 一个可外部 resolve 的 deferred(测试 inflight 锁)。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('SkillScheduler(单循环 reconcile,§7)', () => {
  it('enabled 热读:disabled 时不启动,改为 enabled 后下一 tick 启动', async () => {
    const { config, enabled } = enabledSetConfig();
    const sched = new SkillScheduler(config);
    const s = recordingSkill('greet');
    sched.register(s);

    await sched.tick(); // 仍 disabled
    expect(s.calls.start).toBe(0);
    expect(sched.isStarted('greet')).toBe(false);

    enabled.add('greet'); // 改配置
    await sched.tick(); // 下一 tick 现读生效
    expect(s.calls.initialize).toBe(1);
    expect(s.calls.start).toBe(1);
    expect(sched.isStarted('greet')).toBe(true);
  });

  it('initialize 恰一次,tick 每 tick 一次', async () => {
    const { config, enabled } = enabledSetConfig(['s']);
    const sched = new SkillScheduler(config);
    const s = recordingSkill('s');
    sched.register(s);
    void enabled; // 已启用

    await sched.tick();
    await sched.tick();
    await sched.tick();

    expect(s.calls.initialize).toBe(1);
    expect(s.calls.start).toBe(1);
    expect(s.calls.tick).toBe(2); // 首 tick 用于 start,其后两 tick 调 tick
  });

  it('禁用已启动技能 → 调 stop 且不再 tick', async () => {
    const { config, enabled } = enabledSetConfig(['s']);
    const sched = new SkillScheduler(config);
    const s = recordingSkill('s');
    sched.register(s);

    await sched.tick(); // start
    await sched.tick(); // tick #1
    expect(s.calls.tick).toBe(1);

    enabled.delete('s'); // 禁用
    await sched.tick(); // → stop
    expect(s.calls.stop).toBe(1);
    expect(sched.isStarted('s')).toBe(false);

    await sched.tick(); // 仍禁用:无操作
    expect(s.calls.tick).toBe(1); // 未再 tick
  });

  it('重新启用已停止技能会再次 start,但 initialize 仍只一次', async () => {
    const { config, enabled } = enabledSetConfig(['s']);
    const sched = new SkillScheduler(config);
    const s = recordingSkill('s');
    sched.register(s);

    await sched.tick(); // start #1
    enabled.delete('s');
    await sched.tick(); // stop
    enabled.add('s');
    await sched.tick(); // start #2

    expect(s.calls.initialize).toBe(1); // 恰一次
    expect(s.calls.start).toBe(2);
  });

  it('per-skill inflight 锁:异步 tick 未结算时跳过下一 tick,结算后恢复', async () => {
    const { config } = enabledSetConfig(['s']);
    const sched = new SkillScheduler(config);

    let tickCount = 0;
    let pending = deferred();
    const skill: BaseSkill = {
      id: 's',
      tick: () => {
        tickCount++;
        return pending.promise;
      },
    };
    sched.register(skill);

    await sched.tick(); // start(无 initialize/start 钩子,直接标 started)
    await sched.tick(); // tick #1 → 返回未结算 promise,锁住
    expect(tickCount).toBe(1);

    await sched.tick(); // 锁未释放 → 跳过
    expect(tickCount).toBe(1);

    pending.resolve(); // 结算
    await Promise.resolve(); // 让 then 回调跑(释锁)
    await Promise.resolve();

    pending = deferred(); // 下一轮用新 deferred
    await sched.tick(); // 锁已释放 → 正常 tick #2
    expect(tickCount).toBe(2);
  });

  it('异常隔离:一个技能 tick 抛错不影响其它技能、不终止循环', async () => {
    const { config } = enabledSetConfig(['bad', 'good']);
    const sched = new SkillScheduler(config);

    const good = recordingSkill('good');
    const bad: BaseSkill = {
      id: 'bad',
      tick: () => {
        throw new Error('boom');
      },
    };
    sched.register(bad);
    sched.register(good);

    await sched.tick(); // start 两者
    await expect(sched.tick()).resolves.toBeUndefined(); // tick:bad 抛错被隔离
    expect(good.calls.tick).toBe(1); // good 仍被调用
    expect(sched.errorCount).toBe(1);
    expect(sched.errors[0]?.skillId).toBe('bad');
    expect(sched.errors[0]?.phase).toBe('tick');
  });

  it('异步 tick reject 也被隔离并计数', async () => {
    const { config } = enabledSetConfig(['s']);
    const sched = new SkillScheduler(config);
    const skill: BaseSkill = {
      id: 's',
      tick: () => Promise.reject(new Error('async boom')),
    };
    sched.register(skill);

    await sched.tick(); // start
    await sched.tick(); // tick → reject
    await Promise.resolve(); // 让 rejection handler 跑
    await Promise.resolve();
    expect(sched.errorCount).toBe(1);
    expect(sched.errors[0]?.phase).toBe('tick');
  });

  it('reloadConfig 只对已启动技能广播 onConfigReload', async () => {
    const { config, enabled } = enabledSetConfig(['on']);
    const sched = new SkillScheduler(config);
    const on = recordingSkill('on');
    const off = recordingSkill('off');
    sched.register(on);
    sched.register(off);
    void enabled;

    await sched.tick(); // on 启动,off 未启用
    await sched.reloadConfig();
    expect(on.calls.reload).toBe(1);
    expect(off.calls.reload).toBe(0); // 未启动不广播
  });

  it('重复注册同 id 抛错', () => {
    const sched = new SkillScheduler(resolveAutonomyConfig());
    sched.register(recordingSkill('dup'));
    expect(() => sched.register(recordingSkill('dup'))).toThrow(/重复注册/);
  });

  it('无 tick 钩子的技能:启动后什么都不做也合法', async () => {
    const { config } = enabledSetConfig(['quiet']);
    const sched = new SkillScheduler(config);
    sched.register({ id: 'quiet' }); // 无任何钩子
    await sched.tick();
    await sched.tick();
    expect(sched.isStarted('quiet')).toBe(true);
    expect(sched.errorCount).toBe(0);
  });
});
