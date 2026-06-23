import { describe, it, expect } from 'vitest';
import {
  ActionRegistry,
  createSetReminderAction,
  InMemoryReminderStore,
  listReminders,
} from '../src/index';
import type { ToolCall } from '@chat-a/protocol';

const call = (input: unknown, id = 'r1'): ToolCall => ({ id, name: 'set_reminder', input });

describe('interaction/set_reminder', () => {
  it('注入 store → add 后 list 可读', async () => {
    const store = new InMemoryReminderStore();
    const action = createSetReminderAction(store);
    const r = await action.perform({ text: '喝水' });
    expect(r.isError).toBeUndefined();
    const items = listReminders(store);
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe('喝水');
    expect(items[0]?.atIso).toBeUndefined();
  });

  it('带 atIso → 存入并保留时间', async () => {
    const store = new InMemoryReminderStore();
    await createSetReminderAction(store).perform({ text: '开会', atIso: '2026-06-23T20:00:00Z' });
    expect(store.list()[0]?.atIso).toBe('2026-06-23T20:00:00Z');
  });

  it('缺 text(经注册表轻量校验)→ isError 不入列', async () => {
    const store = new InMemoryReminderStore();
    const reg = new ActionRegistry().register(createSetReminderAction(store));
    const res = await reg.execute(call({}));
    expect(res.isError).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it('text 为空串 → isError', async () => {
    const store = new InMemoryReminderStore();
    const r = await createSetReminderAction(store).perform({ text: '   ' });
    expect(r.isError).toBe(true);
  });

  it('atIso 不可解析 → isError 不入列', async () => {
    const store = new InMemoryReminderStore();
    const r = await createSetReminderAction(store).perform({ text: 'x', atIso: 'not-a-date' });
    expect(r.isError).toBe(true);
    expect(store.list()).toHaveLength(0);
  });
});
