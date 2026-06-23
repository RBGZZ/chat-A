import { describe, it, expect } from 'vitest';
import {
  ActionRegistry,
  createListRemindersAction,
  createSetReminderAction,
  InMemoryReminderStore,
} from '../src/index';
import type { ToolCall } from '@chat-a/protocol';

const call = (input: unknown = {}, id = 'l1'): ToolCall => ({ id, name: 'list_reminders', input });

describe('interaction/list_reminders(读提醒)', () => {
  it('与 set_reminder 共享 store:写入后能读到', async () => {
    const store = new InMemoryReminderStore();
    await createSetReminderAction(store).perform({ text: '喝水' });
    const r = await createListRemindersAction(store).perform({});
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('喝水');
  });

  it('带 atIso 的提醒在列表中含时间', async () => {
    const store = new InMemoryReminderStore();
    await createSetReminderAction(store).perform({ text: '开会', atIso: '2026-06-23T20:00:00Z' });
    const r = await createListRemindersAction(store).perform({});
    expect(r.content).toContain('开会');
    expect(r.content).toContain('2026-06-23T20:00:00Z');
  });

  it('空 store → 可读"没有提醒"(非 error)', async () => {
    const r = await createListRemindersAction(new InMemoryReminderStore()).perform({});
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('没有提醒');
  });

  it('经注册表执行 → toolCallId 对齐、非 error', async () => {
    const reg = new ActionRegistry().register(createListRemindersAction(new InMemoryReminderStore()));
    const res = await reg.execute(call({}, 'x1'));
    expect(res.toolCallId).toBe('x1');
    expect(res.isError).toBeUndefined();
  });

  it('声明 capability=time', () => {
    expect(createListRemindersAction(new InMemoryReminderStore()).capability).toBe('time');
  });
});
