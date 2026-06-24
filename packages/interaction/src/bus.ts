import type { BusEvent } from '@chat-a/protocol';

/**
 * A 层总线发布接口(§4.2 接缝)——interaction 子系统**只依赖此最小契约**,不直接 import
 * runtime 的 `LightVoiceBus`(避免 runtime→interaction→runtime 循环依赖;§3.1 模块解耦)。
 *
 * runtime 接线时把 `LightVoiceBus` 实例(其 `emit`/`currentCorrelationId` 形态完全兼容)
 * 注入进来即可;测试注入 mock 收集事件。感知/动作子系统**只发不订阅**——契合 §12"只采集/执行不决策"。
 */
export interface EventPublisher {
  /** 发布一条 A 层总线事件。 */
  emit(event: BusEvent): void;
  /** 当前关联 ID(AsyncLocalStorage 传播);无上下文时 undefined。 */
  currentCorrelationId?(): string | undefined;
}

/**
 * 收集型发布器:测试用,记录所有 emit 的事件,便于断言总线序列。
 * 也可作"无总线"降级桩(发布即丢弃 + 记录),保证子系统 standalone 可跑。
 */
export class CollectingPublisher implements EventPublisher {
  readonly events: BusEvent[] = [];
  #correlationId: string | undefined;

  constructor(correlationId?: string) {
    this.#correlationId = correlationId;
  }

  emit(event: BusEvent): void {
    this.events.push(event);
  }

  currentCorrelationId(): string | undefined {
    return this.#correlationId;
  }

  /** 过滤指定 action 的事件(测试便捷)。 */
  byAction(action: string): BusEvent[] {
    return this.events.filter((e) => e.action === action);
  }
}
