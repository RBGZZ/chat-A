import { trace, isSpanContextValid, type Tracer } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const SERVICE_NAME = 'chat-a';

export interface InitTelemetryOptions {
  readonly serviceName?: string;
  /** 是否加控制台 exporter;省略时:无其它 processor 才默认开,有则不加噪。 */
  readonly console?: boolean;
  /** 注入额外 SpanProcessor(测试用 InMemory;未来落 SQLite 决策 trace 的 processor)。 */
  readonly spanProcessors?: readonly SpanProcessor[];
  /** shutdown 硬超时(ms):树莓派上 flush/shutdown 可能卡(§8.1),默认 3000。 */
  readonly shutdownTimeoutMs?: number;
}

export interface TelemetryHandle {
  /** 平滑关闭(带硬超时);进程退出前调用,确保 span 落地又不卡死。 */
  shutdown(): Promise<void>;
}

let active: NodeTracerProvider | undefined;

/**
 * 初始化 OTel 追踪骨架(§8.1:直接用官方 SDK,不自造)。
 * `register()` 会装上默认的 **AsyncLocalStorageContextManager**——即设计所指"ALS 自动传 traceId"。
 * 幂等:重复调用返回同一 provider 的 handle(不重复 register)。
 */
export function initTelemetry(opts: InitTelemetryOptions = {}): TelemetryHandle {
  const timeoutMs = opts.shutdownTimeoutMs ?? 3000;
  if (active !== undefined) {
    return makeHandle(active, timeoutMs);
  }

  const processors: SpanProcessor[] = [...(opts.spanProcessors ?? [])];
  const wantConsole = opts.console ?? processors.length === 0;
  if (wantConsole) {
    processors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  }

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: opts.serviceName ?? SERVICE_NAME }),
    spanProcessors: processors,
  });
  provider.register();
  active = provider;
  return makeHandle(provider, timeoutMs);
}

function makeHandle(provider: NodeTracerProvider, timeoutMs: number): TelemetryHandle {
  return {
    async shutdown(): Promise<void> {
      const provShutdown = provider.shutdown();
      // 硬超时兜底:不让 flush 卡住进程退出(§8.1 LiveKit 踩过 30–90s)。
      let timer: ReturnType<typeof setTimeout> | undefined;
      const guard = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      });
      try {
        await Promise.race([provShutdown, guard]);
      } catch {
        // shutdown 自身异常吞掉:可观测性不得拖垮主流程(§3.2)。
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (active === provider) active = undefined;
      }
    },
  };
}

/** 取 chat-A 的 tracer;未 init 时返回 API 默认的 no-op tracer(不污染测试/生产降级)。 */
export function getTracer(): Tracer {
  return trace.getTracer(SERVICE_NAME);
}

/**
 * 当前活动 OTel span 的缝合键(§8.1「两层追踪,同 ID 缝合」)。
 *
 * 读 `trace.getActiveSpan()?.spanContext()` 拿 `traceId`/`spanId`,供决策 trace 落库时缝合——
 * 「OTel 发现慢回合 → 跳到 SQLite 完整决策记录」。底层走 OTel 默认的 AsyncLocalStorage
 * context manager,跨 async 自动传播(§8.1)。
 *
 * 返回值刻意用「条件展开」而非显式 `undefined`(合 exactOptionalPropertyTypes):
 * - 无活动 span(未 init / no-op tracer / 不在 span 内)→ 返回 `{}`;
 * - span context 无效(全零 id,如 sampled-out 占位)→ 同样返回 `{}`,绝不写垃圾 id。
 * 调用方据「键是否存在」判断有无缝合键,不会拿到 `traceId: undefined`。
 */
export function captureActiveSpanContext(): { traceId?: string; spanId?: string } {
  const ctx = trace.getActiveSpan()?.spanContext();
  // 无 span 或 span context 无效(全零)→ 不缝合,省略键。
  if (ctx === undefined || !isSpanContextValid(ctx)) return {};
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}
