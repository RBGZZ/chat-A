import { InMemoryMemoryStore } from './in-memory-store';
import { SqliteMemoryStore } from './sqlite-store';
import type { MemoryStore } from './types';
import type { MemoryConfig } from './config';

/**
 * 从环境变量装配 MemoryStore(行为即配置,§3.2):
 *   CHAT_A_MEMORY_BACKEND        = sqlite(默认) | memory
 *   CHAT_A_MEMORY_DB             = SQLite 文件路径(默认 chat-a-memory.db)
 *   CHAT_A_MEMORY_SNAPSHOT_LIMIT = 滑窗条数
 *   CHAT_A_MEMORY_RECALL_LIMIT   = 召回上限
 *   CHAT_A_MEMORY_PRIMARY_PERSON_ID   = 主用户稳定标识(§5.3b)
 *   CHAT_A_MEMORY_PRIMARY_PERSON_NAME = 主用户名(§5.3b)
 *   CHAT_A_MEMORY_HALF_LIFE_DAYS      = 时间衰减半衰期 H(天,§5.5)
 *   CHAT_A_MEMORY_REINFORCE_K         = 检索即强化系数 k(§5.5)
 *   CHAT_A_MEMORY_INITIAL_IMPORTANCE  = 重要性初值(§5.5)
 */
export interface MemorySetup {
  readonly store: MemoryStore;
  readonly backend: 'sqlite' | 'memory';
  readonly dbPath?: string;
}

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function nonEmpty(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 正浮点(半衰期 H>0);非法/非正回落 undefined → 用配置默认。 */
function positiveFloat(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** [0,1] 区间浮点(强化系数 k / 重要性初值);越界/非法回落 undefined → 用配置默认。 */
function unitFloat(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

export function createMemoryStoreFromEnv(env: NodeJS.ProcessEnv = process.env): MemorySetup {
  const backend = (env['CHAT_A_MEMORY_BACKEND'] ?? 'sqlite').toLowerCase() === 'memory' ? 'memory' : 'sqlite';

  const snapshotLimit = positiveInt(env['CHAT_A_MEMORY_SNAPSHOT_LIMIT']);
  const recallLimit = positiveInt(env['CHAT_A_MEMORY_RECALL_LIMIT']);
  // 主用户身份是配置(§3.2),缺省回落 DEFAULT_MEMORY_CONFIG 的内置默认。
  const primaryPersonId = nonEmpty(env['CHAT_A_MEMORY_PRIMARY_PERSON_ID']);
  const primaryPersonName = nonEmpty(env['CHAT_A_MEMORY_PRIMARY_PERSON_NAME']);
  // §5.5 衰减/强化参数也是配置(§3.2),缺省回落 DEFAULT_MEMORY_CONFIG 默认。
  const halfLifeDays = positiveFloat(env['CHAT_A_MEMORY_HALF_LIFE_DAYS']);
  const reinforceK = unitFloat(env['CHAT_A_MEMORY_REINFORCE_K']);
  const initialImportance = unitFloat(env['CHAT_A_MEMORY_INITIAL_IMPORTANCE']);
  const config: Partial<MemoryConfig> = {
    ...(snapshotLimit !== undefined ? { snapshotLimit } : {}),
    ...(recallLimit !== undefined ? { recallLimit } : {}),
    ...(primaryPersonId !== undefined ? { primaryPersonId } : {}),
    ...(primaryPersonName !== undefined ? { primaryPersonName } : {}),
    ...(halfLifeDays !== undefined ? { halfLifeDays } : {}),
    ...(reinforceK !== undefined ? { reinforceK } : {}),
    ...(initialImportance !== undefined ? { initialImportance } : {}),
  };

  if (backend === 'memory') {
    return { store: new InMemoryMemoryStore({ config }), backend };
  }
  const dbPath = env['CHAT_A_MEMORY_DB'] ?? 'chat-a-memory.db';
  return { store: new SqliteMemoryStore({ path: dbPath, config }), backend, dbPath };
}
