import { describe, it, expect } from 'vitest';
import {
  SelfNotionsManager,
  InMemorySelfNotionStore,
  createKvSelfNotionStore,
  clampStrengthDelta,
  applyStrengthDelta,
  buildSelfNotionSnapshot,
  topicKeyOf,
  effectiveStrength,
  migrateSelfNotionsState,
  seedToState,
  XIAOXUE_SEED,
  SELF_NOTION_BASE_STRENGTH,
  MAX_STRENGTH_DELTA_PER_STEP,
  SELF_NOTIONS_SCHEMA_VERSION,
  type KvLike,
  type SelfNotion,
  type SelfNotionEvolver,
  type SelfNotionStrengthDelta,
} from '../src/index';

const SEED: readonly SelfNotion[] = [
  { topic: ['咖啡', 'coffee'], position: '手冲比速溶值得。' },
  { topic: ['熬夜', '晚睡'], position: '熬夜伤身。' },
];

/** 固定 delta 的演化器(record-replay 风:确定性返回)。 */
function fixedEvolver(deltas: readonly SelfNotionStrengthDelta[] | null): SelfNotionEvolver {
  return { evolve: () => Promise.resolve(deltas) };
}

function makeKv(): KvLike {
  const m = new Map<string, string>();
  return { getState: (k) => m.get(k), setState: (k, v) => void m.set(k, v) };
}

describe('self-notions 纯函数(golden)', () => {
  it('clampStrengthDelta:钳到 [0,max],负数/非有限/超限', () => {
    expect(clampStrengthDelta(0.02, 0.05)).toBe(0.02);
    expect(clampStrengthDelta(0.5, 0.05)).toBe(0.05); // 超上限被钳
    expect(clampStrengthDelta(-0.1, 0.05)).toBe(0); // 只增不减
    expect(clampStrengthDelta(0, 0.05)).toBe(0);
    expect(clampStrengthDelta(Number.NaN, 0.05)).toBe(0);
    expect(clampStrengthDelta(Infinity, 0.05)).toBe(0); // 非有限 → 0(不演化该条)
    expect(clampStrengthDelta(0.02)).toBe(0.02); // 默认上限 = MAX_STRENGTH_DELTA_PER_STEP
    expect(MAX_STRENGTH_DELTA_PER_STEP).toBeGreaterThan(0);
  });

  it('effectiveStrength:显式取显式,缺省取基线', () => {
    expect(effectiveStrength({ topic: ['x'], position: 'p' })).toBe(SELF_NOTION_BASE_STRENGTH);
    expect(effectiveStrength({ topic: ['x'], position: 'p', strength: 0.8 })).toBe(0.8);
    expect(effectiveStrength({ topic: ['x'], position: 'p', strength: 2 })).toBe(1); // clamp01
  });

  it('applyStrengthDelta:strength clamp01 + affirmCount+1 + 缺省用基线', () => {
    const a = applyStrengthDelta({ topic: ['x'], position: 'p' }, 0.05);
    expect(a.strength).toBeCloseTo(SELF_NOTION_BASE_STRENGTH + 0.05);
    expect(a.affirmCount).toBe(1);

    const b = applyStrengthDelta({ topic: ['x'], position: 'p', strength: 0.99, affirmCount: 3 }, 0.05);
    expect(b.strength).toBe(1); // clamp01 封顶
    expect(b.affirmCount).toBe(4);
  });

  it('topicKeyOf:取首关键词归一', () => {
    expect(topicKeyOf({ topic: ['Coffee', '咖啡'], position: 'p' })).toBe('coffee');
    expect(topicKeyOf({ topic: ['  熬夜  '], position: 'p' })).toBe('熬夜');
  });

  it('buildSelfNotionSnapshot:字段正确', () => {
    const s = buildSelfNotionSnapshot(0.5, 0.55, 0.05, 7, 'coffee', 't0');
    expect(s).toEqual({ turn: 7, at: 't0', topicKey: 'coffee', before: 0.5, after: 0.55, delta: 0.05 });
  });
});

