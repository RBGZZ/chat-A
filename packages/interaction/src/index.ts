import { ActionRegistry } from './registry';
import { createCurrentTimeAction } from './actions/current-time';

export * from './types';
export * from './registry';
export * from './actions/current-time';

/**
 * 装配内置本地动作的默认注册表(§12.2)。now 可注入(确定性测试)。
 * 首批仅 current_time(纯本地无副作用);提醒/播放等有副作用动作待调度/能力门就绪再加。
 */
export function buildDefaultRegistry(opts: { readonly now?: () => Date } = {}): ActionRegistry {
  const registry = new ActionRegistry();
  registry.register(createCurrentTimeAction(opts.now));
  return registry;
}
