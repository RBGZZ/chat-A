import { describe, expect, it } from 'vitest';
import {
  openThreadCandidateSource,
  idleArcCandidateSource,
  combinedCandidateSource,
  type ProactiveCandidateSource,
} from '../src/candidate-source';
import type { OpenThread, OpenThreadPort } from '../src/open-thread';
import type { EmotionIntensityPort, PresencePort } from '../src/idle-emotion-arc';
import type { Clock } from '../src/types';

const NOW = 10_000_000;
const clock: Clock = { now: () => NOW };
const ctx = { signalKind: 'signal:temporal:tick' as const };

function fakeThreadPort(threads: OpenThread[]): OpenThreadPort {
  return { listOpenThreads: async () => threads };
}

function fakePresence(lastActiveAtMs: number, episodeId = 'e1'): PresencePort {
  return { lastUserActiveAtMs: () => lastActiveAtMs, currentEpisodeId: () => episodeId };
}

describe('autonomy/openThreadCandidateSource(缝 3:open-thread 真候选)', () => {
  it('新鲜度落窗内 → 渲染真实跟进候选(非 signal 描述)', async () => {
    const src = openThreadCandidateSource(
      fakeThreadPort([
        // 距上次提及 2h:在 [1h, 7d] 窗口内 → 值得回扣。
        { id: 't1', topic: '面试', personId: 'p1', personName: '阿杰', lastMentionedAtMs: NOW - 2 * 60 * 60 * 1000 },
      ]),
      clock,
    );
    const out = await src.gather(ctx);
    expect(out.length).toBe(1);
    expect(out[0]).toContain('面试');
    expect(out[0]).toContain('阿杰');
  });

  it('太新(话音未落)→ 无候选;到 due → 强信号产候选', async () => {
    const tooFresh = openThreadCandidateSource(
      fakeThreadPort([{ id: 't1', topic: '午饭', personId: 'p1', lastMentionedAtMs: NOW - 60 * 1000 }]),
      clock,
    );
    expect((await tooFresh.gather(ctx)).length).toBe(0);

    const due = openThreadCandidateSource(
      fakeThreadPort([
        { id: 't2', topic: '体检', personId: 'p1', lastMentionedAtMs: NOW - 60 * 1000, dueAtMs: NOW - 1 },
      ]),
      clock,
    );
    const out = await due.gather(ctx);
    expect(out.length).toBe(1);
    expect(out[0]).toContain('体检');
  });

  it('多条候选按「到 due 优先 + 越新鲜越前」择前 N(默认 1)', async () => {
    const src = openThreadCandidateSource(
      fakeThreadPort([
        { id: 'a', topic: '旧事', personId: 'p1', lastMentionedAtMs: NOW - 5 * 24 * 60 * 60 * 1000 },
        { id: 'b', topic: '近事', personId: 'p1', lastMentionedAtMs: NOW - 2 * 60 * 60 * 1000 },
      ]),
      clock,
    );
    const out = await src.gather(ctx);
    expect(out.length).toBe(1);
    expect(out[0]).toContain('近事'); // 越新鲜越靠前
  });
});

describe('autonomy/idleArcCandidateSource(缝 3:情绪弧真候选)', () => {
  it('idle 超想念阈值 → 想念候选', async () => {
    // idle 20min > 默认 10min 阈值。
    const src = idleArcCandidateSource(fakePresence(NOW - 20 * 60 * 1000), clock);
    const out = await src.gather(ctx);
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/想你|来找我/);
  });

  it('idle 未达阈值 → 无候选', async () => {
    const src = idleArcCandidateSource(fakePresence(NOW - 60 * 1000), clock);
    expect((await src.gather(ctx)).length).toBe(0);
  });

  it('注入 emotion 强度调制语气(高强度更直白想念)', async () => {
    const emotion: EmotionIntensityPort = { arcIntensity: () => 0.9 };
    const src = idleArcCandidateSource(fakePresence(NOW - 20 * 60 * 1000), clock, emotion);
    const out = await src.gather(ctx);
    expect(out[0]).toContain('想你');
  });
});

describe('autonomy/combinedCandidateSource(合并去空 + 隔离)', () => {
  it('合并多源、去空白去重、保序', async () => {
    const a: ProactiveCandidateSource = { gather: () => ['  ', '甲'] };
    const b: ProactiveCandidateSource = { gather: () => ['甲', '乙'] };
    const out = await combinedCandidateSource([a, b]).gather(ctx);
    expect(out).toEqual(['甲', '乙']);
  });

  it('某源抛错被隔离,其它源照常', async () => {
    const boom: ProactiveCandidateSource = {
      gather: () => {
        throw new Error('boom');
      },
    };
    const ok: ProactiveCandidateSource = { gather: () => ['乙'] };
    const out = await combinedCandidateSource([boom, ok]).gather(ctx);
    expect(out).toEqual(['乙']);
  });

  it('全空 → 空数组(调用方回落占位)', async () => {
    const empty: ProactiveCandidateSource = { gather: () => [] };
    expect((await combinedCandidateSource([empty]).gather(ctx)).length).toBe(0);
  });
});
