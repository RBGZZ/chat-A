import type { Action, ActionResult } from '../types';

/** 一条已存提醒。onDue 为到点回调接口,本切片**不接调度器**,仅预留。 */
export interface StoredReminder {
  readonly text: string;
  readonly atIso?: string;
  /** 到点触发回调(预留接口;本期无调度器调用它,§12.2 调度接线待 runtime 调度器就绪)。 */
  readonly onDue?: () => void;
}

/**
 * 提醒存储接缝(进程内,§12.2)。可注入以支持确定性测试与跨调用读取。
 * 不触达任何外部进程/磁盘——纯内存。
 */
export interface ReminderStore {
  add(reminder: StoredReminder): StoredReminder;
  list(): readonly StoredReminder[];
}

/** 默认进程内实现:数组存储。 */
export class InMemoryReminderStore implements ReminderStore {
  readonly #items: StoredReminder[] = [];

  add(reminder: StoredReminder): StoredReminder {
    this.#items.push(reminder);
    return reminder;
  }

  list(): readonly StoredReminder[] {
    return [...this.#items];
  }
}

/** 读取某存储里的全部提醒(便捷函数)。 */
export function listReminders(store: ReminderStore): readonly StoredReminder[] {
  return store.list();
}

/**
 * 内置本地动作:设置提醒(**内存版**,§12.2)。入参 { text, atIso? }。
 * 仅入列 + 可经 listReminders 读取;**不接调度/定时器**(无外部副作用)。
 * atIso 若提供且不可解析 → isError(不抛)。store 可注入。
 */
export function createSetReminderAction(store: ReminderStore): Action {
  return {
    name: 'set_reminder',
    description:
      '设置一个提醒(内存版,记下要提醒的事)。入参 {text:"要提醒的内容", atIso?:"ISO时间,可选"}。' +
      '当用户说"提醒我…"时用。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '提醒内容' },
        atIso: { type: 'string', description: '可选,提醒时间(ISO 8601),如 2026-06-23T20:00:00Z' },
      },
      required: ['text'],
    },
    perform(input: unknown): Promise<ActionResult> {
      const obj = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
      const text = obj['text'];
      if (typeof text !== 'string' || text.trim() === '') {
        return Promise.resolve({ content: '入参非法:text 不能为空', isError: true });
      }
      const atIsoRaw = obj['atIso'];
      let atIso: string | undefined;
      if (atIsoRaw !== undefined && atIsoRaw !== null) {
        if (typeof atIsoRaw !== 'string' || Number.isNaN(Date.parse(atIsoRaw))) {
          return Promise.resolve({ content: `入参非法:atIso 不可解析为时间(${String(atIsoRaw)})`, isError: true });
        }
        atIso = atIsoRaw;
      }
      // exactOptionalPropertyTypes:atIso 缺省时不带该键。
      store.add(atIso !== undefined ? { text, atIso } : { text });
      return Promise.resolve({
        content: atIso !== undefined ? `已记下提醒:「${text}」(时间 ${atIso})` : `已记下提醒:「${text}」`,
      });
    },
  };
}
