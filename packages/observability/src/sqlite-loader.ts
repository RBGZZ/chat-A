import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

/**
 * node:sqlite「内建不可用」专用错误(承 §3.2 优雅降级):Node ≥24 才内建 `node:sqlite`,
 * Electron 内嵌的旧 Node 没有(`ERR_UNKNOWN_BUILTIN_MODULE`)。调用方(trace/decision sink 装配)
 * 据此**跳过 SQLite 追踪**而非整个应用崩溃——可观测是旁路,绝不拖垮主链路。
 */
export class SqliteUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SqliteUnavailableError';
  }
}

/**
 * 惰性加载 node:sqlite 的 `DatabaseSync`:顶层各文件改 **type-only** 静态 import + 运行时此处
 * `createRequire`,使**模块图不在链接期强制加载 node:sqlite**(否则 Electron 旧 Node 一 import 整个
 * bundle 就崩,连 trace 默认关都救不了)。Node ≥24 正常;不可用 → 抛 {@link SqliteUnavailableError}。
 */
let cachedDatabaseSync: typeof DatabaseSync | undefined;
export function loadDatabaseSync(): typeof DatabaseSync {
  if (cachedDatabaseSync !== undefined) return cachedDatabaseSync;
  try {
    const req = createRequire(import.meta.url);
    cachedDatabaseSync = (req('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
  } catch (err) {
    throw new SqliteUnavailableError(
      'node:sqlite 不可用(需 Node ≥24;Electron 内嵌旧 Node 无内建 SQLite);可观测追踪本次跳过。',
      { cause: err },
    );
  }
  return cachedDatabaseSync;
}
