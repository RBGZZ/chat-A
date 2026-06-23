import { describe, it, expect } from 'vitest';
import {
  PersonaEngine,
  createKvPersonaStore,
  XIAOXUE_SEED,
  type KvLike,
  type OceanDelta,
  type OceanEvolver,
  type Appraiser,
} from '../src/index';

/** 零拉力 appraiser:隔离 OCEAN 演化效应,PAD 不被对话内容干扰。 */
const ZERO_APPRAISER: Appraiser = {
  appraise: () => Promise.resolve({ pleasure: 0, arousal: 0, dominance: 0 }),
};

/** 固定 delta 的演化器(record-replay 风:确定性返回)。 */
function fixedEvolver(delta: OceanDelta | null): OceanEvolver {
  return { evolve: () => Promise.resolve(delta) };
}

const NUDGE: OceanDelta = {
  openness: 0.01,
  conscientiousness: 0,
  extraversion: 0,
  agreeableness: 0,
  neuroticism: 0,
};

async function advanceN(engine: PersonaEngine, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await engine.advance(`第${i}句`);
}

describe('persona/engine: 二级 OCEAN 演化集成', () => {
  it('注入 evolver,满 20 轮触发一次:OCEAN 微调 + history 追加一条', async () => {
    const engine = new PersonaEngine({
      seed: XIAOXUE_SEED,
      appraiser: ZERO_APPRAISER,
      oceanEvolver: fixedEvolver(NUDGE),
      now: () => '2026-06-23T00:00:00.000Z',
    });
    await advanceN(engine, 19);
    expect(engine.current().ocean.openness).toBe(XIAOXUE_SEED.ocean.openness); // 未到节拍
    expect(engine.current().history ?? []).toHaveLength(0);

    await engine.advance('第20句');
    const s = engine.current();
    expect(s.turn).toBe(20);
    expect(s.ocean.openness).toBeCloseTo(XIAOXUE_SEED.ocean.openness + 0.01); // 演化生效
    expect(s.history).toHaveLength(1);
    expect(s.history![0]!.turn).toBe(20);
    expect(s.history![0]!.before.openness).toBe(XIAOXUE_SEED.ocean.openness);
    expect(s.history![0]!.after.openness).toBeCloseTo(XIAOXUE_SEED.ocean.openness + 0.01);
  });

  it('两个周期累计两条快照', async () => {
    const engine = new PersonaEngine({
      seed: XIAOXUE_SEED,
      appraiser: ZERO_APPRAISER,
      oceanEvolver: fixedEvolver(NUDGE),
      now: () => '2026-06-23T00:00:00.000Z',
    });
    await advanceN(engine, 40);
    expect(engine.current().history).toHaveLength(2);
    expect(engine.current().ocean.openness).toBeCloseTo(XIAOXUE_SEED.ocean.openness + 0.02);
  });

  it('未注入 evolver:跑满 40 轮 OCEAN 恒定、无 history', async () => {
    const engine = new PersonaEngine({ seed: XIAOXUE_SEED, appraiser: ZERO_APPRAISER });
    await advanceN(engine, 40);
    expect(engine.current().ocean).toEqual(XIAOXUE_SEED.ocean);
    expect(engine.current().history).toBeUndefined();
  });

  it('evolver 返回 null(降级):到节拍也不演化、不写快照、回合不受影响', async () => {
    const engine = new PersonaEngine({
      seed: XIAOXUE_SEED,
      appraiser: ZERO_APPRAISER,
      oceanEvolver: fixedEvolver(null),
    });
    await advanceN(engine, 20);
    expect(engine.current().turn).toBe(20); // 回合正常推进
    expect(engine.current().ocean).toEqual(XIAOXUE_SEED.ocean);
    expect(engine.current().history).toBeUndefined();
  });

  it('演化后的 OCEAN + history 经 KvLike 持久化、跨重启续接', async () => {
    const kv: KvLike = (() => {
      const m = new Map<string, string>();
      return { getState: (k) => m.get(k), setState: (k, v) => void m.set(k, v) };
    })();
    const store = createKvPersonaStore(kv);
    const e1 = new PersonaEngine({
      seed: XIAOXUE_SEED,
      store,
      appraiser: ZERO_APPRAISER,
      oceanEvolver: fixedEvolver(NUDGE),
      now: () => '2026-06-23T00:00:00.000Z',
    });
    await advanceN(e1, 20);
    const saved = e1.current();

    const e2 = new PersonaEngine({ seed: XIAOXUE_SEED, store });
    expect(e2.current().ocean).toEqual(saved.ocean);
    expect(e2.current().history).toEqual(saved.history);
    expect(e2.current().turn).toBe(20);
  });
});

describe('persona/store: history 向后兼容', () => {
  function kvWith(raw: string): KvLike {
    const m = new Map<string, string>([['persona:snapshot', raw]]);
    return { getState: (k) => m.get(k), setState: (k, v) => void m.set(k, v) };
  }

  const VALID_CORE =
    '"ocean":{"openness":0.6,"conscientiousness":0.5,"extraversion":0.7,"agreeableness":0.7,"neuroticism":0.45},' +
    '"pad":{"pleasure":0.1,"arousal":0,"dominance":0},"turn":25';

  it('旧快照无 history 字段:正常读回,history 视作空', () => {
    const engine = new PersonaEngine({ seed: XIAOXUE_SEED, store: createKvPersonaStore(kvWith(`{${VALID_CORE}}`)) });
    expect(engine.current().turn).toBe(25); // 续接而非回退种子
    expect(engine.current().ocean.openness).toBe(0.6);
    expect(engine.current().history).toBeUndefined();
  });

  it('history 形状非法(非数组):丢弃 history,但 OCEAN/PAD/turn 不丢', () => {
    const engine = new PersonaEngine({
      seed: XIAOXUE_SEED,
      store: createKvPersonaStore(kvWith(`{${VALID_CORE},"history":"oops"}`)),
    });
    expect(engine.current().turn).toBe(25); // 人格状态保住
    expect(engine.current().ocean.openness).toBe(0.6);
    expect(engine.current().history).toBeUndefined(); // 损坏的 history 被丢弃
  });

  it('合法 history 数组保留', () => {
    const hist =
      '"history":[{"turn":20,"at":"t","before":{"openness":0.59,"conscientiousness":0.5,"extraversion":0.7,"agreeableness":0.7,"neuroticism":0.45},"after":{"openness":0.6,"conscientiousness":0.5,"extraversion":0.7,"agreeableness":0.7,"neuroticism":0.45},"delta":{"openness":0.01,"conscientiousness":0,"extraversion":0,"agreeableness":0,"neuroticism":0}}]';
    const engine = new PersonaEngine({
      seed: XIAOXUE_SEED,
      store: createKvPersonaStore(kvWith(`{${VALID_CORE},${hist}}`)),
    });
    expect(engine.current().history).toHaveLength(1);
    expect(engine.current().history![0]!.turn).toBe(20);
  });
});
