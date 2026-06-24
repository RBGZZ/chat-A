/**
 * 夜间巩固触发装配薄壳(runtime-assembly-wiring,承 §5.1 / §3.2)。
 *
 * {@link Consolidator} 本身已是后台、幂等、失败仅告警;本薄壳只补**触发点 + 生命周期接线**:
 * 在 cli 会话结束(退出收尾 / `/reset` 换会话)调 `session-end` 触发,fire-and-forget、
 * 失败仅告警、绝不阻塞退出或主对话。
 *
 * **默认关**(行为即配置):`CHAT_A_CONSOLIDATION=on` 才装配;缺省/其它 = off → 返回 `undefined`
 * (不构造 Consolidator;既有 `LlmReflector` 收尾不变,二者正交:reflector=会话蒸馏,
 * consolidator=离线双 Pass 调和 + 惊奇门控)。
 *
 * 纯装配(§3.1):不 import memory 内部,只经导出的 `Consolidator` 类型化接缝接线。
 */
import { stdout } from 'node:process';
import type { LlmProvider } from '@chat-a/providers';
import {
  Consolidator,
  type ConsolidationInput,
  type ConsolidationState,
  type MemoryStore,
} from '@chat-a/memory';

/** 巩固触发运行句柄:会话级 + 节奏(daily/每 N 轮)触发(均后台幂等);`stop` 收尾(无资源,占位)。 */
export interface ConsolidationHandle {
  /** 触发一个单元的 session-end 巩固(fire-and-forget,失败仅告警,幂等)。返回触发用的 Promise 供测试 await。 */
  consolidateSession(unit: string): Promise<void>;
  /**
   * 节奏触发(companion-coherence-wiring,§5.1):据 `state`(距上次巩固轮数 / 上次巩固时刻)判定
   * `every-n-turns` 或 `daily` 是否到阈值(任一命中即触发);命中则后台 fire-and-forget 巩固该 `unit`
   * (失败仅告警、绝不阻塞热路径)。返回是否触发(`true`=判定应巩固并已起后台 run,供调用方重置计数)。
   */
  maybeConsolidateByCadence(unit: string, state: ConsolidationState): Promise<boolean>;
  stop(): void;
}

/** 巩固是否开启:`CHAT_A_CONSOLIDATION=on`(大小写不敏感、去空白);缺省/其它 = off。 */
export function isConsolidationEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env['CHAT_A_CONSOLIDATION'] ?? '').trim().toLowerCase() === 'on';
}

/**
 * 缺省巩固入参构造:从 store 取近期记忆作候选/既有(MVP 最小)。
 * 读失败 / 空库 → 返回空入参(`Consolidator.run` 内部对空安全跳过,不调 LLM)。
 * 真实接线可注入更精细的 `buildInput`(按主题/时间窗组织)。
 */
function defaultBuildInput(store: MemoryStore): ConsolidationInput {
  try {
    const recent = store.openThreads(20);
    return { candidates: recent, existing: recent };
  } catch {
    return { candidates: [], existing: [] };
  }
}

export interface AssembleConsolidationDeps {
  readonly llm: LlmProvider;
  readonly store: MemoryStore;
  /** 注入时钟(确定性测试);缺省 Date.now。 */
  readonly now?: () => number;
  /** 自定义巩固入参构造(缺省取近期 openThreads)。 */
  readonly buildInput?: (store: MemoryStore) => ConsolidationInput;
}

/**
 * 按开关装配巩固触发。off → undefined;on → 建 Consolidator,返回 `{ consolidateSession, stop }`。
 * `consolidateSession(unit)`:`shouldRun(session-end)` 判定后后台 `run`(catch 告警),幂等二次跳过。
 */
export function assembleConsolidation(
  env: NodeJS.ProcessEnv,
  deps: AssembleConsolidationDeps,
): ConsolidationHandle | undefined {
  if (!isConsolidationEnabled(env)) return undefined;

  const consolidator = new Consolidator({
    provider: deps.llm,
    store: deps.store,
    ...(deps.now ? { now: deps.now } : {}),
    onError: (err) =>
      stdout.write(`[巩固] 失败(已告警,主对话不受影响):${err instanceof Error ? err.message : String(err)}\n`),
  });
  const buildInput = deps.buildInput ?? defaultBuildInput;

  // 后台 fire-and-forget 跑一次巩固(run 内部已幂等 + 失败仅告警;此处再兜底 catch,绝不阻塞)。
  const runUnit = async (unit: string): Promise<void> => {
    await consolidator.run(unit, buildInput(deps.store)).then(
      () => {},
      (err) =>
        stdout.write(`[巩固] run 异常(已告警):${err instanceof Error ? err.message : String(err)}\n`),
    );
  };

  return {
    consolidateSession: async (unit: string): Promise<void> => {
      try {
        if (!consolidator.shouldRun({ kind: 'session-end', unit }, {})) return;
        await runUnit(unit);
      } catch (err) {
        stdout.write(`[巩固] 触发异常(已告警):${err instanceof Error ? err.message : String(err)}\n`);
      }
    },
    maybeConsolidateByCadence: async (unit: string, state: ConsolidationState): Promise<boolean> => {
      try {
        // every-n-turns 与 daily 任一到阈值即触发(纯函数判定,用编排器配置 + 注入时钟,确定性可测)。
        const due =
          consolidator.shouldRun({ kind: 'every-n-turns', unit }, state) ||
          consolidator.shouldRun({ kind: 'daily', unit }, state);
        if (!due) return false;
        await runUnit(unit); // 后台幂等;同 unit 二次由 run 内存在性检查跳过。
        return true;
      } catch (err) {
        stdout.write(`[巩固] 节奏触发异常(已告警):${err instanceof Error ? err.message : String(err)}\n`);
        return false;
      }
    },
    stop: () => {
      /* Consolidator 无需释放的资源(库句柄属 memory store,由 cli 统一关) */
    },
  };
}
