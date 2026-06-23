import type { Action, ActionResult } from '../types';
import type { ReminderStore } from './set-reminder';

/**
 * 内置本地动作:读出已存提醒(§12.2)。无入参,纯读——读取注入的 `ReminderStore`。
 * **与 `set_reminder` 共享同一 store 实例**(由 buildDefaultRegistry 注入同一个),
 * 故能读到 set_reminder 写入的提醒。声明 `capability:'time'`(提醒属时间域)。
 * store 可注入以支持确定性测试(§3.2)。
 */
export function createListRemindersAction(store: ReminderStore): Action {
  return {
    name: 'list_reminders',
    description:
      '读出当前已记下的所有提醒(内存版)。无入参。当用户问"我有哪些提醒 / 我要提醒什么"时用。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    capability: 'time',
    perform(): Promise<ActionResult> {
      const items = store.list();
      if (items.length === 0) {
        return Promise.resolve({ content: '目前没有提醒。' });
      }
      const lines = items.map((r, i) => {
        const when = r.atIso !== undefined ? `(时间 ${r.atIso})` : '';
        return `${i + 1}. ${r.text}${when}`;
      });
      return Promise.resolve({ content: `当前有 ${items.length} 条提醒:\n${lines.join('\n')}` });
    },
  };
}
