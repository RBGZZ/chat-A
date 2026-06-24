/**
 * 感知中枢装配薄壳(runtime-assembly-wiring,承 §12.1 / §4.2)。
 *
 * 把 runtime 的 {@link LightVoiceBus} 当 `EventPublisher`(其 `emit`/`currentCorrelationId` 形态
 * 天然满足契约,无需适配器)注入 interaction 的 {@link PerceptionHub},注册内置 `system.tick` 源,
 * start 后感知信号经**真 A 层总线**以 `signal:perception` 流通。
 *
 * **默认关**(行为即配置,§3.2):`CHAT_A_PERCEPTION=on` 才装配;缺省/任何其它值 = off →
 * 返回 `undefined`(不构造 Hub、不起 tick、总线零新事件 → 既有行为逐字不变)。
 * 降级(§3.2):构造/启动抛错仅告警并返回 undefined,绝不拖垮主对话。
 *
 * 纯装配(§3.1):不 import interaction/runtime 内部实现,只经导出的类型化接缝接线。
 */
import { stdout } from 'node:process';
import type { LightVoiceBus } from '@chat-a/runtime';
import { PerceptionHub, createSystemTickSource } from '@chat-a/interaction';

/** 感知装配运行句柄:停 = 停全部源(幂等)。 */
export interface PerceptionHandle {
  /** 实际生效的 tick 周期(ms,状态行用)。 */
  readonly tickMs: number;
  stop(): Promise<void>;
}

/** 内置 system.tick 默认周期(ms):60s 一拍,低频粗粒度(无 magic number,集中此处)。 */
export const DEFAULT_PERCEPTION_TICK_MS = 60_000;

/** 解析 tick 周期:`CHAT_A_PERCEPTION_TICK_MS`,非法/缺省回落默认(>0 整数)。 */
export function loadPerceptionTickMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env['CHAT_A_PERCEPTION_TICK_MS'] ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_PERCEPTION_TICK_MS;
}

/** 感知是否开启:`CHAT_A_PERCEPTION=on`(大小写不敏感、去空白);缺省/其它 = off。 */
export function isPerceptionEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env['CHAT_A_PERCEPTION'] ?? '').trim().toLowerCase() === 'on';
}

/**
 * 按开关装配感知中枢。off → undefined(零开销);on → 起 Hub + system.tick,信号经 `bus` 流通。
 * 可注入 `now`/`schedule`(确定性测试,不依赖真定时器)。
 */
export async function assemblePerception(
  env: NodeJS.ProcessEnv,
  bus: LightVoiceBus,
  opts: {
    readonly now?: () => number;
    readonly schedule?: (fn: () => void, delayMs: number) => () => void;
  } = {},
): Promise<PerceptionHandle | undefined> {
  if (!isPerceptionEnabled(env)) return undefined;

  const tickMs = loadPerceptionTickMs(env);
  try {
    const hub = new PerceptionHub({
      publisher: bus,
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.schedule ? { schedule: opts.schedule } : {}),
    });
    hub.register(
      createSystemTickSource({
        periodMs: tickMs,
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.schedule ? { schedule: opts.schedule } : {}),
      }),
    );
    await hub.start();
    return {
      tickMs,
      stop: async () => {
        try {
          await hub.stop();
        } catch {
          /* 停止失败不影响退出(§3.2) */
        }
      },
    };
  } catch (err) {
    stdout.write(
      `[感知] 中枢启动失败(已跳过,主对话不受影响):${err instanceof Error ? err.message : String(err)}\n`,
    );
    return undefined;
  }
}
