import { describe, expect, it } from 'vitest';
import { createBudgetState } from '../src/budget';
import { enabledSetConfig } from '../src/config';
import {
  DEFAULT_OPEN_THREAD_FOLLOWUP_OPTIONS,
  OPEN_THREAD_FOLLOWUP_SKILL_ID,
  OpenThreadFollowUpSkill,
  renderFollowUpText,
  type SpeakArbiter,
} from '../src/open-thread-skill';
import type { OpenThread, OpenThreadPort } from '../src/open-thread';
import { PriorityEventQueue } from '../src/priority-queue';
import { SkillScheduler } from '../src/scheduler';
import type { Clock, SpeakOutcome, SpeakRequest } from '../src/types';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** fake 时钟:可控当前时刻(确定性,不用真实时间)。 */
function fakeClock(start = 1_000_000): Clock & { set(n: number): void; advance(d: number): void } {
  let t = start;
  return {
    now: () => t,
    set: (n: number) => void (t = n),
    advance: (d: number) => void (t += d),
  };
}

/** fake open-thread 端口:返回固定话题列表(可热改)。 */
function fakePort(threads: OpenThread[] = []): OpenThreadPort & { threads: OpenThread[] } {
  const box = { threads };
  return {
    threads: box.threads,
    async listOpenThreads() {
      return box.threads;
    },
  } as OpenThreadPort & { threads: OpenThread[] };
}

/** fake 仲裁器:记录请求并返回可配裁决(默认空闲放行 speak)。 */
function fakeArbiter(
  outcome: SpeakOutcome = { decision: 'speak', preempted: false, reason: 'idle: 空闲放行' },
): SpeakArbiter & { requests: SpeakRequest[]; outcome: SpeakOutcome } {
  const requests: SpeakRequest[] = [];
  const self = {
    requests,
    outcome,
    requestSpeak(request: SpeakRequest): SpeakOutcome {
      requests.push(request);
      return self.outcome;
    },
  };
  return self;
}

/** 标准被试构造:enabled 默认开(测调度契约的用例自己管 config)。 */
function makeSkill(opts: {
  threads?: OpenThread[];
  clock?: ReturnType<typeof fakeClock>;
  arbiter?: ReturnType<typeof fakeArbiter>;
  enabled?: boolean;
  maxNoActionRetries?: number;
  options?: Partial<typeof DEFAULT_OPEN_THREAD_FOLLOWUP_OPTIONS>;
}) {
  const clock = opts.clock ?? fakeClock();
  const arbiter = opts.arbiter ?? fakeArbiter();
  const port = fakePort(opts.threads ?? []);
  const { config, enabled } = enabledSetConfig(
    opts.enabled === false ? [] : [OPEN_THREAD_FOLLOWUP_SKILL_ID],
    opts.maxNoActionRetries !== undefined ? { maxNoActionRetries: opts.maxNoActionRetries } : {},
  );
  const budget = createBudgetState(config);
  const queue = new PriorityEventQueue();
  const skill = new OpenThreadFollowUpSkill({
    port,
    arbiter,
    clock,
    config,
    budget,
    queue,
    ...(opts.options ? { options: opts.options } : {}),
  });
  return { skill, clock, arbiter, port, config, enabled, budget, queue };
}

