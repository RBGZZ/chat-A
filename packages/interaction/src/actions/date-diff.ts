import type { Action, ActionResult } from '../types';

/**
 * 内置本地动作:计算两日期相差天数(§12.2)。纯本地、**确定性**(不读 Date.now、不引随机)。
 * 入参 { from, to }(ISO 日期/时间);返回 (to - from) 的天数(可负),整天差。
 * 任一不可解析 → isError(不抛)。不声明 capability(纯计算,任何设备可用 → 永远授权)。
 */
export function createDateDiffAction(): Action {
  return {
    name: 'date_diff',
    description:
      '计算两个日期相差多少天(to - from,可为负)。入参 {from:"ISO 日期", to:"ISO 日期"},' +
      '如 {from:"2026-06-20", to:"2026-06-23"}。当用户问"还有几天 / 距某天多久 / 两天相差几天"时用。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '起始日期(ISO 8601),如 2026-06-20' },
        to: { type: 'string', description: '结束日期(ISO 8601),如 2026-06-23' },
      },
      required: ['from', 'to'],
    },
    perform(input: unknown): Promise<ActionResult> {
      const obj = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
      const from = obj['from'];
      const to = obj['to'];
      if (typeof from !== 'string') return Promise.resolve(err('from 必须是字符串日期'));
      if (typeof to !== 'string') return Promise.resolve(err('to 必须是字符串日期'));
      const fromMs = Date.parse(from);
      const toMs = Date.parse(to);
      if (Number.isNaN(fromMs)) return Promise.resolve(err(`from 不可解析为时间:${from}`));
      if (Number.isNaN(toMs)) return Promise.resolve(err(`to 不可解析为时间:${to}`));
      // 整天差:毫秒差 / 一天毫秒数,向零取整(确定性、无浮点尾巴)。
      const days = Math.trunc((toMs - fromMs) / 86_400_000);
      return Promise.resolve({ content: `${from} 到 ${to} 相差 ${days} 天` });
    },
  };
}

function err(msg: string): ActionResult {
  return { content: `日期计算失败:${msg}`, isError: true };
}
