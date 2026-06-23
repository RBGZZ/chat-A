import { describe, it, expect } from 'vitest';
import { ActionRegistry, createCountdownAction } from '../src/index';
import type { ToolCall } from '@chat-a/protocol';

const call = (input: unknown, id = 'd1'): ToolCall => ({ id, name: 'countdown', input });
const clock = (iso: string) => () => new Date(iso);

describe('interaction/countdown(到某时刻还有多久)', () => {
  it('未来时刻 → 正向剩余时长(非 error)', async () => {
    // now = 2026-06-23T08:00:00Z;target 晚 2 天 3 小时 30 分。
    const r = await createCountdownAction(clock('2026-06-23T08:00:00.000Z')).perform({
      atIso: '2026-06-25T11:30:00.000Z',
    });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('还有');
    expect(r.content).toContain('2 天');
    expect(r.content).toContain('3 小时');
    expect(r.content).toContain('30 分');
  });

  it('过去时刻 → 已过去说明(非 error)', async () => {
    const r = await createCountdownAction(clock('2026-06-23T08:00:00.000Z')).perform({
      atIso: '2026-06-22T08:00:00.000Z',
    });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('已过去');
    expect(r.content).toContain('1 天');
  });

  it('不足一分钟也给 0 分(非空)', async () => {
    const r = await createCountdownAction(clock('2026-06-23T08:00:00.000Z')).perform({
      atIso: '2026-06-23T08:00:30.000Z',
    });
    expect(r.content).toContain('0 分');
  });

  it('不可解析 atIso → isError 不抛', async () => {
    const r = await createCountdownAction(clock('2026-06-23T08:00:00.000Z')).perform({ atIso: 'not-a-date' });
    expect(r.isError).toBe(true);
  });

  it('atIso 非字符串(经注册表校验)→ isError', async () => {
    const reg = new ActionRegistry().register(createCountdownAction(clock('2026-06-23T08:00:00.000Z')));
    const res = await reg.execute(call({ atIso: 123 }));
    expect(res.isError).toBe(true);
  });

  it('同注入时钟 → 结果确定', async () => {
    const make = () => createCountdownAction(clock('2026-06-23T08:00:00.000Z'));
    const a = await make().perform({ atIso: '2026-07-01T08:00:00.000Z' });
    const b = await make().perform({ atIso: '2026-07-01T08:00:00.000Z' });
    expect(a.content).toBe(b.content);
  });

  it('声明 capability=time', () => {
    expect(createCountdownAction().capability).toBe('time');
  });
});