describe('OpenThreadFollowUpSkill — open-thread 主动跟进(§7#2)', () => {
  it('① 有到期未了话题且预算足 → 经 requestSpeak 提交跟进', async () => {
    const now = 10 * DAY;
    const clock = fakeClock(now);
    const arbiter = fakeArbiter();
    const { skill } = makeSkill({
      clock,
      arbiter,
      threads: [
        {
          id: 't-interview',
          topic: '面试',
          personId: 'p-user',
          personName: '小明',
          lastMentionedAtMs: now - 2 * DAY, // 两天前提过(窗口内)
          dueAtMs: now - HOUR, // 已到 due
        },
      ],
    });

    await skill.tick();

    expect(arbiter.requests).toHaveLength(1);
    expect(arbiter.requests[0]?.skillId).toBe(OPEN_THREAD_FOLLOWUP_SKILL_ID);
    expect(arbiter.requests[0]?.priority).toBe('PERCEPTION');
    expect(arbiter.requests[0]?.deferrable).toBe(true);
    expect(skill.lastDecision?.action).toBe('speak');
    expect(skill.lastDecision?.chosenThreadId).toBe('t-interview');
  });

  it('② 无新鲜线索(太旧未到 due)→ 沉默', async () => {
    const now = 30 * DAY;
    const clock = fakeClock(now);
    const arbiter = fakeArbiter();
    const { skill } = makeSkill({
      clock,
      arbiter,
      threads: [
        {
          id: 't-old',
          topic: '旧事',
          personId: 'p-user',
          personName: '小明',
          lastMentionedAtMs: now - 20 * DAY, // 远超 staleAfter(7d),且无 due
        },
      ],
    });

    await skill.tick();

    expect(arbiter.requests).toHaveLength(0);
    expect(skill.lastDecision?.action).toBe('silent');
  });

  it('② 太新(话音未落)且未到 due → 沉默', async () => {
    const now = 10 * DAY;
    const clock = fakeClock(now);
    const arbiter = fakeArbiter();
    const { skill } = makeSkill({
      clock,
      arbiter,
      threads: [
        {
          id: 't-fresh',
          topic: '刚说的事',
          personId: 'p-user',
          personName: '小明',
          lastMentionedAtMs: now - 5 * 60 * 1000, // 5min 前,低于 minFreshness(1h)
        },
      ],
    });

    await skill.tick();
    expect(arbiter.requests).toHaveLength(0);
    expect(skill.lastDecision?.action).toBe('silent');
  });

  it('② enabled=false → 沉默且不调端口/仲裁/不扣预算', async () => {
    const now = 10 * DAY;
    const clock = fakeClock(now);
    const arbiter = fakeArbiter();
    const { skill, budget } = makeSkill({
      clock,
      arbiter,
      enabled: false,
      threads: [
        {
          id: 't-due',
          topic: '面试',
          personId: 'p-user',
          personName: '小明',
          lastMentionedAtMs: now - 2 * DAY,
          dueAtMs: now - HOUR,
        },
      ],
    });

    await skill.tick();

    expect(arbiter.requests).toHaveLength(0);
    expect(skill.lastDecision?.action).toBe('disabled');
    expect(budget.remaining).toBe(3); // 未扣预算
  });

  it('③ 沉默扣 no-action 预算并合成「再想一次」;耗尽后停止合成且仍沉默', async () => {
    const now = 30 * DAY;
    const clock = fakeClock(now);
    const { skill, budget, queue } = makeSkill({
      clock,
      maxNoActionRetries: 2,
      threads: [], // 无候选 → 每 tick 沉默
    });

    await skill.tick(); // 2→1,合成 1
    expect(budget.remaining).toBe(1);
    expect(queue.size).toBe(1);
    expect(skill.lastDecision?.budgetConsumed).toBe(true);

    await skill.tick(); // 1→0,合成 1
    expect(budget.remaining).toBe(0);
    expect(queue.size).toBe(2);

    await skill.tick(); // 0:不再合成,但仍沉默
    expect(budget.remaining).toBe(0);
    expect(queue.size).toBe(2);
    expect(skill.lastDecision?.action).toBe('silent');
    expect(skill.lastDecision?.budgetConsumed).toBe(false);
  });

  it('③ 成功跟进(speak)不扣预算', async () => {
    const now = 10 * DAY;
    const clock = fakeClock(now);
    const { skill, budget } = makeSkill({
      clock,
      threads: [
        {
          id: 't',
          topic: '面试',
          personId: 'p-user',
          personName: '小明',
          lastMentionedAtMs: now - 2 * DAY,
          dueAtMs: now - HOUR,
        },
      ],
    });

    await skill.tick();
    expect(skill.lastDecision?.action).toBe('speak');
    expect(budget.remaining).toBe(3); // 未扣
  });

  it('③ 仲裁 drop(忙且不可延续)→ 视同无产出:沉默 + 扣预算', async () => {
    const now = 10 * DAY;
    const clock = fakeClock(now);
    const arbiter = fakeArbiter({ decision: 'drop', preempted: false, reason: 'busy: 丢弃' });
    const { skill, budget } = makeSkill({
      clock,
      arbiter,
      threads: [
        {
          id: 't',
          topic: '面试',
          personId: 'p-user',
          personName: '小明',
          lastMentionedAtMs: now - 2 * DAY,
          dueAtMs: now - HOUR,
        },
      ],
    });

    await skill.tick();
    expect(arbiter.requests).toHaveLength(1);
    expect(skill.lastDecision?.action).toBe('silent');
    expect(skill.lastDecision?.budgetConsumed).toBe(true);
    expect(budget.remaining).toBe(2);
  });

  it('④ 文案带正确 person 主语(花名册名)', async () => {
    const now = 10 * DAY;
    const clock = fakeClock(now);
    const arbiter = fakeArbiter();
    const { skill } = makeSkill({
      clock,
      arbiter,
      threads: [
        {
          id: 't',
          topic: '面试',
          personId: 'p-user',
          personName: '小明',
          lastMentionedAtMs: now - 2 * DAY,
          dueAtMs: now - HOUR,
        },
      ],
    });

    await skill.tick();
    const text = arbiter.requests[0]?.text ?? '';
    expect(text).toContain('小明');
    expect(text).toContain('面试');
    expect(skill.lastDecision?.text).toBe(text);
  });

  it('④ 无花名册名时回退到中性「你」', () => {
    const text = renderFollowUpText({
      id: 't',
      topic: '搬家',
      personId: 'p-user',
      lastMentionedAtMs: 0,
    });
    expect(text).toContain('你');
    expect(text).toContain('搬家');
  });

  it('restraint-first:per-thread 冷却内不重复追问同一话题', async () => {
    const clock = fakeClock(10 * DAY);
    const arbiter = fakeArbiter();
    const thread: OpenThread = {
      id: 't',
      topic: '面试',
      personId: 'p-user',
      personName: '小明',
      lastMentionedAtMs: clock.now() - 2 * DAY,
      dueAtMs: clock.now() - HOUR,
    };
    const { skill } = makeSkill({ clock, arbiter, threads: [thread] });

    await skill.tick(); // 第一次跟进成功
    expect(arbiter.requests).toHaveLength(1);

    clock.advance(2 * HOUR); // 仍在 per-thread cooldown(12h)内
    await skill.tick();
    expect(arbiter.requests).toHaveLength(1); // 未再追问
    expect(skill.lastDecision?.action).toBe('silent');
  });

  it('restraint-first:全局 cadence 冷却内不连珠炮(即使另一话题到期)', async () => {
    const clock = fakeClock(10 * DAY);
    const arbiter = fakeArbiter();
    const t1: OpenThread = {
      id: 't1',
      topic: '面试',
      personId: 'p-user',
      personName: '小明',
      lastMentionedAtMs: clock.now() - 2 * DAY,
      dueAtMs: clock.now() - HOUR,
    };
    const t2: OpenThread = {
      id: 't2',
      topic: '搬家',
      personId: 'p-user',
      personName: '小明',
      lastMentionedAtMs: clock.now() - 2 * DAY,
      dueAtMs: clock.now() - HOUR,
    };
    const { skill } = makeSkill({ clock, arbiter, threads: [t1, t2] });

    await skill.tick(); // 跟进其一
    expect(arbiter.requests).toHaveLength(1);

    clock.advance(5 * 60 * 1000); // 5min,低于 globalCadence(30min)
    await skill.tick();
    expect(arbiter.requests).toHaveLength(1); // 全局冷却:不追第二条
    expect(skill.lastDecision?.action).toBe('silent');
    expect(skill.lastDecision?.reason).toContain('cadence');
  });

  it('过冷却后可再次跟进(cadence 是节流不是禁止)', async () => {
    const clock = fakeClock(10 * DAY);
    const arbiter = fakeArbiter();
    const thread: OpenThread = {
      id: 't',
      topic: '面试',
      personId: 'p-user',
      personName: '小明',
      lastMentionedAtMs: clock.now() - 2 * DAY,
      dueAtMs: clock.now() - HOUR,
    };
    const { skill } = makeSkill({ clock, arbiter, threads: [thread] });

    await skill.tick();
    expect(arbiter.requests).toHaveLength(1);

    clock.advance(13 * HOUR); // 超过 per-thread cooldown(12h)与 global cadence
    await skill.tick();
    expect(arbiter.requests).toHaveLength(2);
    expect(skill.lastDecision?.action).toBe('speak');
  });

  it('择优:多条候选挑「到 due 最久」的一条', async () => {
    const now = 10 * DAY;
    const clock = fakeClock(now);
    const arbiter = fakeArbiter();
    const { skill } = makeSkill({
      clock,
      arbiter,
      threads: [
        {
          id: 't-soon',
          topic: '近的',
          personId: 'p',
          personName: '小明',
          lastMentionedAtMs: now - 2 * DAY,
          dueAtMs: now - HOUR, // 过 due 1h
        },
        {
          id: 't-overdue',
          topic: '更急的',
          personId: 'p',
          personName: '小明',
          lastMentionedAtMs: now - 2 * DAY,
          dueAtMs: now - 3 * DAY, // 过 due 很久
        },
      ],
    });

    await skill.tick();
    expect(skill.lastDecision?.chosenThreadId).toBe('t-overdue');
  });
});

