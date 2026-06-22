/**
 * 跨进程/跨模块消息信封(承 §8.1):一套命名贯穿 bus / WS / 日志 / trace。
 * `action` 复用进程内事件名常量;`correlationId` 一回合内继承(不每次新生成)。
 */
export const PROTOCOL_NAME = 'chat-a' as const;
export const PROTOCOL_VERSION = '0.1.0';

export interface Envelope<TAction extends string, TData> {
  readonly protocol: typeof PROTOCOL_NAME;
  readonly version: string;
  readonly action: TAction;
  /** 0 = OK;非 0 见 errors.ErrorCode。 */
  readonly code: number;
  readonly correlationId: string;
  readonly data: TData;
}
