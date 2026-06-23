import { describe, expect, it } from 'vitest';
import { createBudgetState } from '../src/budget';
import { enabledSetConfig } from '../src/config';
import type { EmotionIntensityPort, PresencePort } from '../src/idle-emotion-arc';
import {
  DEFAULT_IDLE_EMOTION_ARC_OPTIONS,
  IDLE_EMOTION_ARC_SKILL_ID,
  IdleEmotionArcSkill,
  renderArcText,
} from '../src/idle-emotion-arc-skill';
import type { SpeakArbiter } from '../src/open-thread-skill';
import { PriorityEventQueue } from '../src/priority-queue';
import { SkillScheduler } from '../src/scheduler';
import type { Clock, SpeakOutcome, SpeakRequest } from '../src/types';

const MIN = 60 * 1000;

/** fake 时钟:可控当前时刻(确定性,不用真实时间)。 */
function fakeClock(start = 1_000_000): Clock & { set(n: number): void; advance(d: number): void } {
  let t = start;
  return {
    now: () => t,
    set: (n: number) => void (t = n),
    advance: (d: number) => void (t += d),
  };
}

/** fake 在场感端口:可热改 lastActive / episodeId(模拟用户活跃/回来)。 */
function fakePresence(
  lastUserActiveAtMs: number,
  episodeId: string,
): PresencePort & { last: number; episode: string } {
  const box = { last: lastUserActiveAtMs, episode: episodeId };
  return {
    get last() {
      return box.last;
    },
    set last(v: number) {
      box.last = v;
    },
    get episode() {
      return box.episode;
    },
    set episode(v: string) {
      box.episode = v;
    },
    lastUserActiveAtMs: () => box.last,
    currentEpisodeId: () => box.episode,
  };
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

/** fake 情绪旋钮端口:返回固定强度。 */
function fakeEmotion(intensity: number): EmotionIntensityPort {
  return { arcIntensity: () => intensity };
}

/** 标准被试构造:enabled 默认开(测调度契约的用例自己管 config)。 */
function makeSkill(opts: {
  presence: ReturnType<typeof fakePresence>;
  clock?: ReturnType<typeof fakeClock>;
  arbiter?: ReturnType<typeof fakeArbiter>;
  emotion?: EmotionIntensityPort;
  enabled?: boolean;
  maxNoActionRetries?: number;
  options?: Partial<typeof DEFAULT_IDLE_EMOTION_ARC_OPTIONS>;
}) {
  const clock = opts.clock ?? fakeClock();
  const arbiter = opts.arbiter ?? fakeArbiter();
  const { config, enabled } = enabledSetConfig(
    opts.enabled === false ? [] : [IDLE_EMOTION_ARC_SKILL_ID],
    opts.maxNoActionRetries !== undefined ? { maxNoActionRetries: opts.maxNoActionRetries } : {},
  );
  const budget = createBudgetState(config);
  const queue = new PriorityEventQueue();
  const skill = new IdleEmotionArcSkill({
    presence: opts.presence,
    arbiter,
    clock,
    config,
    budget,
    queue,
    ...(opts.emotion ? { emotion: opts.emotion } : {}),
    ...(opts.options ? { options: opts.options } : {}),
  });
  return { skill, clock, arbiter, config, enabled, budget, queue };
}

describe('IdleEmotionArcSkill — idle 情绪弧(想念/重逢,§7)', () => {
  it('① 长 idle 触发一次想念;同 episode 内不重复', async () => {
    const start = 100 * MIN;
    const clock = fakeClock(start);
    const presence = fakePresence(start, 'ep-1'); // 刚活跃
    const arbiter = fakeArbiter();
    const { skill } = makeSkill({ clock, arbiter, presence });

    // 未到阈值(默认 10min):沉默。
    clock.advance(5 * MIN);
    await skill.tick();
    expect(arbiter.requests).toHaveLength(0);
    expect(skill.lastDecision?.action).toBe('silent');

    // 超过阈值:想念一次。
    clock.advance(6 * MIN); // 累计 11min idle
    await skill.tick();
    expect(arbiter.requests).toHaveLength(1);
    expect(skill.lastDecision?.action).toBe('speak');
    expect(skill.lastDecision?.arc).toBe('miss');
    expect(arbiter.requests[0]?.skillId).toBe(IDLE_EMOTION_ARC_SKILL_ID);
    expect(arbiter.requests[0]?.priority).toBe('PERCEPTION');
    expect(arbiter.requests[0]?.deferrable).toBe(true);

    // 同 episode 继续 idle:不再想念(once-per-episode 去重)。
    clock.advance(20 * MIN);
    await skill.tick();
    expect(arbiter.requests).toHaveLength(1); // 仍 1 条
    expect(skill.lastDecision?.action).toBe('silent');
    expect(skill.lastDecision?.reason).toContain('once-per-episode');
  });

  it('② 长缺席后回来触发一次重逢;同 episode 不重复', async () => {
    const start = 100 * MIN;
    const clock = fakeClock(start);
    const presence = fakePresence(start, 'ep-1');
    const arbiter = fakeArbiter();
    const { skill } = makeSkill({ clock, arbiter, presence });

    // 长 idle(达想念+重逢阈值)→ 先想念一次。
    clock.advance(15 * MIN);
    await skill.tick();
    expect(skill.lastDecision?.arc).toBe('miss');
    const afterMiss = arbiter.requests.length;

    // 用户回来:刷新 lastActive + 轮转 episodeId。
    presence.last = clock.now();
    presence.episode = 'ep-2';
    await skill.tick();
    expect(arbiter.requests).toHaveLength(afterMiss + 1);
    expect(skill.lastDecision?.action).toBe('speak');
    expect(skill.lastDecision?.arc).toBe('reunion');
    expect(skill.lastDecision?.episodeId).toBe('ep-2');

    // 同 episode 再 tick:不重复重逢。
    await skill.tick();
    expect(arbiter.requests).toHaveLength(afterMiss + 1);
    expect(skill.lastDecision?.action).toBe('silent');
  });

  it('② 短暂离开(上段 idle 不够长)回来 → 不触发重逢', async () => {
    const start = 100 * MIN;
    const clock = fakeClock(start);
    const presence = fakePresence(start, 'ep-1');
    const arbiter = fakeArbiter();
    const { skill } = makeSkill({ clock, arbiter, presence });

    // 仅 idle 3min(< 重逢阈值 10min):沉默。
    clock.advance(3 * MIN);
    await skill.tick();
    expect(arbiter.requests).toHaveLength(0);

    // 回来(新 episode):上段 idle 太短 → 不重逢。
    presence.last = clock.now();
    presence.episode = 'ep-2';
    await skill.tick();
    expect(arbiter.requests).toHaveLength(0);
    expect(skill.lastDecision?.action).toBe('silent');
  });

  it('③ 未到阈值 → 沉默且扣 no-action 预算', async () => {
    const start = 100 * MIN;
    const clock = fakeClock(start);
    const presence = fakePresence(start, 'ep-1');
    const { skill, budget, queue } = makeSkill({ clock, presence, maxNoActionRetries: 2 });

    clock.advance(2 * MIN);
    await skill.tick(); // 2→1
    expect(budget.remaining).toBe(1);
    expect(queue.size).toBe(1);
    expect(skill.lastDecision?.budgetConsumed).toBe(true);

    await skill.tick(); // 1→0
    expect(budget.remaining).toBe(0);
    expect(queue.size).toBe(2);

    await skill.tick(); // 0:不再合成,仍沉默
    expect(budget.remaining).toBe(0);
    expect(queue.size).toBe(2);
    expect(skill.lastDecision?.action).toBe('silent');
    expect(skill.lastDecision?.budgetConsumed).toBe(false);
  });

  it('③ 成功想念(speak)不扣预算', async () => {
    const start = 100 * MIN;
    const clock = fakeClock(start);
    const presence = fakePresence(start, 'ep-1');
    const { skill, budget } = makeSkill({ clock, presence });

    clock.advance(15 * MIN);
    await skill.tick();
    expect(skill.lastDecision?.action).toBe('speak');
    expect(budget.remaining).toBe(3); // 未扣
  });

  it('③ disabled → 沉默且不调端口/仲裁/不扣预算', async () => {
    const start = 100 * MIN;
    const clock = fakeClock(start);
    const presence = fakePresence(start - 30 * MIN, 'ep-1'); // 已长 idle
    const arbiter = fakeArbiter();
    const { skill, budget } = makeSkill({ clock, arbiter, presence, enabled: false });

    await skill.tick();
    expect(arbiter.requests).toHaveLength(0);
    expect(skill.lastDecision?.action).toBe('disabled');
    expect(budget.remaining).toBe(3);
  });

  it('③ 仲裁 drop(忙且不可延续)→ 视同无产出:沉默 + 扣预算 + 不记去重(下次重试)', async () => {
    const start = 100 * MIN;
    const clock = fakeClock(start);
    const presence = fakePresence(start, 'ep-1');
    const arbiter = fakeArbiter({ decision: 'drop', preempted: false, reason: 'busy: 丢弃' });
    const { skill, budget } = makeSkill({ clock, arbiter, presence });

    clock.advance(15 * MIN);
    await skill.tick(); // 想念被 drop
    expect(arbiter.requests).toHaveLength(1);
    expect(skill.lastDecision?.action).toBe('silent');
    expect(skill.lastDecision?.budgetConsumed).toBe(true);
    expect(budget.remaining).toBe(2);

    // 未记去重 → 下次仍尝试想念。
    clock.advance(1 * MIN);
    arbiter.outcome = { decision: 'speak', preempted: false, reason: 'idle' };
    await skill.tick();
    expect(arbiter.requests).toHaveLength(2);
    expect(skill.lastDecision?.action).toBe('speak');
    expect(skill.lastDecision?.arc).toBe('miss');
  });

  it('④ once-per-episode:重逢后又长 idle → 新一轮想念可再触发(键为 episode)', async () => {
    const start = 100 * MIN;
    const clock = fakeClock(start);
    const presence = fakePresence(start, 'ep-1');
    const arbiter = fakeArbiter();
    const { skill } = makeSkill({ clock, arbiter, presence });

    clock.advance(15 * MIN);
    await skill.tick(); // ep-1 想念
    expect(skill.lastDecision?.arc).toBe('miss');

    presence.last = clock.now();
    presence.episode = 'ep-2';
    await skill.tick(); // ep-2 重逢
    expect(skill.lastDecision?.arc).toBe('reunion');

    // ep-2 又长 idle → ep-2 的想念(不同 episode,允许)。
    clock.advance(15 * MIN);
    await skill.tick();
    expect(skill.lastDecision?.action).toBe('speak');
    expect(skill.lastDecision?.arc).toBe('miss');
    expect(skill.lastDecision?.episodeId).toBe('ep-2');
  });

  it('情绪强度:注入旋钮端口调制文案语气;否则用 config 默认', async () => {
    const start = 100 * MIN;
    const clock = fakeClock(start);
    const presence = fakePresence(start, 'ep-1');
    const arbiter = fakeArbiter();
    const { skill } = makeSkill({ clock, arbiter, presence, emotion: fakeEmotion(0.9) });

    clock.advance(15 * MIN);
    await skill.tick();
    expect(skill.lastDecision?.intensity).toBe(0.9);
    expect(skill.lastDecision?.text).toBe(renderArcText('miss', 0.9));
  });

  it('情绪强度:端口返回越界值被钳到 [0,1]', async () => {
    const start = 100 * MIN;
    const clock = fakeClock(start);
    const presence = fakePresence(start, 'ep-1');
    const { skill } = makeSkill({ clock, presence, emotion: fakeEmotion(5) });

    clock.advance(15 * MIN);
    await skill.tick();
    expect(skill.lastDecision?.intensity).toBe(1);
  });

  it('renderArcText:高/低强度文案区分,想念/重逢区分', () => {
    expect(renderArcText('miss', 0.9)).not.toBe(renderArcText('miss', 0.1));
    expect(renderArcText('reunion', 0.9)).not.toBe(renderArcText('reunion', 0.1));
    expect(renderArcText('miss', 0.9)).not.toBe(renderArcText('reunion', 0.9));
  });
});

describe('IdleEmotionArcSkill — 经 SkillScheduler 接入(inflight 锁 + enabled 现读)', () => {
  it('调度器:disabled 时不 tick,enabled 后想念', async () => {
    const start = 100 * MIN;
    const clock = fakeClock(start);
    const presence = fakePresence(start - 30 * MIN, 'ep-1'); // 已长 idle
    const arbiter = fakeArbiter();
    const { config, enabled } = enabledSetConfig();
    const budget = createBudgetState(config);
    const queue = new PriorityEventQueue();
    const skill = new IdleEmotionArcSkill({ presence, arbiter, clock, config, budget, queue });

    const sched = new SkillScheduler(config);
    sched.register(skill);

    await sched.tick(); // disabled:不启动
    expect(sched.isStarted(IDLE_EMOTION_ARC_SKILL_ID)).toBe(false);
    expect(arbiter.requests).toHaveLength(0);

    enabled.add(IDLE_EMOTION_ARC_SKILL_ID);
    await sched.tick(); // 启动(本 tick 仅 start,不 tick)
    expect(sched.isStarted(IDLE_EMOTION_ARC_SKILL_ID)).toBe(true);

    await sched.tick(); // 第一次真 tick → 想念
    await Promise.resolve();
    await Promise.resolve();
    expect(arbiter.requests).toHaveLength(1);
    expect(sched.errorCount).toBe(0);
  });
});
