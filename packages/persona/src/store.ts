import type { KvLike, PersonaSnapshot, PersonaStore } from './types';

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 形状校验:防旧版/损坏快照把 NaN 灌进 PAD 数学(回退种子比带病续接更安全)。 */
function isValidSnapshot(v: unknown): v is PersonaSnapshot {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  const ocean = s['ocean'] as Record<string, unknown> | undefined;
  const pad = s['pad'] as Record<string, unknown> | undefined;
  if (ocean === undefined || pad === undefined) return false;
  const oceanOk = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'].every((k) =>
    isFiniteNum(ocean[k]),
  );
  const padOk = ['pleasure', 'arousal', 'dominance'].every((k) => isFiniteNum(pad[k]));
  return oceanOk && padOk && isFiniteNum(s['turn']);
}

/** 进程内人格状态存储(默认/测试)。 */
export class InMemoryPersonaStore implements PersonaStore {
  #snapshot: PersonaSnapshot | null = null;
  load(): PersonaSnapshot | null {
    return this.#snapshot;
  }
  save(snapshot: PersonaSnapshot): void {
    this.#snapshot = snapshot;
  }
}

const STATE_KEY = 'persona:snapshot';

/**
 * 基于通用 KV(结构类型 KvLike)的人格状态存储:把 PersonaSnapshot JSON 序列化存一个 key。
 * @chat-a/memory 的 MemoryStore 结构上满足 KvLike——runtime 直接注入,persona 不依赖 memory 包。
 */
export function createKvPersonaStore(kv: KvLike): PersonaStore {
  return {
    load(): PersonaSnapshot | null {
      const raw = kv.getState(STATE_KEY);
      if (raw === undefined) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        return isValidSnapshot(parsed) ? parsed : null;
      } catch {
        return null; // 解析失败/形状非法 → 视作无状态,用种子初始化(优雅降级)。
      }
    },
    save(snapshot: PersonaSnapshot): void {
      kv.setState(STATE_KEY, JSON.stringify(snapshot));
    },
  };
}
