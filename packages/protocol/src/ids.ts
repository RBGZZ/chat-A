/**
 * 关联 ID(承 §8.1):sessionId / turnId / generation / requestId / personId 贯穿全链。
 * 用品牌类型防止 ID 串用;id/时钟可注入(承 AIRI port 模式,便于可测试/可重放)。
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type SessionId = Brand<string, 'SessionId'>;
export type TurnId = Brand<string, 'TurnId'>;
export type RequestId = Brand<string, 'RequestId'>;
export type PersonId = Brand<string, 'PersonId'>;
/** 跨网络无条件打断的精确机制:单调递增,终端丢弃不匹配的迟到帧(§4)。 */
export type Generation = Brand<number, 'Generation'>;

export interface Correlation {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly generation: Generation;
  readonly requestId?: RequestId;
  readonly personId?: PersonId;
}

/** 可注入的 ID 工厂(测试用确定性桩替换;承 §3.2 可测试性)。 */
export interface IdFactory {
  newId(): string;
}

/** correlationId 的规范串形:session/turn/generation(同一回合内稳定)。 */
export function correlationKey(c: Correlation): string {
  return `${c.sessionId}/${c.turnId}/${c.generation}`;
}
