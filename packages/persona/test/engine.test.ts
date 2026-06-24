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
  it('正向文本上拉愉悦,负向下拉并升唤醒,中性零拉力', async () => {
    const a = new DefaultAppraiser();
    const ctx = { pad: { pleasure: 0, arousal: 0, dominance: 0 }, turn: 1 };
    expect((await a.appraise({ userText: '谢谢你，好喜欢', ...ctx })).pleasure).toBeGreaterThan(0);
    const neg = await a.appraise({ userText: '你好烦，讨厌', ...ctx });
    expect(neg.pleasure).toBeLessThan(0);
    expect(neg.arousal).toBeGreaterThan(0);
    expect(await a.appraise({ userText: '今天几号', ...ctx })).toEqual({ pleasure: 0, arousal: 0, dominance: 0 });
  });

  it('可注入自定义 Appraiser 替换', async () => {
    const fixed: Appraiser = { appraise: () => Promise.resolve({ pleasure: -0.9, arousal: 0, dominance: 0 }) };
    const engine = new PersonaEngine({ seed: XIAOXUE_SEED, appraiser: fixed });
    await engine.advance('随便说点');
    const p1 = engine.current().pad.pleasure;
    await engine.advance('再来一句');
    expect(engine.current().pad.pleasure).toBeLessThan(p1); // 连续负拉力压低心情
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

  it('跨重启续接 PAD(经 KvLike 持久化)', async () => {
    const kv: KvLike = (() => {
      const m = new Map<string, string>();
      return { getState: (k) => m.get(k), setState: (k, v) => void m.set(k, v) };
    })();
    const store = createKvPersonaStore(kv);
    const neg: Appraiser = { appraise: () => Promise.resolve({ pleasure: -0.8, arousal: 0.3, dominance: 0 }) };

    const e1 = new PersonaEngine({ seed: XIAOXUE_SEED, store, appraiser: neg });
    await e1.advance('烦');
    await e1.advance('真烦');
    const saved = e1.current();

    // 重建引擎(模拟重启),应从持久化续接而非回到基线
    const e2 = new PersonaEngine({ seed: XIAOXUE_SEED, store, appraiser: neg });
    expect(e2.current().pad).toEqual(saved.pad);
    expect(e2.current().turn).toBe(saved.turn);
  });
});

describe('persona/engine: advance 并入语音 prosody 情绪(§7#5)', () => {
  /** 零文本拉力 appraiser:隔离出语音侧贡献,便于断言「是语音改变了心情」。 */
  const zeroPull: Appraiser = { appraise: () => Promise.resolve({ pleasure: 0, arousal: 0, dominance: 0 }) };

  it('提供 sad prosody → PAD pleasure 低于不提供(语音真实影响心情)', async () => {
    const withProsody = new PersonaEngine({ seed: XIAOXUE_SEED, appraiser: zeroPull, store: new InMemoryPersonaStore() });
    const without = new PersonaEngine({ seed: XIAOXUE_SEED, appraiser: zeroPull, store: new InMemoryPersonaStore() });
    await withProsody.advance('随便说点', { prosodyEmotion: { label: 'sad' } });
    await without.advance('随便说点');
    expect(withProsody.current().pad.pleasure).toBeLessThan(without.current().pad.pleasure);
    expect(withProsody.current().pad.arousal).toBeLessThan(without.current().pad.arousal);
  });

  it('提供 happy prosody → PAD pleasure 高于不提供', async () => {
    const withProsody = new PersonaEngine({ seed: XIAOXUE_SEED, appraiser: zeroPull, store: new InMemoryPersonaStore() });
    const without = new PersonaEngine({ seed: XIAOXUE_SEED, appraiser: zeroPull, store: new InMemoryPersonaStore() });
    await withProsody.advance('随便说点', { prosodyEmotion: { label: 'happy' } });
    await without.advance('随便说点');
    expect(withProsody.current().pad.pleasure).toBeGreaterThan(without.current().pad.pleasure);
  });

  it('neutral / 未知 prosody 标签 → 与不提供逐字等价(降级零拉力)', async () => {
    const neutral = new PersonaEngine({ seed: XIAOXUE_SEED, appraiser: zeroPull, store: new InMemoryPersonaStore() });
    const unknown = new PersonaEngine({ seed: XIAOXUE_SEED, appraiser: zeroPull, store: new InMemoryPersonaStore() });
    const without = new PersonaEngine({ seed: XIAOXUE_SEED, appraiser: zeroPull, store: new InMemoryPersonaStore() });
    await neutral.advance('随便说点', { prosodyEmotion: { label: 'neutral' } });
    await unknown.advance('随便说点', { prosodyEmotion: { label: '__nope__' } });
    await without.advance('随便说点');
    expect(neutral.current().pad).toEqual(without.current().pad);
    expect(unknown.current().pad).toEqual(without.current().pad);
  });

  it('golden:无 opts 的 advance 与传 undefined opts 逐字一致(纯加法不改默认路径)', async () => {
    const a = new PersonaEngine({ seed: XIAOXUE_SEED, appraiser: zeroPull, store: new InMemoryPersonaStore() });
    const b = new PersonaEngine({ seed: XIAOXUE_SEED, appraiser: zeroPull, store: new InMemoryPersonaStore() });
    await a.advance('随便说点');
    await b.advance('随便说点', {});
    expect(a.current().pad).toEqual(b.current().pad);
    expect(a.current().turn).toBe(b.current().turn);
  });

  it('confidence 缩放:低置信 sad 对心情的压低弱于满置信 sad(语音强度可调)', async () => {
    const full = new PersonaEngine({ seed: XIAOXUE_SEED, appraiser: zeroPull, store: new InMemoryPersonaStore() });
    const low = new PersonaEngine({ seed: XIAOXUE_SEED, appraiser: zeroPull, store: new InMemoryPersonaStore() });
    await full.advance('随便说点', { prosodyEmotion: { label: 'sad' } });
    await low.advance('随便说点', { prosodyEmotion: { label: 'sad', confidence: 0.3 } });
    // 满置信压得更低(pleasure 更小)
    expect(full.current().pad.pleasure).toBeLessThan(low.current().pad.pleasure);
  });
});
