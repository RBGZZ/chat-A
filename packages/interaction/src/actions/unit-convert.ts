import type { Action, ActionResult } from '../types';

/**
 * 内置本地动作:固定单位换算(§12.2)。纯本地、确定性。
 * 入参 { value, from, to };同量纲内换算(长度/质量/温度)。
 * 未知单位 / 跨量纲 → isError(不抛)。换算表为外置常量(行为即配置,§3.2)。
 */

/** 单位 → 量纲。 */
const DIMENSION: Readonly<Record<string, string>> = {
  // 长度(基准:米 m)
  mm: 'length',
  cm: 'length',
  m: 'length',
  km: 'length',
  in: 'length',
  ft: 'length',
  mi: 'length',
  // 质量(基准:克 g)
  mg: 'mass',
  g: 'mass',
  kg: 'mass',
  t: 'mass',
  lb: 'mass',
  oz: 'mass',
  // 温度(非线性,单独处理)
  c: 'temperature',
  f: 'temperature',
  k: 'temperature',
};

/** 线性量纲:单位 → 到基准的系数(1 单位 = factor 基准单位)。 */
const TO_BASE: Readonly<Record<string, number>> = {
  // 长度→米
  mm: 0.001,
  cm: 0.01,
  m: 1,
  km: 1000,
  in: 0.0254,
  ft: 0.3048,
  mi: 1609.344,
  // 质量→克
  mg: 0.001,
  g: 1,
  kg: 1000,
  t: 1_000_000,
  lb: 453.59237,
  oz: 28.349523125,
};

export function createUnitConvertAction(): Action {
  return {
    name: 'unit_convert',
    description:
      '在固定换算表内做单位换算(长度 mm/cm/m/km/in/ft/mi、质量 mg/g/kg/t/lb/oz、温度 c/f/k)。' +
      '入参 {value, from, to}。当用户问"X 米是多少公里 / 100 华氏度是多少摄氏度"时用。',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'number', description: '数值' },
        from: { type: 'string', description: '源单位' },
        to: { type: 'string', description: '目标单位' },
      },
      required: ['value', 'from', 'to'],
    },
    perform(input: unknown): Promise<ActionResult> {
      const obj = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
      const value = obj['value'];
      const from = typeof obj['from'] === 'string' ? obj['from'].toLowerCase() : '';
      const to = typeof obj['to'] === 'string' ? obj['to'].toLowerCase() : '';
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return Promise.resolve(err('value 必须是有限数'));
      }
      const dimFrom = DIMENSION[from];
      const dimTo = DIMENSION[to];
      if (dimFrom === undefined) return Promise.resolve(err(`未知单位:${from || '(空)'}`));
      if (dimTo === undefined) return Promise.resolve(err(`未知单位:${to || '(空)'}`));
      if (dimFrom !== dimTo) {
        return Promise.resolve(err(`跨量纲不可换算:${from}(${dimFrom}) → ${to}(${dimTo})`));
      }
      const result = dimFrom === 'temperature' ? convertTemp(value, from, to) : convertLinear(value, from, to);
      if (!Number.isFinite(result)) return Promise.resolve(err('换算结果非有限数'));
      return Promise.resolve({ content: `${value} ${from} = ${result} ${to}` });
    },
  };
}

/** 线性换算:经基准单位。 */
function convertLinear(value: number, from: string, to: string): number {
  const fFrom = TO_BASE[from] as number;
  const fTo = TO_BASE[to] as number;
  return (value * fFrom) / fTo;
}

/** 温度换算(c/f/k):先到摄氏,再到目标。 */
function convertTemp(value: number, from: string, to: string): number {
  let celsius: number;
  switch (from) {
    case 'c':
      celsius = value;
      break;
    case 'f':
      celsius = ((value - 32) * 5) / 9;
      break;
    default: // 'k'
      celsius = value - 273.15;
      break;
  }
  switch (to) {
    case 'c':
      return celsius;
    case 'f':
      return (celsius * 9) / 5 + 32;
    default: // 'k'
      return celsius + 273.15;
  }
}

function err(msg: string): ActionResult {
  return { content: `换算失败:${msg}`, isError: true };
}
