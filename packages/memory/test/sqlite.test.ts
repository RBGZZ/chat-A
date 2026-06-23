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

  it('v2→v3 迁移:存量记忆 backfill 为 person+主用户,零丢失,且 people 表有主用户行(§5.3/§5.3b/§3.2)', () => {
    const path = newPath();
    // 造一个 v2 库:memories(无 subject/person_id)+ 两行存量记忆 + kv_state + schema_version=2。
    const v2 = new DatabaseSync(path);
    v2.exec(`CREATE TABLE memory_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    v2.exec(`CREATE TABLE memories(
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, normalized_text TEXT NOT NULL UNIQUE,
      kind TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      hits INTEGER NOT NULL DEFAULT 1, source_session TEXT);`);
    v2.exec(`CREATE TABLE kv_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    v2.prepare(`INSERT INTO memories(text, normalized_text, created_at, last_seen_at) VALUES(?, ?, ?, ?)`).run('旧记忆甲', '旧记忆甲', 1, 1);
    v2.prepare(`INSERT INTO memories(text, normalized_text, created_at, last_seen_at) VALUES(?, ?, ?, ?)`).run('旧记忆乙', '旧记忆乙', 2, 2);
    v2.prepare(`INSERT INTO memory_meta(key, value) VALUES('schema_version', '2')`).run();
    v2.close();

    // 用自定义主用户身份打开(行为即配置,§3.2):验证 seed/backfill 用注入值而非硬编码。
    const store = new SqliteMemoryStore({
      path,
      config: { primaryPersonId: 'u-main', primaryPersonName: '阿雪' },
    });
    // 零丢失:两条存量记忆仍可召回。
    expect(store.recall('旧记忆甲').map((r) => r.text)).toEqual(['旧记忆甲']);
    // backfill:存量记忆归为 person + 主用户。
    const recalled = store.recall('旧记忆乙');
    expect(recalled[0]?.subject).toBe('person');
    expect(recalled[0]?.personId).toBe('u-main');
    store.close();

    const check = new DatabaseSync(path);
    // schema 升至 v3。
    const v = check.prepare(`SELECT value FROM memory_meta WHERE key='schema_version'`).get();
    expect(Number(v?.['value'])).toBe(CURRENT_SCHEMA_VERSION);
    // 存量两条全部 backfill,零遗漏(无 subject IS NULL 残留)。
    const nullCount = check.prepare(`SELECT COUNT(*) AS c FROM memories WHERE subject IS NULL`).get();
    expect(Number(nullCount?.['c'])).toBe(0);
    const total = check.prepare(`SELECT COUNT(*) AS c FROM memories`).get();
    expect(Number(total?.['c'])).toBe(2);
    // people 表存在主用户行(is_primary=1, status='primary', 名字来自配置)。
    const primary = check
      .prepare(`SELECT person_id, name, is_primary, status, added_by FROM people WHERE is_primary=1`)
      .get();
    expect(primary?.['person_id']).toBe('u-main');
    expect(primary?.['name']).toBe('阿雪');
    expect(Number(primary?.['is_primary'])).toBe(1);
    expect(primary?.['status']).toBe('primary');
    expect(primary?.['added_by']).toBe('user');
    // 恰好一个主用户。
    const primaryCount = check.prepare(`SELECT COUNT(*) AS c FROM people WHERE is_primary=1`).get();
    expect(Number(primaryCount?.['c'])).toBe(1);
    check.close();
  });

  it('v3→v4 迁移:存量记忆补默认评分列(importance/access_count/pinned),零丢失(§5.5/§3.2)', () => {
    const path = newPath();
    // 造一个 v3 库:memories(带 subject/person_id,无评分列)+ people + 两行存量记忆 + schema_version=3。
    const v3 = new DatabaseSync(path);
    v3.exec(`CREATE TABLE memory_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    v3.exec(`CREATE TABLE memories(
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, normalized_text TEXT NOT NULL UNIQUE,
      kind TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      hits INTEGER NOT NULL DEFAULT 1, source_session TEXT, subject TEXT, person_id TEXT);`);
    v3.exec(`CREATE TABLE kv_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    v3.exec(`CREATE TABLE people(
      person_id TEXT PRIMARY KEY, name TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL, added_by TEXT NOT NULL, relationship_state TEXT, voiceprint_ref TEXT);`);
    v3.prepare(`INSERT INTO people(person_id, name, is_primary, status, added_by) VALUES('primary','主人',1,'primary','user')`).run();
    v3.prepare(`INSERT INTO memories(text, normalized_text, created_at, last_seen_at, subject, person_id) VALUES(?,?,?,?,?,?)`).run('v3记忆甲', 'v3记忆甲', 1, 1, 'person', 'primary');
    v3.prepare(`INSERT INTO memories(text, normalized_text, created_at, last_seen_at, subject, person_id) VALUES(?,?,?,?,?,?)`).run('v3记忆乙', 'v3记忆乙', 2, 2, 'person', 'primary');
    v3.prepare(`INSERT INTO memory_meta(key, value) VALUES('schema_version', '3')`).run();
    v3.close();

    // 用自定义初值打开(行为即配置,§3.2):验证 backfill 用注入初值而非硬编码。
    const store = new SqliteMemoryStore({ path, config: { initialImportance: 0.42 } });
    // 零丢失:两条存量记忆仍可召回。
    expect(store.recall('v3记忆甲').map((r) => r.text)).toEqual(['v3记忆甲']);
    store.close();

    const check = new DatabaseSync(path);
    // schema 升至 v4(= CURRENT_SCHEMA_VERSION)。
    const v = check.prepare(`SELECT value FROM memory_meta WHERE key='schema_version'`).get();
    expect(Number(v?.['value'])).toBe(CURRENT_SCHEMA_VERSION);
    // 历史行补默认:importance=配置初值、access_count=0、pinned=0(注意:首次召回会强化一行,故查未被召回的乙)。
    const yi = check.prepare(`SELECT importance, access_count, pinned, last_accessed FROM memories WHERE normalized_text='v3记忆乙'`).get();
    expect(Number(yi?.['importance'])).toBeCloseTo(0.42, 6);
    expect(Number(yi?.['access_count'])).toBe(0);
    expect(Number(yi?.['pinned'])).toBe(0);
    // 无 importance IS NULL 残留(全部 backfill)。
    const nullCount = check.prepare(`SELECT COUNT(*) AS c FROM memories WHERE importance IS NULL`).get();
    expect(Number(nullCount?.['c'])).toBe(0);
    check.close();
  });

  it('v4→v5 迁移:存量记忆补默认未闭合列(open_thread=0/closed_at NULL),零丢失(§7#2/§3.2)', () => {
    const path = newPath();
    // 造一个 v4 库:memories 带 v4 全列(subject/person_id + 评分列),无 open_thread/closed_at + schema_version=4。
    const v4 = new DatabaseSync(path);
    v4.exec(`CREATE TABLE memory_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    v4.exec(`CREATE TABLE memories(
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, normalized_text TEXT NOT NULL UNIQUE,
      kind TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      hits INTEGER NOT NULL DEFAULT 1, source_session TEXT, subject TEXT, person_id TEXT,
      importance REAL, access_count INTEGER, last_accessed INTEGER, pinned INTEGER, emotion_snapshot TEXT);`);
    v4.exec(`CREATE TABLE kv_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    v4.exec(`CREATE TABLE people(
      person_id TEXT PRIMARY KEY, name TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL, added_by TEXT NOT NULL, relationship_state TEXT, voiceprint_ref TEXT);`);
    v4.prepare(`INSERT INTO people(person_id, name, is_primary, status, added_by) VALUES('primary','主人',1,'primary','user')`).run();
    v4.prepare(`INSERT INTO memories(text, normalized_text, created_at, last_seen_at, subject, person_id, importance, access_count, last_accessed, pinned)
                VALUES(?,?,?,?,?,?,?,?,?,?)`).run('v4记忆甲', 'v4记忆甲', 1, 1, 'person', 'primary', 0.5, 0, 1, 0);
    v4.prepare(`INSERT INTO memories(text, normalized_text, created_at, last_seen_at, subject, person_id, importance, access_count, last_accessed, pinned)
                VALUES(?,?,?,?,?,?,?,?,?,?)`).run('v4记忆乙', 'v4记忆乙', 2, 2, 'person', 'primary', 0.5, 0, 2, 0);
    v4.prepare(`INSERT INTO memory_meta(key, value) VALUES('schema_version', '4')`).run();
    v4.close();

    const store = new SqliteMemoryStore({ path });
    // 零丢失:两条存量记忆仍可召回。
    expect(store.recall('v4记忆甲').map((r) => r.text)).toEqual(['v4记忆甲']);
    // backfill:存量记忆为"非未了事"(openThread=false),不进未闭合查询。
    expect(store.recall('v4记忆乙')[0]?.openThread).toBe(false);
    expect(store.openThreads()).toEqual([]);
    store.close();

    const check = new DatabaseSync(path);
    // schema 升至 v5(= CURRENT_SCHEMA_VERSION)。
    const v = check.prepare(`SELECT value FROM memory_meta WHERE key='schema_version'`).get();
    expect(Number(v?.['value'])).toBe(CURRENT_SCHEMA_VERSION);
    // 历史行补默认:open_thread=0、closed_at NULL;无 open_thread IS NULL 残留(全部 backfill)。
    const yi = check.prepare(`SELECT open_thread, closed_at FROM memories WHERE normalized_text='v4记忆乙'`).get();
    expect(Number(yi?.['open_thread'])).toBe(0);
    expect(yi?.['closed_at']).toBeNull();
    const nullCount = check.prepare(`SELECT COUNT(*) AS c FROM memories WHERE open_thread IS NULL`).get();
    expect(Number(nullCount?.['c'])).toBe(0);
    check.close();
  });

  it('v6→v7 迁移:存量记忆按信号归类(pinned→core / 其余→semantic),零丢失、幂等(§5.9 缺口④/§3.2)', () => {
    const path = newPath();
    // 造一个 v6 库:memories 带 v6 全列(含 open_thread/closed_at,无 memory_kind)+ people + 联想网表 + schema_version=6。
    const v6 = new DatabaseSync(path);
    v6.exec(`CREATE TABLE memory_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    v6.exec(`CREATE TABLE memories(
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, normalized_text TEXT NOT NULL UNIQUE,
      kind TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      hits INTEGER NOT NULL DEFAULT 1, source_session TEXT, subject TEXT, person_id TEXT,
      importance REAL, access_count INTEGER, last_accessed INTEGER, pinned INTEGER, emotion_snapshot TEXT,
      open_thread INTEGER, closed_at INTEGER);`);
    v6.exec(`CREATE TABLE kv_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    v6.exec(`CREATE TABLE people(
      person_id TEXT PRIMARY KEY, name TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL, added_by TEXT NOT NULL, relationship_state TEXT, voiceprint_ref TEXT);`);
    v6.exec(`CREATE TABLE memory_entities(memory_id INTEGER NOT NULL, entity_key TEXT NOT NULL, PRIMARY KEY(memory_id, entity_key));`);
    v6.exec(`CREATE TABLE memory_edges(a INTEGER NOT NULL, b INTEGER NOT NULL, weight INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(a, b));`);
    v6.prepare(`INSERT INTO people(person_id, name, is_primary, status, added_by) VALUES('primary','主人',1,'primary','user')`).run();
    // 普通(非 pinned)旧记忆 → 应归 semantic;pinned 旧记忆 → 应归 core。
    v6.prepare(`INSERT INTO memories(text, normalized_text, created_at, last_seen_at, subject, person_id, importance, access_count, last_accessed, pinned, open_thread)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('普通旧记忆', '普通旧记忆', 1, 1, 'person', 'primary', 0.5, 0, 1, 0, 0);
    v6.prepare(`INSERT INTO memories(text, normalized_text, created_at, last_seen_at, subject, person_id, importance, access_count, last_accessed, pinned, open_thread)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('核心旧记忆', '核心旧记忆', 2, 2, 'person', 'primary', 0.5, 0, 2, 1, 0);
    v6.prepare(`INSERT INTO memory_meta(key, value) VALUES('schema_version', '6')`).run();
    v6.close();

    const store = new SqliteMemoryStore({ path });
    // 零丢失:两条存量记忆仍可召回。
    expect(store.recall('普通旧记忆').map((r) => r.text)).toEqual(['普通旧记忆']);
    // backfill 归类:非 pinned → semantic;pinned → core。
    expect(store.recall('普通旧记忆')[0]?.memoryKind).toBe('semantic');
    const core = store.recall('核心旧记忆')[0];
    expect(core?.memoryKind).toBe('core');
    expect(core?.pinned).toBe(true);
    store.close();

    const check = new DatabaseSync(path);
    // schema 升至 v7(= CURRENT_SCHEMA_VERSION)。
    const v = check.prepare(`SELECT value FROM memory_meta WHERE key='schema_version'`).get();
    expect(Number(v?.['value'])).toBe(CURRENT_SCHEMA_VERSION);
    // 无 memory_kind IS NULL 残留(全部 backfill)。
    const nullCount = check.prepare(`SELECT COUNT(*) AS c FROM memories WHERE memory_kind IS NULL`).get();
    expect(Number(nullCount?.['c'])).toBe(0);
    // 落库归类正确。
    const pu = check.prepare(`SELECT memory_kind FROM memories WHERE normalized_text='普通旧记忆'`).get();
    expect(pu?.['memory_kind']).toBe('semantic');
    const he = check.prepare(`SELECT memory_kind FROM memories WHERE normalized_text='核心旧记忆'`).get();
    expect(he?.['memory_kind']).toBe('core');
    check.close();

    // 幂等:同库再开一次(已是 v7)不重复迁移、不改归类、不报错。
    const reopen = new SqliteMemoryStore({ path });
    expect(reopen.recall('核心旧记忆')[0]?.memoryKind).toBe('core');
    expect(reopen.recall('普通旧记忆')[0]?.memoryKind).toBe('semantic');
    reopen.close();
  });

  it('memoryKind 跨重启持久化:写入 → close → 重开仍保留分层(§5.9 缺口④)', () => {
    const path = newPath();
    const a = new SqliteMemoryStore({ path });
    a.addMemory({ text: '用户对花生过敏', createdAtMs: 1, memoryKind: 'core' });
    a.addMemory({ text: '用户喜欢咖啡', createdAtMs: 2, memoryKind: 'semantic' });
    a.close();
    const b = new SqliteMemoryStore({ path });
    expect(b.recall('花生')[0]?.memoryKind).toBe('core');
    expect(b.recall('咖啡')[0]?.memoryKind).toBe('semantic');
    b.close();
  });

  it('未闭合话题持久化:标记 → close → 重开后状态保留(§7#2)', () => {
    const path = newPath();
    const a = new SqliteMemoryStore({ path });
    a.addMemory({ text: '面试待跟进', createdAtMs: 1, openThread: true });
    a.addMemory({ text: '体检待跟进', createdAtMs: 2, openThread: true });
    const tijian = a.recall('体检')[0]!;
    a.closeThread(tijian.id); // 闭合体检
    a.close();

    const b = new SqliteMemoryStore({ path });
    // 重开后:面试仍未闭合、体检已闭合(状态持久化)。
    expect(b.openThreads(10).map((r) => r.text)).toEqual(['面试待跟进']);
    expect(b.recall('体检')[0]?.openThread).toBe(false);
    b.close();
  });

  it('全新库初始化即 seed 主用户花名册(承 §5.3b)', () => {
    const path = newPath();
    const store = new SqliteMemoryStore({ path });
    store.close();
    const check = new DatabaseSync(path);
    const primary = check.prepare(`SELECT person_id, status FROM people WHERE is_primary=1`).get();
    // 缺省主用户 id 为内置默认 'primary'。
    expect(primary?.['person_id']).toBe('primary');
    expect(primary?.['status']).toBe('primary');
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
