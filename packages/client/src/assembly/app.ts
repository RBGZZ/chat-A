/**
 * 共享会话装配 `assembleApp()`(承 desktop-electron-frontend §2):把 cli.ts 里
 * "加载 .env.local + LLM provider + LightVoiceBus + memory + persona + Conversation 工厂 + 幂等收尾"
 * 这套**核心装配**抽成一个**无交互副作用**(不依赖 readline / 不写 stdout)的可复用单元,
 * 供 **CLI 文字前端** 与 **Electron 桌面前端** 共用(in-process 同一套大脑装配)。
 *
 * 设计取舍(§3.1 最小重构、爆炸半径可控):
 * - 只抽 **CLI 与 desktop 共用的核心**(llm/bus/memory/persona/Conversation 工厂/收尾);
 *   cli 特有的高级子系统接线(autonomy / 感知 / 巩固 / 自我一致性 / LLM 认知升级 / 语音模式 /
 *   横幅/命令/readline)**留在 cli.ts**——它们要么要 stdout 交互,要么是 opt-in 的复杂接线,
 *   不强行塞进共享层以免放大爆炸半径。
 * - 抽出的逻辑与 cli 原 `main()` **逐字等价**:同样的 env 加载语义、同样的 provider/memory/persona
 *   解析、同样的 Conversation 工厂依赖、同样的幂等收尾,保证 cli 复用后行为不变。
 *
 * 可测试性(§3.2):`assembleApp()` 不触网(FakeLLM 缺省)、不碰 readline,故可在 vitest 里直接
 * `assembleApp()` → `convo.send(...)` 断言流式 token + reply;`cleanup()` 幂等可反复调。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd as procCwd, env as procEnv } from 'node:process';
import { Conversation, LightVoiceBus } from '@chat-a/runtime';
import { createLlm, loadLlmConfig, type LlmConfig, type LlmProvider } from '@chat-a/providers';
import { initTelemetry } from '@chat-a/observability';
import { createMemoryStoreFromEnv, type MemoryStore } from '@chat-a/memory';
import {
  loadPersonaFromEnv,
  seedPersonaMemories,
  createKvPersonaStore,
  PersonaEngine,
  type PersonaSeed,
  type PersonaStore,
} from '@chat-a/persona';
import { parseDotEnv, applyDotEnv } from '../env-file';

/**
 * 加载项目根 `.env.local`(与 start.bat / cli 行为一致):存在才读、解析为纯函数、
 * 注入**不覆盖**真实 env;文件缺失/读失败静默跳过,绝不崩(§3.2)。
 * 导出供 cli 与 desktop 主进程共用(避免各自重抄)。
 */
export function loadEnvLocal(env: NodeJS.ProcessEnv = procEnv, cwd: string = procCwd()): void {
  try {
    const text = readFileSync(join(cwd, '.env.local'), 'utf8');
    applyDotEnv(parseDotEnv(text), env);
  } catch {
    // 文件不存在 / 读取失败 → 静默(用户可能直接用进程环境变量或 start.bat)。
  }
}

/** memory 后端可读摘要(横幅/状态行用)。 */
export interface MemoryInfo {
  readonly backend: string;
  readonly dbPath?: string;
}

/**
 * `assembleApp()` 返回的核心句柄:CLI 与 desktop 共用的最小面。
 * 高级子系统(autonomy/感知/巩固/语音)由各前端在此之上自行接线(默认关时零开销)。
 */
export interface AppHandle {
  /** A 层事件总线(跨模块;语音/状态派生/感知共用)。 */
  readonly bus: LightVoiceBus;
  /** LLM provider(语音 omni / 高级子系统装配可复用)。 */
  readonly llm: LlmProvider;
  /** LLM 配置(provider/model;横幅/状态行用)。 */
  readonly llmConfig: LlmConfig;
  /** memory 真相源(语音半句写回 / 高级装配用)。 */
  readonly memory: MemoryStore;
  /** memory 后端摘要(横幅用)。 */
  readonly memoryInfo: MemoryInfo;
  /** 人格种子(横幅/persona 摘要用)。 */
  readonly seed: PersonaSeed;
  /** 人格状态持久化(复用 memory SQLite KV);cli 自建增强 Conversation 时复用,避免双开库。 */
  readonly personaStore: PersonaStore;
  /** 人格卡原始加载结果(env 覆盖/卡来源等元信息;cli 状态行用)。 */
  readonly personaCard: ReturnType<typeof loadPersonaFromEnv>;
  /** 人格引擎(读当前心情渲染 mood 摘要;与 Conversation 内部 persona 独立但同种子)。 */
  readonly persona: PersonaEngine;
  /** 当前会话(`reset()` 后换新实例;经 getter 暴露,读取始终拿到最新)。 */
  readonly convo: Conversation;
  /** 贯穿当前会话的 sessionId(`reset()` 后换新;经 getter 暴露)。 */
  readonly sessionId: string;
  /** Conversation 工厂(同一套依赖装配;`reset()` / 语音稳定 send 适配器用)。 */
  readonly makeConvo: (sid: string) => Conversation;
  /** 换一段新对话:换 sessionId + 重建 convo(长期记忆仍保留)。返回新 sessionId。 */
  reset(): string;
  /** omni 直路系统提示组装(与文字链路同源 persona/记忆/语气);语音 omni 路用。 */
  readonly composeOmniInstructions: () => string | Promise<string>;
  /** 幂等收尾:关库 / 关 trace / 关 telemetry(失败吞,绝不抛);多次调只跑一次。 */
  cleanup(): Promise<void>;
  /** 装配时生效的 env(供前端透传给语音/高级子系统装配)。 */
  readonly env: NodeJS.ProcessEnv;
}

