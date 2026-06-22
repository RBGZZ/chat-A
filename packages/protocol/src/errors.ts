/**
 * 错误模型(承 §3.3 错误归因 + MCP 双轨):`fault` 区分系统/工具/用户输入,
 * trace 自带归因;`Result<T>` 让确定性内核不抛异常、可测(§3.2)。
 */
export type Fault = 'system' | 'tool' | 'user-input';

export const ErrorCode = {
  OK: 0,
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  TIMEOUT: 504,
  PROVIDER_FAILED: 502,
  INTERNAL: 500,
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly fault: Fault; readonly message: string; readonly code?: ErrorCode };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T>(fault: Fault, message: string, code?: ErrorCode): Result<T> {
  return code === undefined
    ? { ok: false, fault, message }
    : { ok: false, fault, message, code };
}
