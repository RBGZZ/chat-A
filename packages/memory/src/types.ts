import type { ChatMessage } from '@chat-a/protocol';

export type { ChatMessage };

/** 落库的对话消息(snapshot 的来源;承 §5 真相源)。 */
export interface StoredMessage {
  readonly sessionId: string;
  readonly turnId: string;
  readonly role: ChatMessage['role'];
  readonly content: string;
  readonly createdAtMs: number;
  /** 关联 ID(§8.1 贯穿);可缺省。 */
  readonly correlationId?: string;
}

/** 写入一条记忆条目的输入(ADD 语义,§5.8)。 */
export interface MemoryInput {
  readonly text: string;
  /** 记忆种类(自由字符串,P1 不强约束)。 */
  readonly kind?: string;
  readonly sourceSession?: string;
  /** 省略则由实现取"现在"(注入时钟便于确定性测试,§3.2)。 */
  readonly createdAtMs?: number;
}

/** 召回返回的记忆条目。 */
export interface MemoryRecord {
  readonly id: number;
  readonly text: string;
  readonly kind: string | undefined;
  readonly createdAtMs: number;
  readonly lastSeenAtMs: number;
  readonly hits: number;
}

/**
 * 记忆存储接缝(承 §3.1):cognition/runtime 只依赖本接口,不碰具体实现内部。
 * 内存实现与 SQLite 实现满足同一契约、可互换;同步签名(本地毫秒级读 + 同步驱动)。
 */
export interface MemoryStore {
  /** 追加一条对话消息(snapshot 来源)。 */
  appendMessage(msg: StoredMessage): void;
  /** 取最近 N 条消息(滑窗快照,跨会话恢复连续性);N 省略用配置默认。 */
  snapshot(limit?: number): readonly ChatMessage[];
  /** ADD 一条记忆条目(带去重)。 */
  addMemory(rec: MemoryInput): void;
  /** 关键词召回(P1 关键词级;语义/向量属 P2)。 */
  recall(query: string, limit?: number): readonly MemoryRecord[];
  /** 释放底层资源(SQLite 句柄等)。 */
  close(): void;
}
