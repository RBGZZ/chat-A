import type { Action, ActionResult } from '../types';

/**
 * 内置本地动作:距某 ISO 时刻还有多久(§12.2)。入参 `{ atIso }`。
 * "当前时间"经**注入时钟**取得(确定性测试,§3.2)。目标已过去给"已过去"说明。
 * atIso 不可解析 → isError(不抛)。声明 `capability:'time'`(读"现在"属时间域)。
 */
export function createCountdownAction(now: () => Date = () => new Date()): Action {
  return {
    name: 'countdown',
    description:
      '计算距离某个时刻还有多久(到点倒计时)。入参 {atIso:"目标时间(ISO 8601)"},' +
      '如 {atIso:"2026-12-31T23:59:59Z"}。当用户问"距某事还有多久 / 还有几天到…"时用。',
    inputSchema: {
      type: 'object',
      properties: {
        atIso: { type: 'string', description: '目标时间(ISO 8601),如 2026-12-31T23:59:59Z' },
      },
      required: ['atIso'],
    },
    capability: 'time',
    perform(input: unknown): Promise<ActionResult> {
      const obj = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
      const atIso = obj['atIso'];
      if (typeof atIso !== 'string') {
        return Promise.resolve({ content: '倒计时失败:atIso 必须是字符串时间', isError: true });
      }
      const targetMs = Date.parse(atIso);
      if (Number.isNaN(targetMs)) {
        return Promise.resolve({ content: `倒计时失败:atIso 不可解析为时间:${atIso}`, isError: true });
      }
      const diffMs = targetMs - now().getTime();
      const span = formatSpan(Math.abs(diffMs));
      if (diffMs > 0) {
        return Promise.resolve({ content: `距 ${atIso} 还有 ${span}。` });
      }
      if (diffMs < 0) {
        return Promise.resolve({ content: `${atIso} 已过去 ${span}。` });
      }
      return Promise.resolve({ content: `现在正好就是 ${atIso}。` });
    },
  };
}

/** 把毫秒时长拆成"X 天 Y 小时 Z 分"(整数运算,确定性、无浮点尾巴)。 */
function formatSpan(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  // 不足 1 分钟时也给"0 分",避免空串。
  if (mins > 0 || parts.length === 0) parts.push(`${mins} 分`);
  return parts.join(' ');
}
