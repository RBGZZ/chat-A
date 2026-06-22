import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteMemoryStore, CURRENT_SCHEMA_VERSION } from '../src/index';
import { runMemoryStoreContract } from './contract';

const dir = mkdtempSync(join(tmpdir(), 'chat-a-mem-'));
afterAll(() => {
  // Windows 上 WAL/shm 释放有延迟,清理尽力而为(重试 + 吞 EPERM,不让 teardown 染红用例)。
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* best-effort */
  }
});
let seq = 0;
const newPath = (): string => join(dir, `m${++seq}.db`);

// 契约(内存库即可覆盖读写/去重/召回/快照)。
runMemoryStoreContract(
  'SqliteMemoryStore(:memory:)',
  (opts) => new SqliteMemoryStore({ path: ':memory:', ...(opts?.now ? { now: opts.now } : {}) }),
);

describe('SqliteMemoryStore 持久化 / 迁移 / 降级', () => {
  it('跨重启恢复:写入 → close → 同路径重开仍在', () => {
    const path = newPath();
    const a = new SqliteMemoryStore({ path });
    a.appendMessage({ sessionId: 's', turnId: 't1', role: 'user', content: '记住我叫小明', createdAtMs: 1 });
    a.addMemory({ text: '用户叫小明', createdAtMs: 1 });
    a.close();

    const b = new SqliteMemoryStore({ path });
    expect(b.snapshot(10).map((m) => m.content)).toEqual(['记住我叫小明']);
    expect(b.recall('小明').map((r) => r.text)).toEqual(['用户叫小明']);
    b.close();
  });

  it('迁移:已有数据的旧库(无版本)被纳管且数据保留', () => {
    const path = newPath();
    // 造一个 legacy 库:有 memories 表+一行,但无 memory_meta(视作 v0)。
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE memories(
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, normalized_text TEXT NOT NULL UNIQUE,
      kind TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      hits INTEGER NOT NULL DEFAULT 1, source_session TEXT);`);
    legacy
      .prepare(`INSERT INTO memories(text, normalized_text, created_at, last_seen_at) VALUES(?, ?, ?, ?)`)
      .run('遗留记忆', '遗留记忆', 1, 1);
    legacy.close();

    const store = new SqliteMemoryStore({ path });
    expect(store.recall('遗留记忆').map((r) => r.text)).toEqual(['遗留记忆']);
    store.close();

    const check = new DatabaseSync(path);
    const v = check.prepare(`SELECT value FROM memory_meta WHERE key='schema_version'`).get();
    expect(Number(v?.['value'])).toBe(CURRENT_SCHEMA_VERSION);
    check.close();
  });

  it('v1→v2 迁移:旧 v1 库升级后保留记忆且 KV 可用', () => {
    const path = newPath();
    // 造一个 v1 库:memories 表 + 一行 + schema_version=1(无 kv_state)。
    const v1 = new DatabaseSync(path);
    v1.exec(`CREATE TABLE memory_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    v1.exec(`CREATE TABLE memories(
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, normalized_text TEXT NOT NULL UNIQUE,
      kind TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      hits INTEGER NOT NULL DEFAULT 1, source_session TEXT);`);
    v1.prepare(`INSERT INTO memories(text, normalized_text, created_at, last_seen_at) VALUES(?, ?, ?, ?)`).run('v1记忆', 'v1记忆', 1, 1);
    v1.prepare(`INSERT INTO memory_meta(key, value) VALUES('schema_version', '1')`).run();
    v1.close();

    const store = new SqliteMemoryStore({ path });
    expect(store.recall('v1记忆').map((r) => r.text)).toEqual(['v1记忆']); // 记忆保留
    store.setState('persona:snapshot', '{"ok":true}'); // v2 的 kv_state 可用
    expect(store.getState('persona:snapshot')).toBe('{"ok":true}');
    store.close();

    const check = new DatabaseSync(path);
    const v = check.prepare(`SELECT value FROM memory_meta WHERE key='schema_version'`).get();
    expect(Number(v?.['value'])).toBe(CURRENT_SCHEMA_VERSION);
    check.close();
  });

  it('KV 跨重启恢复', () => {
    const path = newPath();
    const a = new SqliteMemoryStore({ path });
    a.setState('persona:snapshot', '{"turn":3}');
    a.close();
    const b = new SqliteMemoryStore({ path });
    expect(b.getState('persona:snapshot')).toBe('{"turn":3}');
    b.close();
  });

  it('拒绝更高的未知 schema 版本(不损坏库)', () => {
    const path = newPath();
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE memory_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    db.prepare(`INSERT INTO memory_meta(key, value) VALUES('schema_version', ?)`).run('99');
    db.close();
    expect(() => new SqliteMemoryStore({ path })).toThrow(/高于代码支持/);
  });

  it('读失败优雅降级为空,写失败不抛(§3.2)', () => {
    const ops: string[] = [];
    const store = new SqliteMemoryStore({ path: ':memory:', onError: (_e, op) => ops.push(op) });
    store.addMemory({ text: 'x', createdAtMs: 1 });
    store.close(); // 关闭后再读 → 应返回空而非抛
    expect(store.recall('x')).toEqual([]);
    expect(() =>
      store.appendMessage({ sessionId: 's', turnId: 't', role: 'user', content: 'y', createdAtMs: 1 }),
    ).not.toThrow();
    expect(ops).toContain('recall');
  });
});
