import { trace, type Tracer } from '@opentelemetry/api';
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
