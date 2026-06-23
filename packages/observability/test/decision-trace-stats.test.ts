import { describe, it, expect, afterEach, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SqliteDecisionTraceSink,
  DecisionTraceStats,
  nearestRankPercentile,
  type DecisionTrace,
} from '../src/index';

const BASE: DecisionTrace = {
  correlationId: 's1/t1/0',
  sessionId: 's1',
  turnId: 't1',
  createdAtMs: 1000,
  latencyMs: 10,
  userText: '速溶咖啡更好',
  recalled: [{ text: '用户喜欢猫', subject: 'person', hits: 2, kind: 'user_profile' }],
  emotion: 'content',
  pad: { pleasure: 0.3, arousal: 0.1, dominance: 0 },
  assertiveness: 0.8,
  stanceNotions: ['手冲比速溶值得。'],
  system: '[骨架]',
  messages: [{ role: 'user', content: '速溶咖啡更好' }],
  provider: 'fake',
  model: 'fake-1',
  reply: '我倒觉得手冲更值得。',
};

const tmpFiles: string[] = [];
function tmpDb(name: string): string {
  const p = join(tmpdir(), `chat-a-trace-stats-${process.pid}-${name}.db`);
  tmpFiles.push(p);
  return p;
}
afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(f + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
});

/** 写入若干 trace 后关闭 sink(WAL 落盘),供只读 stats 读取。 */
function seed(path: string, traces: DecisionTrace[]): void {
  const sink = new SqliteDecisionTraceSink({ path });
  for (const t of traces) sink.record(t);
  sink.close();
}

describe('nearestRankPercentile', () => {
  it('n=0 返回 0', () => {
    expect(nearestRankPercentile([], 50)).toBe(0);
    expect(nearestRankPercentile([], 95)).toBe(0);
  });

  it('n=1 时 p50=p95=唯一值', () => {
    expect(nearestRankPercentile([42], 50)).toBe(42);
    expect(nearestRankPercentile([42], 95)).toBe(42);
  });

  it('偶数样本 nearest-rank', () => {
    const s = [10, 20, 30, 40];
    expect(nearestRankPercentile(s, 50)).toBe(20); // rank=2 → idx=1
    expect(nearestRankPercentile(s, 95)).toBe(40); // rank=4 → idx=3
  });

  it('奇数样本 nearest-rank', () => {
    const s = [10, 20, 30, 40, 50];
    expect(nearestRankPercentile(s, 50)).toBe(30); // rank=ceil(2.5)=3 → idx=2
    expect(nearestRankPercentile(s, 95)).toBe(50); // rank=ceil(4.75)=5 → idx=4
  });
});

