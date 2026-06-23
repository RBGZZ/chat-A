/**
 * SkillScheduler:单循环 reconcile 多个后台技能(确定性内核,承 §7 / neuro-ecosystem-findings §5)。
 *
 * 每 `tick()`:
 * 1. 对每个已注册技能**现读** `config.isEnabled(id)`(改配置下一 tick 生效,无重启)。
 * 2. 状态机 reconcile:
 *    - 应启用且未启动 → `initialize()`(恰一次)+ `start()` → 标记 started。
 *    - 应启用且已启动 → `tick()`(受 per-skill inflight 锁约束)。
 *    - 应禁用但已启动 → `stop()` → 清 started 标记。
 *    - 应禁用且未启动 → 跳过。
 * 3. **per-skill inflight 锁**:技能 `tick()` 返回的 Promise 未结算前,该技能下一 tick 跳过;
 *    结算后(无论 fulfilled/rejected)释放锁。
 * 4. **异常隔离**(优雅降级 §3.2):任一钩子抛错/Promise reject 被捕获 + 计数,
 *    不中断其它技能、不终止调度循环。
 *
 * **不用 `setInterval` 自驱**:由外部(测试/接线切片)反复调 `tick()` 推动 → 完全确定可测。
 * standalone:不接总线/runtime;`onConfigReload()` 广播给已启动技能,各自幂等重读。
 */
import type { AutonomyConfig } from './config';
import type { BaseSkill } from './skill';

/** 单个技能的调度运行态(scheduler 内部维护)。 */
interface SkillRuntime {
  readonly skill: BaseSkill;
  /** 是否已 initialize 过(恰一次的依据)。 */
  initialized: boolean;
  /** 是否处于"已启动"(start 过且未 stop)。 */
  started: boolean;
  /** per-skill inflight 锁:上一次异步 tick 是否仍在飞。 */
  inflight: boolean;
}

/** 调度错误记录(可追溯 §8.1:谁、哪个钩子、什么错)。 */
export interface SchedulerError {
  readonly skillId: string;
  readonly phase: 'initialize' | 'start' | 'tick' | 'stop' | 'onConfigReload';
  readonly error: unknown;
}

export class SkillScheduler {
  readonly #config: AutonomyConfig;
  readonly #skills = new Map<string, SkillRuntime>();
  /** 异常计数 + 最近错误(优雅降级:只记不杀,§3.2)。 */
  #errorCount = 0;
  #errors: SchedulerError[] = [];

  constructor(config: AutonomyConfig) {
    this.#config = config;
  }

  /** 已注册技能数。 */
  get size(): number {
    return this.#skills.size;
  }

  /** 累计被隔离的异常数(测试/追溯用)。 */
  get errorCount(): number {
    return this.#errorCount;
  }

  /** 最近若干条隔离错误的只读快照(追溯用)。 */
  get errors(): readonly SchedulerError[] {
    return this.#errors;
  }

  /** 某技能当前是否处于"已启动"(测试/追溯用)。 */
  isStarted(skillId: string): boolean {
    return this.#skills.get(skillId)?.started ?? false;
  }

