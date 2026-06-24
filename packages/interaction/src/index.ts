import { ActionRegistry } from './registry';
import { createCurrentTimeAction } from './actions/current-time';
import { createCalculateAction } from './actions/calculate';
import { createSetReminderAction, InMemoryReminderStore, type ReminderStore } from './actions/set-reminder';
import { createUnitConvertAction } from './actions/unit-convert';
import { createDateDiffAction } from './actions/date-diff';
import { createListRemindersAction } from './actions/list-reminders';
import { createRecallFactAction, type FactLookup } from './actions/recall-fact';
import { createCountdownAction } from './actions/countdown';

export * from './types';
export * from './registry';
// —— 外界交互 MVP(§12)新增 ——
export * from './bus';
export * from './task-executor';
export * from './perception';
export * from './mcp';
export * from './actions/current-time';
export * from './actions/calculate';
export * from './actions/set-reminder';
export * from './actions/unit-convert';
export * from './actions/date-diff';
export * from './actions/list-reminders';
export * from './actions/recall-fact';
export * from './actions/countdown';

/**
 * 装配内置本地动作的默认注册表(§12.2)。均纯本地、无外部进程。
 * - now:时钟可注入(确定性测试,current_time / countdown 共用)。
 * - reminderStore:提醒存储可注入(确定性测试 + 跨调用读取);**set_reminder 与 list_reminders
 *   共享同一实例**,故 list_reminders 能读到 set_reminder 写入的提醒;缺省新建内存版。
 * - factLookup:recall_fact 的事实查询回调可注入;**缺省"暂不可用"**(interaction 不依赖 memory,
 *   真正接 memory 留后续接线)。
 *
 * 能力标注随动作走(§12.2):current_time/set_reminder/list_reminders/countdown 声明 'time';
 * calculate/unit_convert/date_diff/recall_fact 不声明(纯计算,始终可用)。
 * 默认不配能力集 → toolDefs()/execute() 对全部动作行为与未引入能力门时一致(向后兼容)。
 */
export function buildDefaultRegistry(
  opts: {
    readonly now?: () => Date;
    readonly reminderStore?: ReminderStore;
    readonly factLookup?: FactLookup;
  } = {},
): ActionRegistry {
  const reminderStore = opts.reminderStore ?? new InMemoryReminderStore();
  const registry = new ActionRegistry();
  registry.register(createCurrentTimeAction(opts.now));
  registry.register(createCalculateAction());
  registry.register(createSetReminderAction(reminderStore));
  registry.register(createUnitConvertAction());
  registry.register(createDateDiffAction());
  registry.register(createListRemindersAction(reminderStore));
  registry.register(createRecallFactAction(opts.factLookup));
  registry.register(createCountdownAction(opts.now));
  return registry;
}
