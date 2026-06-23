import type { Action, ActionResult } from '../types';

/**
 * 事实查询接缝(§12.2)。同步、纯本地:给定 query,返回一条事实串;
 * 返回 `undefined`/空 = 没查到。**interaction 不依赖 memory 包**——真正接 memory
 * 由调用方在别处注入此回调(后续接线),本包只持有函数引用。
 */
export type FactLookup = (query: string) => string | undefined;

/** 缺省事实查询:恒"暂不可用"(查不到)——保持 interaction 与 memory 解耦。 */
const unavailableLookup: FactLookup = () => undefined;

/**
 * 内置本地动作:召回一条事实(§12.2)。入参 `{ query }`,经**注入的事实查询回调**查询。
 * **不依赖 memory 包**:缺省回调返回"暂不可用"。回调未命中(undefined/空)属正常"没查到"
 * (返回可读说明,**非** isError);query 缺失/空 → isError(不抛)。
 * 不声明 capability(纯本地查询,任何设备可用 → 永远授权)。
 */
export function createRecallFactAction(lookup: FactLookup = unavailableLookup): Action {
  return {
    name: 'recall_fact',
    description:
      '回忆/查询一条已知事实(如用户偏好、之前说过的事)。入参 {query:"想查的内容"}。' +
      '当需要"记得用户某件事"时用;查不到会如实说想不起。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '想查询的事实关键词或问题' },
      },
      required: ['query'],
    },
    perform(input: unknown): Promise<ActionResult> {
      const obj = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
      const query = obj['query'];
      if (typeof query !== 'string' || query.trim() === '') {
        return Promise.resolve({ content: '入参非法:query 不能为空', isError: true });
      }
      const found = lookup(query);
      if (found === undefined || found.trim() === '') {
        // 没查到属正常结果(非 error):让模型据此如实回应,而非当作故障。
        return Promise.resolve({ content: `我暂时想不起关于「${query}」的事。` });
      }
      return Promise.resolve({ content: found });
    },
  };
}
