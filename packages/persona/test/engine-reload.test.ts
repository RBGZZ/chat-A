import { describe, it, expect } from 'vitest';
import {
  PersonaEngine,
  InMemoryPersonaStore,
  XIAOXUE_SEED,
  type Appraiser,
  type PersonaSnapshot,
  type PersonaStore,
} from '../src/index';

/** 强负向固定评估器:让 advance 明显推动 PAD(便于断言变化)。 */
const PUSH_DOWN: Appraiser = {
  appraise: () => Promise.resolve({ pleasure: -0.9, arousal: 0.4, dominance: 0 }),
};

describe('PersonaEngine.reload: 只读引擎从共享 store 重载活 PAD', () => {
  it('A 引擎 advance+save 后,B 引擎 reload 反映新 PAD(reload 前仍旧值)', async () => {
    const store = new InMemoryPersonaStore();
    const a = new PersonaEngine({ seed: XIAOXUE_SEED, store, appraiser: PUSH_DOWN });
    const b = new PersonaEngine({ seed: XIAOXUE_SEED, store }); // 只读(从不 advance)
    const before = b.current().pad.pleasure;

    await a.advance('让她不开心'); // A 推进 + 保存到共享 store
    expect(b.current().pad.pleasure).toBe(before); // B 未 reload → 仍旧值(stale)

    b.reload();
    expect(b.current().pad.pleasure).toBe(a.current().pad.pleasure); // 同步到 A 的活 PAD
    expect(a.current().pad.pleasure).toBeLessThan(before); // 确实变了(advance 生效)
  });

  it('store 空时 reload 保持现状、不抛', () => {
    const store = new InMemoryPersonaStore(); // 空
    const e = new PersonaEngine({ seed: XIAOXUE_SEED, store });
    const before = e.current();
    expect(() => e.reload()).not.toThrow();
    expect(e.current()).toEqual(before);
  });

  it('reload 只读不写回(不调用 store.save)', async () => {
    const base = new InMemoryPersonaStore();
    let saves = 0;
    const spy: PersonaStore = {
      load: () => base.load(),
      save: (s: PersonaSnapshot) => {
        saves++;
        base.save(s);
      },
    };
    const a = new PersonaEngine({ seed: XIAOXUE_SEED, store: spy, appraiser: PUSH_DOWN });
    const b = new PersonaEngine({ seed: XIAOXUE_SEED, store: spy });
    await a.advance('x'); // 唯一一次写
    expect(saves).toBe(1);
    b.reload();
    b.reload();
    expect(saves).toBe(1); // reload 多次也不写回
  });
});
