import { describe, it, expect } from 'vitest';
import { PersonaEngine, InMemoryPersonaStore, XIAOXUE_SEED, type Appraiser, type PadPull } from '../src/index';

/**
 * 受控挂起 appraiser:模拟「慢 LLM 网络调用」(LlmAppraiser.complete ~0.5-0.9s)。
 * `appraise` 在 `release()` 被调用前一直挂起,从而可断言「关键路径有没有被它拖住」。
 */
function gatedAppraiser(pull: PadPull = { pleasure: -0.8, arousal: 0.3, dominance: 0 }) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  const appraiser: Appraiser = {
    appraise: async () => {
      calls++;
      await gate;
      return pull;
    },
  };
  return {
    appraiser,
    release: () => release(),
    get calls() {
      return calls;
    },
  };
}

describe('persona/engine: 背景情绪评估(LLM 评估旁路、非阻塞)', () => {
  it('background 模式:appraise 仍挂起时 advance 已 resolve(关键路径不被 LLM 拖住)', async () => {
    const { appraiser, release } = gatedAppraiser();
    const engine = new PersonaEngine({
      seed: XIAOXUE_SEED,
      appraiser,
      store: new InMemoryPersonaStore(),
      backgroundAppraisal: true,
    });

    // appraise 还挂着;advance 必须在它 resolve 之前就返回,否则 race 取到 'timeout' → 失败。
    const advanceDone = engine.advance('烦死了').then(() => 'done' as const);
    const guard = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 200));
    const winner = await Promise.race([advanceDone, guard]);
    expect(winner).toBe('done');

    // 确定性骨架同步推进:turn 不丢(即便 LLM 评估尚未完成)。
    expect(engine.current().turn).toBe(1);
    release();
    await engine.whenIdle();
  });

  it('background 模式:advance 返回时 PAD 尚未并入 textPull;whenIdle 后最终一致', async () => {
    const { appraiser, release } = gatedAppraiser({ pleasure: -0.8, arousal: 0.3, dominance: 0 });
    const engine = new PersonaEngine({
      seed: XIAOXUE_SEED,
      appraiser,
      store: new InMemoryPersonaStore(),
      backgroundAppraisal: true,
    });
    const before = engine.current().pad.pleasure;

    await engine.advance('烦死了');
    // 背景评估未完成 → PAD 还没被负拉力压低(只影响下一轮、最终一致)。
    expect(engine.current().pad.pleasure).toBe(before);

    release();
    await engine.whenIdle();
    // 背景就绪后并入 PAD:负拉力压低了 pleasure。
    expect(engine.current().pad.pleasure).toBeLessThan(before);
  });

  it('background 模式:appraise 抛错被吞 → advance 不抛、不崩、PAD 不更新(§3.2 降级)', async () => {
    const boom: Appraiser = { appraise: () => Promise.reject(new Error('llm down')) };
    const engine = new PersonaEngine({
      seed: XIAOXUE_SEED,
      appraiser: boom,
      store: new InMemoryPersonaStore(),
      backgroundAppraisal: true,
    });
    const before = engine.current().pad;

    await expect(engine.advance('烦')).resolves.toBeUndefined();
    await engine.whenIdle();
    expect(engine.current().pad).toEqual(before); // 降级:不并入,回合继续
    expect(engine.current().turn).toBe(1); // 但骨架推进未丢
  });

  it('background 模式:appraise 超出预算被丢弃(有界超时降级),whenIdle 不被挂死', async () => {
    const { appraiser } = gatedAppraiser(); // 永不 release → 永远挂起
    const engine = new PersonaEngine({
      seed: XIAOXUE_SEED,
      appraiser,
      store: new InMemoryPersonaStore(),
      backgroundAppraisal: true,
      appraisalBudgetMs: 30,
    });
    const before = engine.current().pad;

    await engine.advance('烦');
    await engine.whenIdle(); // 30ms 超时后链结算,不无限等
    expect(engine.current().pad).toEqual(before); // 超时 → 不并入
  });

  it('background 模式:多轮快速连续 → 串行并入、turn 不丢、不崩', async () => {
    const neg: Appraiser = { appraise: () => Promise.resolve({ pleasure: -0.6, arousal: 0.2, dominance: 0 }) };
    const engine = new PersonaEngine({
      seed: XIAOXUE_SEED,
      appraiser: neg,
      store: new InMemoryPersonaStore(),
      backgroundAppraisal: true,
    });
    const before = engine.current().pad.pleasure;
    await engine.advance('a');
    await engine.advance('b');
    await engine.advance('c');
    expect(engine.current().turn).toBe(3); // 同步骨架:三轮 turn 全部落定
    await engine.whenIdle();
    // 三次负拉力串行并入 → 最终 pleasure 明显低于起点。
    expect(engine.current().pad.pleasure).toBeLessThan(before);
  });
});

describe('persona/engine: 默认(blocking)模式逐字不变', () => {
  it('未开 background → advance 同步并入 textPull(现状语义)', async () => {
    const neg: Appraiser = { appraise: () => Promise.resolve({ pleasure: -0.8, arousal: 0.3, dominance: 0 }) };
    const engine = new PersonaEngine({ seed: XIAOXUE_SEED, appraiser: neg, store: new InMemoryPersonaStore() });
    const before = engine.current().pad.pleasure;
    await engine.advance('烦');
    expect(engine.current().pad.pleasure).toBeLessThan(before); // 同步即并入
  });
});
