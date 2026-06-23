import type { LoadedPersonaCard } from './types';

/**
 * 记忆写入器(结构类型,§3.1):@chat-a/memory 的 `MemoryStore` 结构上满足之,
 * 故 persona 无需在运行时依赖 memory 包(与 KvLike 同一手法)。
 */
export interface MemoryAdder {
  addMemory(rec: {
    readonly text: string;
    readonly kind?: string;
    readonly subject?: 'person' | 'agent' | 'shared';
    readonly personId?: string;
  }): void;
}

/**
 * 把 PersonaCard 的角色背景/用户画像种子化进记忆(§6.2)。
 * - lore → `subject=agent`(可召回自我 lore,不进静态骨架),kind=self_lore。
 * - userProfile + 兼容单行 legacyProfile → 默认 subject(person/主用户),kind=user_profile。
 * 去重幂等由 MemoryStore 保证(§5.8);本函数只负责"写哪些、什么主语"。
 * 返回实际尝试写入的画像条数(供编排层打横幅,§8.1)。
 */
export function seedPersonaMemories(
  adder: MemoryAdder,
  loaded: Pick<LoadedPersonaCard, 'lore' | 'userProfile'>,
  legacyProfile?: string,
): { lore: number; userProfile: number } {
  for (const text of loaded.lore) {
    adder.addMemory({ text, kind: 'self_lore', subject: 'agent' });
  }
  const userProfile = [
    ...loaded.userProfile,
    ...(legacyProfile !== undefined && legacyProfile.trim().length > 0 ? [legacyProfile.trim()] : []),
  ];
  for (const text of userProfile) {
    adder.addMemory({ text, kind: 'user_profile' });
  }
  return { lore: loaded.lore.length, userProfile: userProfile.length };
}
