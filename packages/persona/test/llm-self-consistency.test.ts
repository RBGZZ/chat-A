import { describe, it, expect } from 'vitest';
import { FakeLlm } from '@chat-a/providers';
import {
  LlmSelfConsistencyGuard,
  type SelfConsistencyContext,
  type SelfConsistencyDecision,
} from '../src/index';

const enabled = { enabled: true as const, strictness: 'core-only' as const };

function ctx(reply: string): SelfConsistencyContext {
  return { reply, selfMemories: [{ text: '我相信慢下来更有味道', core: true }], agentName: '小雪' };
}

describe('persona/LlmSelfConsistencyGuard (§6.1, opt-in, schema 约束 + 降级)', () => {
  it('返回 {"drift":true} → 判漂移', async () => {
    const g = new LlmSelfConsistencyGuard({
      provider: new FakeLlm('fake', { complete: '{"drift": true, "reason": "否定了名字"}' }),
      config: enabled,
    });
    const r = await g.check(ctx('其实我不叫小雪。'));
    expect(r.drift).toBe(true);
    expect(r.reason).toContain('名字');
  });

  it('返回 {"drift":false} → 不漂移(放宽阈值由 prompt 约束,模型判不漂移)', async () => {
    const g = new LlmSelfConsistencyGuard({
      provider: new FakeLlm('fake', { complete: '{"drift": false, "reason": "只是表达不同意"}' }),
      config: enabled,
    });
    const r = await g.check(ctx('这点我不同意你。'));
    expect(r.drift).toBe(false);
  });

  it('乱码 JSON → 降级不锚定 + onError', async () => {
    let errSeen = false;
    const g = new LlmSelfConsistencyGuard({
      provider: new FakeLlm('fake', { complete: '不是 JSON 的乱码~~~' }),
      config: enabled,
      onError: () => {
        errSeen = true;
      },
    });
    const r = await g.check(ctx('其实我不叫小雪。'));
    expect(r.drift).toBe(false);
    expect(errSeen).toBe(true);
  });

  it('provider 抛错 → 降级不锚定,不抛', async () => {
    const throwing = {
      id: 'x',
      model: 'x',
      async *stream() {},
      async complete(): Promise<string> {
        throw new Error('boom');
      },
    };
    const g = new LlmSelfConsistencyGuard({ provider: throwing as never, config: enabled });
    const r = await g.check(ctx('其实我不叫小雪。'));
    expect(r.drift).toBe(false);
  });

  it('缺省安全:enabled=false 不调 LLM,直接不漂移', async () => {
    let called = false;
    const g = new LlmSelfConsistencyGuard({
      provider: new FakeLlm('fake', {
        complete: () => {
          called = true;
          return '{"drift": true}';
        },
      }),
      // 默认 config enabled=false
    });
    const r = await g.check(ctx('其实我不叫小雪。'));
    expect(r.drift).toBe(false);
    expect(called).toBe(false);
  });

  it('onDecision sink 被调用(mode=llm)', async () => {
    const seen: SelfConsistencyDecision[] = [];
    const g = new LlmSelfConsistencyGuard({
      provider: new FakeLlm('fake', { complete: '{"drift": true}' }),
      config: enabled,
      onDecision: (d) => seen.push(d),
    });
    await g.check(ctx('其实我不叫小雪。'));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.mode).toBe('llm');
  });
});