describe('DecisionTraceStats.compute 聚合正确', () => {
  it('计数分布 / 总回合数 / session 计数与预期一致', () => {
    const path = tmpDb('counts');
    seed(path, [
      { ...BASE, sessionId: 's1', turnId: 't1', emotion: 'content', provider: 'fake' },
      { ...BASE, sessionId: 's1', turnId: 't2', emotion: 'content', provider: 'deepseek' },
      { ...BASE, sessionId: 's2', turnId: 't3', emotion: 'sad', provider: 'fake' },
    ]);
    const stats = new DecisionTraceStats({ path });
    const r = stats.compute();
    expect(r.totalTurns).toBe(3);
    expect(r.emotionCounts).toEqual({ content: 2, sad: 1 });
    expect(r.providerCounts).toEqual({ fake: 2, deepseek: 1 });
    expect(r.sessionTurnCounts).toEqual({ s1: 2, s2: 1 });
    stats.close();
  });

  it('posture 分布排除无姿态回合', () => {
    const path = tmpDb('posture');
    seed(path, [
      { ...BASE, turnId: 't1', posture: 'sulking' },
      { ...BASE, turnId: 't2', posture: 'withdrawn' },
      { ...BASE, turnId: 't3', posture: 'sulking' },
      { ...BASE, turnId: 't4' }, // 无姿态
    ]);
    const stats = new DecisionTraceStats({ path });
    const r = stats.compute();
    expect(r.totalTurns).toBe(4);
    // 只统计有姿态的 3 条。
    expect(r.postureCounts).toEqual({ sulking: 2, withdrawn: 1 });
    stats.close();
  });

  it('latency 均值 + 分位(nearest-rank)', () => {
    const path = tmpDb('latency');
    const lats = [10, 20, 30, 40];
    seed(
      path,
      lats.map((ms, i) => ({ ...BASE, turnId: `t${i}`, latencyMs: ms })),
    );
    const stats = new DecisionTraceStats({ path });
    const r = stats.compute();
    expect(r.latency.count).toBe(4);
    expect(r.latency.mean).toBe(25); // (10+20+30+40)/4
    expect(r.latency.p50).toBe(20);
    expect(r.latency.p95).toBe(40);
    stats.close();
  });

  it('recall 命中:均值长度 + 有召回占比', () => {
    const path = tmpDb('recall');
    seed(path, [
      // 2 条召回
      { ...BASE, turnId: 't1', recalled: [
        { text: 'a', subject: 'person', hits: 1 },
        { text: 'b', subject: 'person', hits: 1 },
      ] },
      // 0 条召回
      { ...BASE, turnId: 't2', recalled: [] },
      // 0 条召回
      { ...BASE, turnId: 't3', recalled: [] },
      // 2 条召回
      { ...BASE, turnId: 't4', recalled: [
        { text: 'c', subject: 'person', hits: 1 },
        { text: 'd', subject: 'person', hits: 1 },
      ] },
    ]);
    const stats = new DecisionTraceStats({ path });
    const r = stats.compute();
    // 总长度 = 2+0+0+2 = 4,4 回合 → 均值 1
    expect(r.recall.meanRecalledLen).toBe(1);
    // 有召回的 2 / 4 = 0.5
    expect(r.recall.recalledRatio).toBe(0.5);
    stats.close();
  });
});

describe('DecisionTraceStats 优雅降级', () => {
  it('库不存在:返回全空统计 + 告警,不抛', () => {
    const path = tmpDb('absent'); // 从不创建
    const onWarn = vi.fn();
    const stats = new DecisionTraceStats({ path, onWarn });
    const r = stats.compute();
    expect(r.totalTurns).toBe(0);
    expect(r.emotionCounts).toEqual({});
    expect(r.postureCounts).toEqual({});
    expect(r.providerCounts).toEqual({});
    expect(r.sessionTurnCounts).toEqual({});
    expect(r.latency).toEqual({ count: 0, mean: 0, p50: 0, p95: 0 });
    expect(r.recall).toEqual({ meanRecalledLen: 0, recalledRatio: 0 });
    expect(onWarn).toHaveBeenCalled();
    stats.close();
  });

  it('损坏库文件:不抛,降级为空统计 + 告警', () => {
    const path = tmpDb('corrupt');
    writeFileSync(path, 'not a sqlite database at all');
    const onWarn = vi.fn();
    const stats = new DecisionTraceStats({ path, onWarn });
    expect(() => stats.compute()).not.toThrow();
    expect(stats.compute().totalTurns).toBe(0);
    expect(onWarn).toHaveBeenCalled();
    stats.close();
  });

  it('空库(已建表无数据):totalTurns=0,分位为 0', () => {
    const path = tmpDb('empty');
    seed(path, []); // 建库建表但不写
    const stats = new DecisionTraceStats({ path });
    const r = stats.compute();
    expect(r.totalTurns).toBe(0);
    expect(r.latency).toEqual({ count: 0, mean: 0, p50: 0, p95: 0 });
    expect(r.recall).toEqual({ meanRecalledLen: 0, recalledRatio: 0 });
    stats.close();
  });

  it('close 幂等,二次调用不抛', () => {
    const path = tmpDb('close');
    seed(path, [BASE]);
    const stats = new DecisionTraceStats({ path });
    stats.close();
    expect(() => stats.close()).not.toThrow();
  });
});
