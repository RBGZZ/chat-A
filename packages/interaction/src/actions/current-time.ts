import type { Action } from '../types';

/**
 * 内置本地动作:查询当前时间(§12.2 示例)。时钟注入便于确定性测试(§3.2)。
 * 无入参——纯本地、无副作用,是 Agent loop 的最简可执行动作样板。
 * 声明 `capability:'time'`(读"现在"属时间域;能力门关时仍始终可用)。
 */
export function createCurrentTimeAction(now: () => Date = () => new Date()): Action {
  return {
    name: 'current_time',
    description: '返回当前的日期和时间(ISO 格式)。当用户问"现在几点/今天几号"时用。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    capability: 'time',
    perform(): Promise<{ content: string }> {
      return Promise.resolve({ content: now().toISOString() });
    },
  };
}
