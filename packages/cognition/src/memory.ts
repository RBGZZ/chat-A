import type { ChatMessage } from '@chat-a/protocol';

/**
 * 极简会话历史(内存,滑动窗口)。MVP 用;后续替换为三层认知记忆(§5:
 * Redis 短期 / SQLite 中期按日期 / 向量库长期 + 混合召回 + 衰减)。
 */
export class ConversationMemory {
  readonly #messages: ChatMessage[] = [];
  readonly #maxTurns: number;

  constructor(maxTurns = 20) {
    this.#maxTurns = maxTurns;
  }

  add(message: ChatMessage): void {
    this.#messages.push(message);
    const cap = this.#maxTurns * 2;
    if (this.#messages.length > cap) {
      this.#messages.splice(0, this.#messages.length - cap);
    }
  }

  snapshot(): readonly ChatMessage[] {
    return [...this.#messages];
  }

  clear(): void {
    this.#messages.length = 0;
  }
}