describe('self-notions 迁移(数据迁移纪律)', () => {
  it('无版本旧 SelfNotion[] → v1,补缺省,不丢 topic/position', () => {
    const old = [{ topic: ['咖啡'], position: '手冲值得。' }];
    const m = migrateSelfNotionsState(old);
    expect(m).not.toBeNull();
    expect(m!.version).toBe(SELF_NOTIONS_SCHEMA_VERSION);
    expect(m!.notions[0]?.topic).toEqual(['咖啡']);
    expect(m!.notions[0]?.position).toBe('手冲值得。');
    expect(m!.notions[0]?.strength).toBe(SELF_NOTION_BASE_STRENGTH);
    expect(m!.notions[0]?.affirmCount).toBe(0);
  });

  it('带 notions 的对象(无 version)也迁移', () => {
    const m = migrateSelfNotionsState({ notions: [{ topic: ['x'], position: 'p', strength: 0.7 }] });
    expect(m!.notions[0]?.strength).toBe(0.7);
  });

  it('notions 损坏/非数组 → null(回落种子)', () => {
    expect(migrateSelfNotionsState({ notions: 'oops' })).toBeNull();
    expect(migrateSelfNotionsState(42)).toBeNull();
    expect(migrateSelfNotionsState({ notions: [{ topic: [], position: '' }] })).toBeNull(); // 全损坏
  });

  it('history 损坏(非数组)→ 丢 history 不丢 notions', () => {
    const m = migrateSelfNotionsState({ notions: [{ topic: ['x'], position: 'p' }], history: 'bad' });
    expect(m).not.toBeNull();
    expect(m!.notions).toHaveLength(1);
    expect(m!.history).toBeUndefined();
  });

  it('合法 history 保留', () => {
    const hist = [{ turn: 1, at: 't', topicKey: 'x', before: 0.5, after: 0.55, delta: 0.05 }];
    const m = migrateSelfNotionsState({ notions: [{ topic: ['x'], position: 'p' }], history: hist });
    expect(m!.history).toHaveLength(1);
  });
});

describe('SelfNotionsManager: 持久化往返 + seed', () => {
  it('无 store 无 evolver:current() 严格等于种子(等价当前只读种子)', async () => {
    const mgr = new SelfNotionsManager({ seedNotions: SEED });
    // 种子被规整(补缺省 strength/affirmCount),但 topic/position 与命中行为不变。
    expect(mgr.current().map((n) => n.position)).toEqual(SEED.map((n) => n.position));
    await mgr.advance('随便说说', 1); // 无 evolver → no-op
    expect(mgr.current().map((n) => n.position)).toEqual(SEED.map((n) => n.position));
    expect(mgr.state().history).toBeUndefined();
  });

  it('首启用种子并 seed 落库', () => {
    const store = new InMemorySelfNotionStore();
    expect(store.load()).toBeNull();
    const mgr = new SelfNotionsManager({ seedNotions: SEED, store });
    expect(store.load()).not.toBeNull(); // seed 已落库
    expect(store.load()!.version).toBe(SELF_NOTIONS_SCHEMA_VERSION);
    expect(mgr.current()).toHaveLength(2);
  });

  it('演化后经 KvLike 持久化、跨重启读回(含强度 + history)', async () => {
    const kv = makeKv();
    const store = createKvSelfNotionStore(kv);
    const e1 = new SelfNotionsManager({
      seedNotions: SEED,
      store,
      evolver: fixedEvolver([{ topicKey: '咖啡', delta: 0.05 }]),
      now: () => 't1',
    });
    await e1.advance('又聊到手冲咖啡', 5);
    const saved = e1.state();
    expect(saved.notions[0]?.strength).toBeCloseTo(SELF_NOTION_BASE_STRENGTH + 0.05);
    expect(saved.history).toHaveLength(1);

    const e2 = new SelfNotionsManager({ seedNotions: SEED, store });
    expect(e2.state().notions[0]?.strength).toBeCloseTo(SELF_NOTION_BASE_STRENGTH + 0.05);
    expect(e2.state().history).toHaveLength(1);
  });

  it('store 损坏 → 回落种子(不崩)', () => {
    const kv = makeKv();
    kv.setState('persona:self_notions', '{ broken json');
    const mgr = new SelfNotionsManager({ seedNotions: SEED, store: createKvSelfNotionStore(kv) });
    expect(mgr.current()).toHaveLength(2); // 回落种子
  });
});