export interface AssembleAppOptions {
  /** 注入 env(测试可控);缺省 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 工作目录(读 `.env.local`);缺省 `process.cwd()`。 */
  readonly cwd?: string;
  /** 是否加载 `.env.local`;缺省 true(与 cli/start.bat 一致)。测试可关。 */
  readonly loadEnv?: boolean;
}

/**
 * 装配核心会话(in-process):env → llm → bus → memory → persona → Conversation 工厂。
 * 不接 readline / 不写 stdout / 不触网(FakeLLM 缺省)。CLI 与 desktop 主进程共用。
 */
export function assembleApp(opts: AssembleAppOptions = {}): AppHandle {
  const env = opts.env ?? procEnv;
  if (opts.loadEnv !== false) {
    loadEnvLocal(env, opts.cwd ?? procCwd());
  }

  // LLM provider(默认解析:DashScope key→qwen / Anthropic key→anthropic / 否则 fake;§填 key 即用)。
  const llmConfig = loadLlmConfig(env);
  const llm = createLlm(llmConfig);

  // A 层总线(语音/状态派生/感知共用一条)。
  const bus = new LightVoiceBus();

  // 记忆按配置装配(默认 SQLite 真相源,跨重启记得;CHAT_A_MEMORY_BACKEND=memory 可退回内存)。
  const mem = createMemoryStoreFromEnv(env);

  // PersonaCard 装配(§6.2,card-as-config):卡优先、env 覆盖;PAD 状态复用 memory SQLite KV(跨重启续接)。
  const persona = loadPersonaFromEnv(env);
  const seed = persona.seed;
  const personaStore = createKvPersonaStore(mem.store);
  // 种子化角色背景/用户画像(经去重幂等,重复启动不新建,§5.8)。
  seedPersonaMemories(mem.store, persona, env['CHAT_A_USER_PROFILE']);

  // 供 mood 摘要读取的 PersonaEngine(与 Conversation 内部 persona 独立实例,但同种子 + 同 store,
  // 状态一致)。desktop 状态栏 / cli persona 摘要读它的 tone()。
  const personaEngine = new PersonaEngine({ seed, store: personaStore });

  // Conversation 工厂:`reset()` 用新 sessionId 重建全新上下文(同一套核心依赖)。
  // 注意:本共享层只装配**核心** Conversation(persona/memory/总线/trace 缺省);cli 的
  // LLM 认知升级 / 策略 / 语义召回 / 自我一致性等 opt-in 子系统仍由 cli 自己装配注入
  // (cli 不调用本工厂、用自己的 makeConvo)。desktop MVP 用本核心工厂即可文字可用。
  const makeConvo = (sid: string): Conversation =>
    new Conversation({
      bus,
      llm,
      memory: mem.store,
      personaSeed: seed,
      personaStore,
      sessionId: sid,
    });

  let sessionId = randomUUID().slice(0, 8);
  let convo = makeConvo(sessionId);

  // OTel 追踪骨架(§8.1):默认不开以免刷屏;设 CHAT_A_TRACE=1 打开控制台 span 树。
  const traceOn = (env['CHAT_A_TRACE'] ?? '').length > 0;
  const telemetry = traceOn ? initTelemetry({ console: true }) : undefined;

  // 幂等收尾(§3.2):关库 / 关 telemetry;失败吞,多次调只跑一次。
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      mem.store.close();
    } catch {
      /* 关库失败不影响退出 */
    }
    await telemetry?.shutdown().catch(() => {});
  };

  const handle: AppHandle = {
    bus,
    llm,
    llmConfig,
    memory: mem.store,
    memoryInfo: { backend: mem.backend, ...(mem.dbPath ? { dbPath: mem.dbPath } : {}) },
    seed,
    personaStore,
    personaCard: persona,
    persona: personaEngine,
    get convo(): Conversation {
      return convo;
    },
    get sessionId(): string {
      return sessionId;
    },
    makeConvo,
    reset(): string {
      sessionId = randomUUID().slice(0, 8);
      convo = makeConvo(sessionId);
      return sessionId;
    },
    composeOmniInstructions: () => convo.composeOmniInstructions(),
    cleanup,
    env,
  };
  return handle;
}
