import type { ChatMessage, MemoryInput, MemoryRecord, MemoryStore, StoredMessage } from './types';
import { resolveMemoryConfig, tokenize, type MemoryConfig } from './config';

interface MutableRecord {
  id: number;
  text: string;
  normalized: string;
  kind: string | undefined;
  createdAtMs: number;
  lastSeenAtMs: number;
  hits: number;
}

export interface InMemoryMemoryStoreOptions {
  readonly config?: Partial<MemoryConfig>;
  /** 注入时钟(确定性测试,§3.2)。 */
  readonly now?: () => number;
}

/**
 * 进程内记忆实现(承接旧 ConversationMemory 滑窗语义)。
 * 与 SqliteMemoryStore 满足同一 MemoryStore 契约;无持久化(重启即失忆,符合预期)。
 */
export class InMemoryMemoryStore implements MemoryStore {
  readonly #messages: StoredMessage[] = [];
  readonly #memories = new Map<string, MutableRecord>();
  readonly #state = new Map<string, string>();
  readonly #cfg: MemoryConfig;
  readonly #now: () => number;
  #seq = 0;

  constructor(opts: InMemoryMemoryStoreOptions = {}) {
    this.#cfg = resolveMemoryConfig(opts.config);
    this.#now = opts.now ?? Date.now;
  }

  appendMessage(msg: StoredMessage): void {
    this.#messages.push(msg);
  }

  snapshot(limit: number = this.#cfg.snapshotLimit): readonly ChatMessage[] {
    const start = Math.max(0, this.#messages.length - limit);
    return this.#messages.slice(start).map((m) => ({ role: m.role, content: m.content }));
  }

  addMemory(rec: MemoryInput): void {
    const normalized = this.#cfg.normalize(rec.text);
    if (normalized.length === 0) return;
    const at = rec.createdAtMs ?? this.#now();
    const existing = this.#memories.get(normalized);
    if (existing !== undefined) {
      existing.hits += 1;
      existing.lastSeenAtMs = at;
      return;
    }
    this.#memories.set(normalized, {
      id: ++this.#seq,
      text: rec.text,
      normalized,
      kind: rec.kind,
      createdAtMs: at,
      lastSeenAtMs: at,
      hits: 1,
    });
  }

  recall(query: string, limit: number = this.#cfg.recallLimit): readonly MemoryRecord[] {
    const tokens = tokenize(query, this.#cfg.normalize);
    if (tokens.length === 0) return [];
    const hits = [...this.#memories.values()].filter((r) =>
      tokens.some((t) => r.normalized.includes(t)),
    );
    hits.sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs || b.hits - a.hits || b.id - a.id);
    return hits.slice(0, limit).map((r) => ({
      id: r.id,
      text: r.text,
      kind: r.kind,
      createdAtMs: r.createdAtMs,
      lastSeenAtMs: r.lastSeenAtMs,
      hits: r.hits,
    }));
  }

  getState(key: string): string | undefined {
    return this.#state.get(key);
  }

  setState(key: string, value: string): void {
    this.#state.set(key, value);
  }

  close(): void {
    // 无资源可释放。
  }
}