describe('OpenThreadFollowUpSkill — 经 SkillScheduler 接入(inflight 锁 + enabled 现读)', () => {
  it('调度器:disabled 时不 tick,enabled 后跟进;inflight 锁约束慢 tick', async () => {
    const clock = fakeClock(10 * DAY);
    const arbiter = fakeArbiter();
    const port = fakePort([
      {
        id: 't',
        topic: '面试',
        personId: 'p',
        personName: '小明',
        lastMentionedAtMs: clock.now() - 2 * DAY,
        dueAtMs: clock.now() - HOUR,
      },
    ]);
    const { config, enabled } = enabledSetConfig();
    const budget = createBudgetState(config);
    const queue = new PriorityEventQueue();
    const skill = new OpenThreadFollowUpSkill({ port, arbiter, clock, config, budget, queue });

    const sched = new SkillScheduler(config);
    sched.register(skill);

    await sched.tick(); // disabled:不启动
    expect(sched.isStarted(OPEN_THREAD_FOLLOWUP_SKILL_ID)).toBe(false);
    expect(arbiter.requests).toHaveLength(0);

    enabled.add(OPEN_THREAD_FOLLOWUP_SKILL_ID);
    await sched.tick(); // 启动(本 tick 仅 start,不 tick)
    expect(sched.isStarted(OPEN_THREAD_FOLLOWUP_SKILL_ID)).toBe(true);

    await sched.tick(); // 第一次真 tick → 跟进
    await Promise.resolve(); // 让 async tick 结算释锁
    await Promise.resolve();
    expect(arbiter.requests).toHaveLength(1);
    expect(sched.errorCount).toBe(0);
  });
});
