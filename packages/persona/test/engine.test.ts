import { describe, it, expect } from 'vitest';
import {
  PersonaEngine,
  DefaultAppraiser,
  InMemoryPersonaStore,
  createKvPersonaStore,
  renderToneFragment,
  XIAOXUE_SEED,
  type Appraiser,
  type KvLike,
  type Pad,
} from '../src/index';

describe('persona/tone: 心情影响语气文本', () => {
  it('低 Pleasure 与高 Pleasure 渲染不同 tone', () => {
    const low: Pad = { pleasure: -0.6, arousal: -0.1, dominance: 0 };
    const high: Pad = { pleasure: 0.6, arousal: 0.4, dominance: 0 };
    const loTone = renderToneFragment(low, XIAOXUE_SEED.dials);
    const hiTone = renderToneFragment(high, XIAOXUE_SEED.dials);
    expect(loTone).not.toBe(hiTone);
    expect(loTone).toContain('低落');
  });
});

describe('persona/appraiser: 默认确定性评估', () => {
  it('正向文本上拉愉悦,负向下拉并升唤醒,中性零拉力', () => {
    const a = new DefaultAppraiser();
    expect(a.appraise({ userText: '谢谢你，好喜欢', pad: { pleasure: 0, arousal: 0, dominance: 0 }, turn: 1 }).pleasure).toBeGreaterThan(0);
    const neg = a.appraise({ userText: '你好烦，讨厌', pad: { pleasure: 0, arousal: 0, dominance: 0 }, turn: 1 });
    expect(neg.pleasure).toBeLessThan(0);
    expect(neg.arousal).toBeGreaterThan(0);
    expect(a.appraise({ userText: '今天几号', pad: { pleasure: 0, arousal: 0, dominance: 0 }, turn: 1 })).toEqual({ pleasure: 0, arousal: 0, dominance: 0 });
  });

  it('可注入自定义 Appraiser 替换', () => {
    const fixed: Appraiser = { appraise: () => ({ pleasure: -0.9, arousal: 0, dominance: 0 }) };
    const engine = new PersonaEngine({ seed: XIAOXUE_SEED, appraiser: fixed });
    const t1 = engine.observe('随便说点');
    // 连续负拉力应把心情压低
    engine.observe('再来一句');
    expect(engine.current().pad.pleasure).toBeLessThan(t1.pad.pleasure);
  });
});

describe('persona/engine: 持久化与跨重启', () => {
  it('首启无状态用种子初始化(turn=0、PAD=基线)', () => {
    const engine = new PersonaEngine({ seed: XIAOXUE_SEED, store: new InMemoryPersonaStore() });
    const s = engine.current();
    expect(s.turn).toBe(0);
    expect(s.ocean).toEqual(XIAOXUE_SEED.ocean);
  });

  it('损坏/非法形状的快照回退为种子(不灌 NaN)', () => {
    const kv: KvLike = (() => {
      const m = new Map<string, string>([
        ['persona:snapshot', '{"ocean":{"openness":0.5},"pad":{"pleasure":"oops"},"turn":3}'],
      ]);
      return { getState: (k) => m.get(k), setState: (k, v) => void m.set(k, v) };
    })();
    const engine = new PersonaEngine({ seed: XIAOXUE_SEED, store: createKvPersonaStore(kv) });
    expect(engine.current().turn).toBe(0); // 回退种子,而非带病 turn=3
    expect(Number.isFinite(engine.current().pad.pleasure)).toBe(true);
  });

  it('跨重启续接 PAD(经 KvLike 持久化)', () => {
    const kv: KvLike = (() => {
      const m = new Map<string, string>();
      return { getState: (k) => m.get(k), setState: (k, v) => void m.set(k, v) };
    })();
    const store = createKvPersonaStore(kv);
    const neg: Appraiser = { appraise: () => ({ pleasure: -0.8, arousal: 0.3, dominance: 0 }) };

    const e1 = new PersonaEngine({ seed: XIAOXUE_SEED, store, appraiser: neg });
    e1.observe('烦');
    e1.observe('真烦');
    const saved = e1.current();

    // 重建引擎(模拟重启),应从持久化续接而非回到基线
    const e2 = new PersonaEngine({ seed: XIAOXUE_SEED, store, appraiser: neg });
    expect(e2.current().pad).toEqual(saved.pad);
    expect(e2.current().turn).toBe(saved.turn);
  });
});
