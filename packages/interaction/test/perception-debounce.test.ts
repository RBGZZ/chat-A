import { describe, it, expect } from 'vitest';
import {
  edgeLatch,
  INITIAL_EDGE_STATE,
  slidingWindowDetect,
  aggregateWindow,
  type Sample,
  type AggregateInput,
} from '../src/index';

describe('perception/edgeLatch(第 1 层,纯函数)', () => {
  it('false→true 上升沿;持续 true 不重复触发', () => {
    let s = INITIAL_EDGE_STATE;
    const r1 = edgeLatch(s, true);
    expect(r1.rising).toBe(true);
    expect(r1.falling).toBe(false);
    s = r1.state;
    const r2 = edgeLatch(s, true); // 仍高电平
    expect(r2.rising).toBe(false);
    s = r2.state;
    const r3 = edgeLatch(s, false); // 下降沿
    expect(r3.falling).toBe(true);
    expect(r3.rising).toBe(false);
  });

  it('同输入同输出(纯函数)', () => {
    const a = edgeLatch({ level: false }, true);
    const b = edgeLatch({ level: false }, true);
    expect(a).toEqual(b);
  });
});

describe('perception/slidingWindowDetect(第 2 层,golden)', () => {
  const samples: readonly Sample[] = [
    { atMs: 100, hit: true },
    { atMs: 150, hit: false },
    { atMs: 200, hit: true },
    { atMs: 250, hit: true },
    { atMs: 900, hit: true }, // 窗外
  ];

  it('窗内命中数 ≥ minHits → triggered', () => {
    const r = slidingWindowDetect(samples, 300, { windowMs: 250, minHits: 3 });
    // 窗 [50,300]:命中 100/200/250 = 3 次,150 不命中
    expect(r.hits).toBe(3);
    expect(r.total).toBe(4);
    expect(r.triggered).toBe(true);
  });

  it('minHits 提高 → 不触发', () => {
    const r = slidingWindowDetect(samples, 300, { windowMs: 250, minHits: 4 });
    expect(r.triggered).toBe(false);
  });

  it('窗外样本被排除', () => {
    const r = slidingWindowDetect(samples, 1000, { windowMs: 50, minHits: 1 });
    // 窗 [950,1000]:无样本
    expect(r.total).toBe(0);
    expect(r.triggered).toBe(false);
  });

  it('同输入同输出', () => {
    const cfg = { windowMs: 250, minHits: 2 };
    expect(slidingWindowDetect(samples, 300, cfg)).toEqual(
      slidingWindowDetect(samples, 300, cfg),
    );
  });
});

describe('perception/aggregateWindow(第 3 层,合并多源)', () => {
  const inputs: readonly AggregateInput[] = [
    { kind: 'system:notification', description: '通知A', atMs: 100, confidence: 0.5, metadata: { a: 1 } },
    { kind: 'system:notification', description: '通知B', atMs: 120, confidence: 0.9, metadata: { b: 2 } },
    { kind: 'temporal:tick', description: '心跳', atMs: 110, confidence: 1 },
    { kind: 'system:notification', description: '窗外', atMs: 999, confidence: 1 },
  ];

  it('同 kind 合并为单 signal,confidence 取最大、描述取最高置信者、metadata 浅合并', () => {
    const out = aggregateWindow(inputs, 300, { windowMs: 300 });
    expect(out).toHaveLength(2); // notification + tick(窗外那条被排除)
    const notif = out.find((s) => s.kind === 'system:notification')!;
    expect(notif.confidence).toBe(0.9);
    expect(notif.description).toBe('通知B');
    expect(notif.mergedCount).toBe(2);
    expect(notif.metadata).toEqual({ a: 1, b: 2 });
  });

  it('确定性排序 + 同输入同输出', () => {
    const a = aggregateWindow(inputs, 300);
    const b = aggregateWindow(inputs, 300);
    expect(a).toEqual(b);
    expect(a.map((s) => s.kind)).toEqual([...a.map((s) => s.kind)].sort());
  });

  it('空窗 → 空输出', () => {
    expect(aggregateWindow([], 300)).toEqual([]);
  });
});