describe('SelfNotionsManager: 保守强度演化(opt-in)', () => {
  it('确立某立场 → 强度上升(≤上限) + affirmCount+1 + history+1', async () => {
    const mgr = new SelfNotionsManager({
      seedNotions: SEED,
      evolver: fixedEvolver([{ topicKey: '咖啡', delta: 0.05 }]),
      now: () => 't',
    });
    await mgr.advance('手冲', 10);
    const n = mgr.current().find((x) => topicKeyOf(x) === '咖啡')!;
    expect(n.strength).toBeCloseTo(SELF_NOTION_BASE_STRENGTH + 0.05);
    expect(n.affirmCount).toBe(1);
    expect(mgr.state().history).toHaveLength(1);
    expect(mgr.state().history![0]!.topicKey).toBe('咖啡');
    expect(mgr.state().history![0]!.turn).toBe(10);
  });

  it('delta 超单次上限被钳制(不一步突变)', async () => {
    const mgr = new SelfNotionsManager({
      seedNotions: SEED,
      evolver: fixedEvolver([{ topicKey: '咖啡', delta: 0.9 }]),
      maxDeltaPerStep: 0.05,
    });
    await mgr.advance('手冲', 1);
    const n = mgr.current().find((x) => topicKeyOf(x) === '咖啡')!;
    expect(n.strength).toBeCloseTo(SELF_NOTION_BASE_STRENGTH + 0.05); // 被钳到 0.05
  });

  it('evolver 返回 null / 空 / 全零 → 不演化、不写、不抛', async () => {
    for (const deltas of [null, [], [{ topicKey: '咖啡', delta: 0 }], [{ topicKey: '咖啡', delta: -1 }]] as const) {
      const mgr = new SelfNotionsManager({ seedNotions: SEED, evolver: fixedEvolver(deltas) });
      await mgr.advance('手冲', 1);
      expect(mgr.current()[0]?.strength).toBe(SELF_NOTION_BASE_STRENGTH);
      expect(mgr.state().history).toBeUndefined();
    }
  });

  it('evolver 抛错 → 降级、立场不变、不抛', async () => {
    const boom: SelfNotionEvolver = { evolve: () => Promise.reject(new Error('boom')) };
    const mgr = new SelfNotionsManager({ seedNotions: SEED, evolver: boom });
    await expect(mgr.advance('手冲', 1)).resolves.toBeUndefined();
    expect(mgr.current()[0]?.strength).toBe(SELF_NOTION_BASE_STRENGTH);
  });

  it('定位不到的 topicKey → 跳过(不新增条目)', async () => {
    const mgr = new SelfNotionsManager({
      seedNotions: SEED,
      evolver: fixedEvolver([{ topicKey: '不存在的话题', delta: 0.05 }]),
    });
    await mgr.advance('x', 1);
    expect(mgr.current()).toHaveLength(2); // 条数不变
    expect(mgr.state().history).toBeUndefined();
  });

  it('已封顶立场再强化 → 无实际变化、不写快照', async () => {
    const mgr = new SelfNotionsManager({
      seedNotions: [{ topic: ['咖啡'], position: 'p', strength: 1, affirmCount: 5 }],
      evolver: fixedEvolver([{ topicKey: '咖啡', delta: 0.05 }]),
    });
    await mgr.advance('手冲', 1);
    expect(mgr.current()[0]?.strength).toBe(1);
    expect(mgr.state().history).toBeUndefined(); // 无实际变化
  });

  it('XIAOXUE_SEED 经 seedToState 规整后 topic/position 不丢', () => {
    const st = seedToState(XIAOXUE_SEED.selfNotions ?? []);
    expect(st.notions.length).toBe((XIAOXUE_SEED.selfNotions ?? []).length);
    expect(st.notions[0]?.strength).toBe(SELF_NOTION_BASE_STRENGTH);
  });
});
