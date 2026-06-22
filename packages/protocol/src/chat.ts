/** 跨模块共享的对话消息类型(cognition 历史与 providers 请求共用,§3.1)。 */
export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}
