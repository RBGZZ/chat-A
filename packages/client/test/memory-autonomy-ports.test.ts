import { describe, it, expect } from 'vitest';
import type { MemoryRecord } from '@chat-a/memory';
import {
  createOpenThreadPort,
  createPresencePort,
  createCompanionCandidateSource,
  DEFAULT_PRESENCE_PERSON_ID,
  type OpenThreadStore,
} from '../src/assembly/memory-autonomy-ports';

/**
 * memory→autonomy 端口适配器测试(companion-live-wiring,不触网):
 * 假 store / 注入时钟,断言 open-thread 映射、presence 最小在场近似、候选源接通与降级。
 */

function rec(partial: Partial<MemoryRecord> & { id: number; text: string }): MemoryRecord {
  return {
    kind: undefined,
    createdAtMs: 0,
    lastSeenAtMs: 1000,
    hits: 0,
    subject: 'person',
    personId: 'primary',
    ...partial,
  };
}

describe('client/createOpenThreadPort — 把记忆映射成 OpenThread', () => {
  it('映射 id/topic/personId/lastMentionedAtMs;省略 dueAtMs/personName', async () => {
    const store: OpenThreadStore = {
      openThreads: () => [
        rec({ id: 7, text: '明天要面试', personId: 'p-friend', lastSeenAtMs: 5000 }),
      ],
    };
    const port = createOpenThreadPort(store);
    const out = await port.listOpenThreads();
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: '7',
      topic: '明天要面试',
      personId: 'p-friend',
      lastMentionedAtMs: 5000,
    });
    // 未提供 due / personName
    expect(out[0]!.dueAtMs).toBeUndefined();
    expect(out[0]!.personName).toBeUndefined();
  });

  it('记忆无 personId(agent 主语)→ 回落主用户占位 id', async () => {
    const store: OpenThreadStore = {
      openThreads: () => [rec({ id: 1, text: 'x', personId: undefined })],
    };
    const out = await createOpenThreadPort(store).listOpenThreads();
    expect(out[0]!.personId).toBe(DEFAULT_PRESENCE_PERSON_ID);
  });

  it('store.openThreads 抛错 → 优雅降级返回 [](候选回路不中断)', async () => {
    const store: OpenThreadStore = {
      openThreads: () => {
        throw new Error('db fail');
      },
    };
    const out = await createOpenThreadPort(store).listOpenThreads();
    expect(out).toEqual([]);
  });
});

describe('client/createPresencePort — 最小在场近似', () => {
  it('无活跃事件 → lastUserActiveAtMs 回落构造时刻(注入时钟)', () => {
    let t = 100;
    const presence = createPresencePort({ clock: { now: () => t } });
    expect(presence.lastUserActiveAtMs()).toBe(100);
    // 推进时钟但未 markActive:lastActive 不变(仍是构造时刻)
    t = 999;
    expect(presence.lastUserActiveAtMs()).toBe(100);
  });

  it('markActive 刷新 lastActive 并轮转 episodeId', () => {
    let t = 100;
    const presence = createPresencePort({ clock: { now: () => t } });
    const ep0 = presence.currentEpisodeId();
    t = 500;
    presence.markActive();
    expect(presence.lastUserActiveAtMs()).toBe(500);
    const ep1 = presence.currentEpisodeId();
    expect(ep1).not.toBe(ep0); // 新活跃点 → 新 episode
    // 同一活跃点内 episodeId 稳定
    expect(presence.currentEpisodeId()).toBe(ep1);
  });
});

describe('client/createCompanionCandidateSource — 合并未了话题 + idle 弧', () => {
  it('未了话题落新鲜度窗 → 产出未了话题候选', async () => {
    // clock=now;话题 lastMentioned 在窗内(距 now 足够久但未陈旧)
    const now = 10_000_000;
    const store: OpenThreadStore = {
      openThreads: () => [rec({ id: 1, text: '上次说的旅行计划', lastSeenAtMs: now - 2 * 60 * 60 * 1000 })],
    };
    const presence = createPresencePort({ clock: { now: () => now } });
    const src = createCompanionCandidateSource({ store, presence, clock: { now: () => now } });
    const out = await src.gather({ signalKind: 'signal:temporal:tick' });
    expect(out.length).toBeGreaterThan(0);
    // 候选文本应包含话题主题
    expect(out.some((c) => c.includes('旅行计划'))).toBe(true);
  });

  it('store 抛错(单源)被隔离 → 合并源不中断,仍可产出', async () => {
    const now = 10_000_000;
    const store: OpenThreadStore = {
      openThreads: () => {
        throw new Error('boom');
      },
    };
    // presence idle 远超想念阈值 → idle 弧产出候选(open-thread 源被隔离后仍有这一路)
    const presence = createPresencePort({ clock: { now: () => now } });
    presence.markActive(); // lastActive=now;但下面 gather 用更晚的 clock 制造 idle
    const laterClock = { now: () => now + 7 * 24 * 60 * 60 * 1000 };
    const src = createCompanionCandidateSource({ store, presence, clock: laterClock });
    const out = await src.gather({ signalKind: 'signal:temporal:tick' });
    expect(Array.isArray(out)).toBe(true); // 不抛
  });
});
