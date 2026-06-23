import { describe, it, expect } from 'vitest';
import type { ToolCall } from '@chat-a/protocol';
import { ActionRegistry, buildDefaultRegistry, createCurrentTimeAction, type Action } from '../src/index';

const call = (name: string, input: unknown = {}, id = 'c1'): ToolCall => ({ id, name, input });

describe('interaction/current_time', () => {
  it('注入时钟 → 确定性 ISO', async () => {
    const fixed = new Date('2026-06-23T08:00:00.000Z');
    const r = await createCurrentTimeAction(() => fixed).perform({});
    expect(r.content).toBe('2026-06-23T08:00:00.000Z');
    expect(r.isError).toBeUndefined();
  });
});

describe('interaction/ActionRegistry 容错执行', () => {
  it('已知工具成功 → toolCallId 对齐、非 error', async () => {
    const reg = new ActionRegistry().register({
      name: 'ping',
      description: 'p',
      inputSchema: { type: 'object', properties: {}, required: [] },
      perform: () => Promise.resolve({ content: 'pong' }),
    });
    const res = await reg.execute(call('ping', {}, 'x1'));
    expect(res).toEqual({ toolCallId: 'x1', content: 'pong' });
  });

  it('未知工具 → isError 不抛', async () => {
    const res = await new ActionRegistry().execute(call('nope'));
    expect(res.isError).toBe(true);
    expect(res.toolCallId).toBe('c1');
  });

  it('perform 抛错 → 收敛为 isError 不抛', async () => {
    const boom: Action = {
      name: 'boom',
      description: 'b',
      inputSchema: { type: 'object', properties: {}, required: [] },
      perform: () => Promise.reject(new Error('炸了')),
    };
    const res = await new ActionRegistry().register(boom).execute(call('boom'));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('炸了');
  });

  it('缺必填字段 → isError(轻量校验)', async () => {
    const reg = new ActionRegistry().register({
      name: 'greet',
      description: 'g',
      inputSchema: { type: 'object', properties: { who: { type: 'string' } }, required: ['who'] },
      perform: (i) => Promise.resolve({ content: `hi ${(i as { who: string }).who}` }),
    });
    const res = await reg.execute(call('greet', {}));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('who');
  });

  it('字段类型不符 → isError', async () => {
    const reg = new ActionRegistry().register({
      name: 'n',
      description: 'n',
      inputSchema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
      perform: () => Promise.resolve({ content: 'ok' }),
    });
    const res = await reg.execute(call('n', { x: 'not-a-number' }));
    expect(res.isError).toBe(true);
  });

  it('toolDefs 形态 + size(含全部内置动作)', () => {
    const reg = buildDefaultRegistry();
    expect(reg.size).toBe(4);
    const names = reg.toolDefs().map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining(['current_time', 'calculate', 'set_reminder', 'unit_convert']),
    );
    expect(reg.toolDefs()[0]?.inputSchema).toBeDefined();
  });
});
