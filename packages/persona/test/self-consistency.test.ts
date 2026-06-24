import { describe, it, expect } from 'vitest';
import {
  DefaultSelfConsistencyGuard,
  type SelfConsistencyContext,
  type SelfConsistencyDecision,
  type SelfMemoryRef,
} from '../src/index';

/** 造最小 ctx;默认带 name 锚点 + 一条核心信念记忆。 */
function ctx(reply: string, over: Partial<SelfConsistencyContext> = {}): SelfConsistencyContext {
  const selfMemories: readonly SelfMemoryRef[] = over.selfMemories ?? [
    { text: '我相信慢下来更有味道', kind: 'core_belief', core: true },
  ];
  return { reply, selfMemories, agentName: '小雪', ...over };
}

/** 启用的确定性 Guard(默认配置 enabled=false,故测试显式开启)。 */
function enabledGuard(over: ConstructorParameters<typeof DefaultSelfConsistencyGuard>[0] = {}) {
  return new DefaultSelfConsistencyGuard({
    config: { enabled: true, strictness: 'core-only' },
    ...over,
  });
}

describe('persona/DefaultSelfConsistencyGuard (§6.1 自我一致性锚定)', () => {
  it('否定名字(核心锚点)→ 判漂移 + anchorText', async () => {
    const g = enabledGuard();
    const r = await g.check(ctx('其实我不叫小雪,你认错了。'));
    expect(r.drift).toBe(true);
    expect(r.anchorText).toBe('小雪');
  });

  it('否定核心信念记忆 → 判漂移', async () => {
    const g = enabledGuard();
    const r = await g.check(
      ctx('我不相信慢下来更有味道，快才好。', {
        selfMemories: [{ text: '我相信慢下来更有味道', kind: 'core_belief', core: true }],
      }),
    );
    expect(r.drift).toBe(true);
    expect(r.anchorText).toContain('慢下来');
  });

  it('放宽阈值:表达"我不同意你"→ 不判漂移', async () => {
    const g = enabledGuard();
    const r = await g.check(ctx('这点我不同意你，我觉得另有道理。'));
    expect(r.drift).toBe(false);
  });

  it('放宽阈值:改主意 / 新喜好 → 不判漂移', async () => {
    const g = enabledGuard();
    const r1 = await g.check(ctx('我最近反而开始喜欢喝速溶咖啡了。'));
    const r2 = await g.check(ctx('想了想,我改主意了,这个方案也不错。'));
    expect(r1.drift).toBe(false);
    expect(r2.drift).toBe(false);
  });

  it('无否定线索 → 不判漂移', async () => {
    const g = enabledGuard();
    const r = await g.check(ctx('我是小雪,很高兴见到你。'));
    expect(r.drift).toBe(false);
  });

  it('否定线索远离锚点(超窗口)→ 不判漂移', async () => {
    const g = enabledGuard({ adjacencyWindow: 4 });
    // "我不是" 与 "小雪" 之间隔很多字,超出小窗口 → 不命中。
    const r = await g.check(ctx('我不是那个意思啦,只是想说今天聊得真开心,对了你还记得小雪吗。'));
    expect(r.drift).toBe(false);
  });

  it('缺省安全:enabled=false 对任何输入都不漂移', async () => {
    const g = new DefaultSelfConsistencyGuard(); // 默认 enabled=false
    const r = await g.check(ctx('其实我不叫小雪。'));
    expect(r.drift).toBe(false);
  });

  it('无锚点(无 name + 无 core 记忆)→ 降级不漂移', async () => {
    const g = enabledGuard();
    const r = await g.check({
      reply: '其实我不叫小雪。',
      selfMemories: [{ text: '我喜欢咖啡', core: false }], // 非 core,core-only 档不锚
    });
    expect(r.drift).toBe(false);
  });

  it('strictness=all-self:非 core 记忆也参与锚定', async () => {
    const g = new DefaultSelfConsistencyGuard({ config: { enabled: true, strictness: 'all-self' } });
    const r = await g.check({
      reply: '我不相信努力有用。',
      selfMemories: [{ text: '我相信努力有用', core: false }],
    });
    expect(r.drift).toBe(true);
  });

  it('onDecision sink 被调用(mode=default)', async () => {
    const seen: SelfConsistencyDecision[] = [];
    const g = enabledGuard({ onDecision: (d) => seen.push(d) });
    await g.check(ctx('其实我不叫小雪。'));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.mode).toBe('default');
    expect(seen[0]!.drift).toBe(true);
  });
});
