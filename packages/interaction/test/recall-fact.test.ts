import { describe, it, expect } from 'vitest';
import { ActionRegistry, createRecallFactAction, type FactLookup } from '../src/index';
import type { ToolCall } from '@chat-a/protocol';

const call = (input: unknown, id = 'f1'): ToolCall => ({ id, name: 'recall_fact', input });

describe('interaction/recall_fact(注入回调,不依赖 memory)', () => {
  it('注入回调命中 → 回结果(非 error)', async () => {
    const lookup: FactLookup = (q) => (q === '用户爱好' ? '用户喜欢爬山' : undefined);
    const r = await createRecallFactAction(lookup).perform({ query: '用户爱好' });
    expect(r.isError).toBeUndefined();
    expect(r.content).toBe('用户喜欢爬山');
  });

  it('注入回调未命中(undefined) → 正常"想不起"(非 error)', async () => {
    const lookup: FactLookup = () => undefined;
    const r = await createRecallFactAction(lookup).perform({ query: '生日' });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('想不起');
    expect(r.content).toContain('生日');
  });

  it('缺省 lookup → 暂不可用语义(非 error)', async () => {
    const r = await createRecallFactAction().perform({ query: '随便什么' });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('想不起');
  });

  it('缺 query(经注册表轻量校验)→ isError', async () => {
    const reg = new ActionRegistry().register(createRecallFactAction());
    const res = await reg.execute(call({}));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('query');
  });

  it('query 空串 → isError', async () => {
    const r = await createRecallFactAction().perform({ query: '   ' });
    expect(r.isError).toBe(true);
  });

  it('不声明 capability(纯本地查询)', () => {
    expect(createRecallFactAction().capability).toBeUndefined();
  });
});