  /**
   * 注册一个后台技能。重复 id SHALL 抛错(同 id 两个技能是配置错误,早失败比静默覆盖好)。
   * 注册不触发任何生命周期钩子——是否启动完全由 tick 时的 enabled 现读决定。
   */
  register(skill: BaseSkill): void {
    if (this.#skills.has(skill.id)) {
      throw new Error(`SkillScheduler: 重复注册技能 id "${skill.id}"`);
    }
    this.#skills.set(skill.id, {
      skill,
      initialized: false,
      started: false,
      inflight: false,
    });
  }

  /**
   * 运行一个调度 tick:对所有技能 reconcile。
   * 返回 Promise——同步部分(现读 enabled、状态机切换、同步钩子)立即完成;
   * 异步技能 tick 受 inflight 锁约束(本次不 await 它们的结算,但会捕获其 rejection)。
   */
  async tick(): Promise<void> {
    for (const rt of this.#skills.values()) {
      const enabled = this.#config.isEnabled(rt.skill.id);
      if (enabled) {
        if (!rt.started) {
          await this.#bringUp(rt);
        } else {
          await this.#runTick(rt);
        }
      } else if (rt.started) {
        await this.#tearDown(rt);
      }
      // enabled=false 且未启动:无操作。
    }
  }

  /**
   * 配置热更广播:对所有**已启动**技能调 `onConfigReload()`(各自幂等重读)。
   * 不强制重启;异常同样被隔离。enabled 本身仍由 tick 现读,不依赖此广播。
   */
  async reloadConfig(): Promise<void> {
    for (const rt of this.#skills.values()) {
      if (!rt.started) continue;
      await this.#guard(rt, 'onConfigReload', () => rt.skill.onConfigReload?.());
    }
  }

  /** 启动一个技能:首次 initialize(恰一次)+ start。任一步抛错则不标记 started。 */
  async #bringUp(rt: SkillRuntime): Promise<void> {
    if (!rt.initialized) {
      const ok = await this.#guard(rt, 'initialize', () => rt.skill.initialize?.());
      if (!ok) return; // initialize 失败:不标 initialized、不 start,下一 tick 重试。
      rt.initialized = true;
    }
    const ok = await this.#guard(rt, 'start', () => rt.skill.start?.());
    if (ok) rt.started = true;
  }

  /** 停止一个技能:调 stop 并清 started 标记(无论 stop 是否抛错都视为已停)。 */
  async #tearDown(rt: SkillRuntime): Promise<void> {
    await this.#guard(rt, 'stop', () => rt.skill.stop?.());
    rt.started = false;
  }

  /**
   * 运行技能 tick,受 per-skill inflight 锁约束:
   * - 锁已占(上一异步 tick 未结算)→ 本次跳过。
   * - 否则置锁,调 tick;若返回 Promise 则 fire-and-forget 地在其结算后释锁(并捕获 rejection);
   *   若同步完成则立即释锁。
   */
  async #runTick(rt: SkillRuntime): Promise<void> {
    if (rt.inflight) return; // inflight 锁:未结算,跳过本 tick。
    const fn = rt.skill.tick;
    if (fn === undefined) return; // 无 tick 钩子的技能:启动后什么都不做也合法。

    rt.inflight = true;
    let result: void | Promise<void>;
    try {
      result = fn.call(rt.skill);
    } catch (error) {
      // 同步抛错:隔离 + 立即释锁。
      this.#record(rt.skill.id, 'tick', error);
      rt.inflight = false;
      return;
    }

    if (result instanceof Promise) {
      // 异步:不 await(不让慢技能阻塞本 tick 的其它技能);结算后释锁 + 捕获 rejection。
      result.then(
        () => {
          rt.inflight = false;
        },
        (error: unknown) => {
          this.#record(rt.skill.id, 'tick', error);
          rt.inflight = false;
        },
      );
    } else {
      // 同步完成:立即释锁。
      rt.inflight = false;
    }
  }

  /**
   * 执行一个生命周期钩子并隔离异常:成功(含钩子不存在)返回 true,抛错/reject 返回 false。
   * 同步与异步抛错都被捕获 + 计数(优雅降级,§3.2)。
   */
  async #guard(
    rt: SkillRuntime,
    phase: SchedulerError['phase'],
    fn: () => void | Promise<void>,
  ): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (error) {
      this.#record(rt.skill.id, phase, error);
      return false;
    }
  }

  /** 记录一条隔离错误(计数 + 留存,供追溯)。 */
  #record(skillId: string, phase: SchedulerError['phase'], error: unknown): void {
    this.#errorCount += 1;
    this.#errors.push({ skillId, phase, error });
  }
}
