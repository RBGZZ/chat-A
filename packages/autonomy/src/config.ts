/**
 * autonomy 引擎配置(行为即配置,§3.2):预算上限 / enabled 查询全外置,无 magic number。
 * 默认**全关**(承切片要求"默认全关、可配"):`isEnabled` 默认对任何技能返回 false。
 */

/**
 * autonomy 配置接口。
 * - `maxNoActionRetries`:no-action 预算上限(默认 3,§7「再想一次」)。
 * - `isEnabled`:**每 tick 现读**——SkillScheduler 每个 tick 用 skillId 查询当前是否启用,
 *   改配置下一 tick 生效(无需重启,§7)。做成函数而非快照,以支持热读/热切。
 */
export interface AutonomyConfig {
  readonly maxNoActionRetries: number;
  readonly isEnabled: (skillId: string) => boolean;
}

/** 默认配置:预算 3、所有技能默认关(用户自治 + 默认全关)。 */
export const DEFAULT_AUTONOMY_CONFIG: AutonomyConfig = {
  maxNoActionRetries: 3,
  isEnabled: () => false,
};

/** 合并用户覆盖与默认值(单一入口,杜绝各处各拼一遍)。 */
export function resolveAutonomyConfig(overrides?: Partial<AutonomyConfig>): AutonomyConfig {
  return { ...DEFAULT_AUTONOMY_CONFIG, ...overrides };
}

/**
 * 便捷构造:用一个可变的"已启用技能集合"驱动 `isEnabled`(测试/简单场景友好)。
 * 返回 config + 暴露的 set——改 set 即改配置,下一 tick 经 `isEnabled` 现读生效,
 * 正是"改配置/API 下一 tick 生效无重启"(§7)的最小落地。
 */
export function enabledSetConfig(
  initialEnabled: Iterable<string> = [],
  overrides?: Partial<Omit<AutonomyConfig, 'isEnabled'>>,
): { config: AutonomyConfig; enabled: Set<string> } {
  const enabled = new Set<string>(initialEnabled);
  const config: AutonomyConfig = {
    ...DEFAULT_AUTONOMY_CONFIG,
    ...overrides,
    isEnabled: (skillId: string) => enabled.has(skillId),
  };
  return { config, enabled };
}
