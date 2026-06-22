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

export function createMemoryStoreFromEnv(env: NodeJS.ProcessEnv = process.env): MemorySetup {
  const backend = (env['CHAT_A_MEMORY_BACKEND'] ?? 'sqlite').toLowerCase() === 'memory' ? 'memory' : 'sqlite';

  const snapshotLimit = positiveInt(env['CHAT_A_MEMORY_SNAPSHOT_LIMIT']);
  const recallLimit = positiveInt(env['CHAT_A_MEMORY_RECALL_LIMIT']);
  const config: Partial<MemoryConfig> = {
    ...(snapshotLimit !== undefined ? { snapshotLimit } : {}),
    ...(recallLimit !== undefined ? { recallLimit } : {}),
  };

  if (backend === 'memory') {
    return { store: new InMemoryMemoryStore({ config }), backend };
  }
  const dbPath = env['CHAT_A_MEMORY_DB'] ?? 'chat-a-memory.db';
  return { store: new SqliteMemoryStore({ path: dbPath, config }), backend, dbPath };
}
