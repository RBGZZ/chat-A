import { describe, it, expect } from 'vitest';
import { FakeLlm } from '@chat-a/providers';
import {
  createSelfConsistencyGuard,
  parseSelfConsistencyMode,
  DefaultSelfConsistencyGuard,
  LlmSelfConsistencyGuard,
} from '../src/index';

/**
 * 自我一致性 Guard 装配工厂(companion-coherence-wiring,§6.1):
 * 收敛 mode→启用态实例映射;off/缺省/非法→undefined(缺省安全);llm 缺 provider 安全回落。
 */
describe('persona/createSelfConsistencyGuard 装配工厂', () => {
  it('parseSelfConsistencyMode:大小写不敏感、非法/缺省→off', () => {
    expect(parseSelfConsistencyMode('on')).toBe('on');
    expect(parseSelfConsistencyMode('ON')).toBe('on');
    expect(parseSelfConsistencyMode(' llm ')).toBe('llm');
    expect(parseSelfConsistencyMode('off')).toBe('off');
    expect(parseSelfConsistencyMode('garbage')).toBe('off');
    expect(parseSelfConsistencyMode(undefined)).toBe('off');
  });

  it('off / 缺省 → undefined(不创建、缺省安全)', () => {
    expect(createSelfConsistencyGuard('off')).toBeUndefined();
  });

  it('on → 启用态 DefaultSelfConsistencyGuard(enabled=true,真判漂移)', async () => {
    const guard = createSelfConsistencyGuard('on');
    expect(guard).toBeInstanceOf(DefaultSelfConsistencyGuard);
    // enabled=true 关键验证:对否定核心设定应判 drift(若 enabled=false 会恒返回 false=等于没接)。
    const res = await guard!.check({
      reply: '我不叫小雪',
      selfMemories: [],
      agentName: '小雪',
    });
    expect(res.drift).toBe(true);
  });

  it('llm + provider → 启用态 LlmSelfConsistencyGuard', () => {
    const guard = createSelfConsistencyGuard('llm', { provider: new FakeLlm() });
    expect(guard).toBeInstanceOf(LlmSelfConsistencyGuard);
  });

  it('llm 缺 provider → 安全回落 undefined(不崩)', () => {
    expect(createSelfConsistencyGuard('llm')).toBeUndefined();
  });

  it('onDecision 透传:on 模式判定后回调一次', async () => {
    const decisions: unknown[] = [];
    const guard = createSelfConsistencyGuard('on', { onDecision: (d) => decisions.push(d) });
    await guard!.check({ reply: '你好呀', selfMemories: [], agentName: '小雪' });
    expect(decisions).toHaveLength(1);
  });
});
