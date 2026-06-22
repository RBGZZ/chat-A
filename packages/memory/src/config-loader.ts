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

export function createMemoryStoreFromEnv(env: NodeJS.ProcessEnv = process.env): MemorySetup {
  const backend = (env['CHAT_A_MEMORY_BACKEND'] ?? 'sqlite').toLowerCase() === 'memory' ? 'memory' : 'sqlite';

  const snapshotLimit = positiveInt(env['CHAT_A_MEMORY_SNAPSHOT_LIMIT']);
  const recallLimit = positiveInt(env['CHAT_A_MEMORY_RECALL_LIMIT']);
  // 主用户身份是配置(§3.2),缺省回落 DEFAULT_MEMORY_CONFIG 的内置默认。
  const primaryPersonId = nonEmpty(env['CHAT_A_MEMORY_PRIMARY_PERSON_ID']);
  const primaryPersonName = nonEmpty(env['CHAT_A_MEMORY_PRIMARY_PERSON_NAME']);
  const config: Partial<MemoryConfig> = {
    ...(snapshotLimit !== undefined ? { snapshotLimit } : {}),
    ...(recallLimit !== undefined ? { recallLimit } : {}),
    ...(primaryPersonId !== undefined ? { primaryPersonId } : {}),
    ...(primaryPersonName !== undefined ? { primaryPersonName } : {}),
  };

  if (backend === 'memory') {
    return { store: new InMemoryMemoryStore({ config }), backend };
  }
  const dbPath = env['CHAT_A_MEMORY_DB'] ?? 'chat-a-memory.db';
  return { store: new SqliteMemoryStore({ path: dbPath, config }), backend, dbPath };
}
