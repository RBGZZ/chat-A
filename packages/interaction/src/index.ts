import { ActionRegistry } from './registry';
import { createCurrentTimeAction } from './actions/current-time';
import { createCalculateAction } from './actions/calculate';
import { createSetReminderAction, InMemoryReminderStore, type ReminderStore } from './actions/set-reminder';
import { createUnitConvertAction } from './actions/unit-convert';

export * from './types';
export * from './registry';
export * from './actions/current-time';
export * from './actions/calculate';
export * from './actions/set-reminder';
export * from './actions/unit-convert';

/**
 * 装配内置本地动作的默认注册表(§12.2)。均纯本地、无外部进程。
 * - now:时钟可注入(确定性测试,current_time)。
 * - reminderStore:提醒存储可注入(确定性测试 + 跨调用读取,set_reminder);缺省新建内存版。
 */
export function buildDefaultRegistry(
  opts: { readonly now?: () => Date; readonly reminderStore?: ReminderStore } = {},
): ActionRegistry {
  const reminderStore = opts.reminderStore ?? new InMemoryReminderStore();
  const registry = new ActionRegistry();
  registry.register(createCurrentTimeAction(opts.now));
  registry.register(createCalculateAction());
  registry.register(createSetReminderAction(reminderStore));
  registry.register(createUnitConvertAction());
  return registry;
}
