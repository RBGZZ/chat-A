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
 * 召回记录的**最小结构契约**(适配 memory 的 `MemoryRecord`,只取本适配器关心的字段)。
 * 用结构化类型而非 import `@chat-a/memory`——interaction 仍不依赖 memory 包(§3.1):
 * 调用方传入满足此形状的对象即可(memory 的 `MemoryRecord` 天然满足)。
 */
export interface FactRecord {
  readonly text: string;
}

/**
 * 召回存储的**最小结构契约**(适配 memory 的 `MemoryStore.recall`,只取关键词召回一项)。
 * 同步签名,与 `FactLookup` 的同步纯本地约定一致;memory 的 `MemoryStore` 天然满足此形状。
 */
export interface FactRecallStore {
  recall(query: string, limit?: number): readonly FactRecord[];
}

/** `createMemoryFactLookup` 选项(行为即配置,§3.2):topN 等参数外置,不写 magic number。 */
export interface MemoryFactLookupOptions {
  /** 召回返回上限(映射到 store.recall 的 limit);省略用 `DEFAULT_RECALL_FACT_TOP_N`。 */
  readonly topN?: number;
  /** 多条命中拼接的分隔串;省略用 `DEFAULT_RECALL_FACT_JOINER`。 */
  readonly joiner?: string;
}

/** recall_fact 召回默认 topN(行为即配置;调用方可经 env 覆盖后传入)。 */
export const DEFAULT_RECALL_FACT_TOP_N = 3;
/** recall_fact 多条命中默认拼接分隔(换行,便于模型逐条阅读)。 */
export const DEFAULT_RECALL_FACT_JOINER = '\n';

/**
 * 把一个**真实召回存储**(memory 的 `MemoryStore` 等满足 `FactRecallStore` 形状者)
 * 适配成 `recall_fact` 期望的同步 `FactLookup`(§12.2 事实查询接缝)。
 *
 * 行为:对 query 调 `store.recall(query, topN)`,取前 topN 条非空文本拼接返回;
 * **降级(§3.2「永不崩永不哑」)**:检索为空 / 全为空白 / `recall` 抛错 → 返回 `undefined`
 * (交由 `recall_fact` 表达"想不起",**非崩溃、非 isError**)。
 *
 * 保持 interaction 与 memory **解耦**:用结构化类型,不 import `@chat-a/memory`;真接线由
 * 调用方(client cli)注入 `mem.store`。
 */
export function createMemoryFactLookup(
  store: FactRecallStore,
  opts: MemoryFactLookupOptions = {},
): FactLookup {
  const topN = opts.topN ?? DEFAULT_RECALL_FACT_TOP_N;
  const joiner = opts.joiner ?? DEFAULT_RECALL_FACT_JOINER;
  return (query: string): string | undefined => {
    let hits: readonly FactRecord[];
    try {
      hits = store.recall(query, topN);
    } catch {
      // 检索出错:优雅降级为"没找到",绝不把故障抛给回合(§3.2)。
      return undefined;
    }
    const texts = hits
      .slice(0, topN)
      .map((h) => (typeof h.text === 'string' ? h.text.trim() : ''))
      .filter((t) => t.length > 0);
    if (texts.length === 0) return undefined;
    return texts.join(joiner);
  };
}

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
