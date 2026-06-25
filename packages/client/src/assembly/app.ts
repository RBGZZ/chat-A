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
import {
  createLlm,
  loadLlmConfig,
  createTts,
  loadTtsConfig,
  type LlmConfig,
  type LlmProvider,
  type TtsProvider,
  type TtsConfig,
} from '@chat-a/providers';
import { initTelemetry } from '@chat-a/observability';
import { createMemoryStoreFromEnv, type MemoryStore } from '@chat-a/memory';
import {
  loadPersonaFromEnv,
  loadPersonaConfigFromEnv,
  seedPersonaMemories,
  createKvPersonaStore,
  PersonaEngine,
  LlmAppraiser,
  applyPersonaPatch,
  personaViewOf,
  type Appraiser,
  type PersonaConfig,
  type PersonaSeed,
  type PersonaStore,
  type PersonaPatch,
  type PersonaView,
  type SttEmotionLike,
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
 * 三独立语种 + 朗读运行时设置(承 canonical §4.1 语种解耦):
 * - `displayLang`:显示文字语种(驱动 LLM 回复语言 = Conversation 的 outputLang;''=自动)。
 * - `ttsLang`:合成音频语种(TTS 的 language;'follow'/''=跟随显示)。**desktop 侧解析,app 只透传给 voice-profile env**。
 * - `cloneRefLang`:复刻参考语种(复刻录音是什么语言;''=不指定)。
 * - `speak`:朗读开关(on/off)。
 * 各字段省略 = 不改动该项(部分更新友好)。
 */
export interface LangSettings {
  readonly displayLang?: string;
  readonly ttsLang?: string;
  readonly cloneRefLang?: string;
  readonly speak?: boolean;
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
  /**
   * 读当前可编辑人格视图(名字 + 三档情绪旋钮);desktop 人格面板初值用(承北极星「人格由用户自定义」)。
   */
  readonly personaView: () => PersonaView;
  /**
   * 应用人格修改(运行时生效):据补丁产出新种子 → **重建 PersonaEngine + Conversation**
   * (复用同一 memory 真相源与 personaStore,长期记忆与 PAD 状态续接;sessionId 不变,对话不断)。
   * engine 不支持运行时改 dials,故走"更新 seed → 重装配"路径(类比 reset 但带新种子、保会话)。
   * 返回应用后的可编辑视图。
   */
  applyPersona(patch: PersonaPatch): PersonaView;
  /**
   * TTS provider(本批次「朗读」用):文字回合后据语种解耦合成 PCM 推渲染层。
   * 由 `createTts(loadTtsConfig(env))` 装配;Fake/无真合成时朗读不可用(见 ttsConfig.kind),
   * 主进程据此禁用朗读开关、绝不崩。语音模式(VoiceLoop)另有自己的 TTS 装配,互不影响。
   */
  readonly tts: TtsProvider;
  /** TTS 配置(横幅/朗读可用性判定用;kind==='fake' → 朗读不可用)。 */
  readonly ttsConfig: TtsConfig;
  /** 当前显示文字语种(''=自动);经 getter 暴露,`applyLang` 改后读取拿最新。 */
  readonly displayLang: string;
  /**
   * 应用语种/朗读设置(运行时生效,§4.1):
   * - 改 `displayLang` → **重建 Conversation**(沿用 sessionId,保留 memory/PAD)让新 outputLang 进系统提示;
   * - `ttsLang`/`cloneRefLang`/`speak` → 同步对应 env(供 voice-profile / 复刻 / 朗读读取),不重建 convo。
   * 返回应用后的最终设置(各字段已规整)。
   */
  applyLang(settings: LangSettings): Required<LangSettings>;
  /** omni 直路系统提示组装(与文字链路同源 persona/记忆/语气);语音 omni 路用。 */
  readonly composeOmniInstructions: () => string | Promise<string>;
  /**
   * omni 路「情感→PAD」prosody 推进(omni-prosody-to-pad,§7#5);语音 omni 路用。
   * 把 omni 回合剥出的语气情绪经同一 Conversation 的内部 persona 并入 PAD(复用 prosodyToPadPull)。
   */
  readonly advanceProsody: (emotion: SttEmotionLike) => Promise<void>;
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

  // 情绪评估器(§3.1 LLM 认知 opt-in,镜像 cli):CHAT_A_APPRAISER=llm → 用 LLM 评估每轮 PAD 拉力;
  // 缺省 undefined → Conversation 内部回落 DefaultAppraiser(关键词,逐字现状)。在 assembleApp 作用域建一次,
  // makeConvo 闭包恒捕获 → reset/applyPersona/applyLang 重建会话时自动续接。
  const appraiser: Appraiser | undefined =
    (env['CHAT_A_APPRAISER'] ?? 'default').toLowerCase() === 'llm'
      ? new LlmAppraiser({ provider: llm })
      : undefined;

  // A 层总线(语音/状态派生/感知共用一条)。
  const bus = new LightVoiceBus();

  // 记忆按配置装配(默认 SQLite 真相源,跨重启记得;CHAT_A_MEMORY_BACKEND=memory 可退回内存)。
  const mem = createMemoryStoreFromEnv(env);

  // PersonaCard 装配(§6.2,card-as-config):卡优先、env 覆盖;PAD 状态复用 memory SQLite KV(跨重启续接)。
  const persona = loadPersonaFromEnv(env);
  // seed 可被 applyPersona 在运行时整体替换(人格自定义),故用 let + getter 暴露,读取始终拿最新。
  let seed = persona.seed;
  const personaStore = createKvPersonaStore(mem.store);
  // 种子化角色背景/用户画像(经去重幂等,重复启动不新建,§5.8)。
  seedPersonaMemories(mem.store, persona, env['CHAT_A_USER_PROFILE']);

  // 人格内核可调参数(§3.2 行为即配置;承 persona-tunable-seams):冷启动窗口 + PAD→情绪阈值。
  // 不设相关 env 时 = DEFAULT_PERSONA_CONFIG = 现值(逐字零回归)。三处 PersonaEngine 构造点共用之:
  // 显示引擎(下行)、applyPersona 重建、makeConvo→Conversation 内部引擎,保证显示心情与回合心情阈值一致。
  const personaConfig: PersonaConfig = loadPersonaConfigFromEnv(env);

  // 供 mood 摘要读取的 PersonaEngine(与 Conversation 内部 persona 独立实例,但同种子 + 同 store,
  // 状态一致)。desktop 状态栏 / cli persona 摘要读它的 tone()。applyPersona 时随新种子重建。
  let personaEngine = new PersonaEngine({ seed, store: personaStore, config: personaConfig });

  // 朗读 TTS(本批次,§4.1):desktop 文字回合后据语种解耦合成 PCM 推渲染层。
  // createTts(loadTtsConfig(env)):有 key/服务 → 真合成;缺关键项自动降级 fake(kind==='fake' → 朗读不可用)。
  // 语音模式(VoiceLoop)在 startVoiceMode 内另有自己的 TTS 装配,二者互不影响(此处仅供文字路朗读)。
  const ttsConfig = loadTtsConfig(env);
  const tts = createTts(ttsConfig);

  // 显示文字语种(§4.1):驱动 LLM 回复语言(Conversation 的 outputLang)。CHAT_A_DISPLAY_LANG 空=自动(不注入)。
  // 用 let + getter 暴露(仿 seed):applyLang 切换时重建 convo,读取始终拿最新。
  let displayLang = (env['CHAT_A_DISPLAY_LANG'] ?? '').trim();

  // 音频优先模式(§4.1,CHAT_A_TTS_DUAL_OUTPUT=on + 显示≠合成语种):**回复本身直接用合成语种(如日语)**——
  // 不靠模型自觉产"双段+哨兵"(实测 qwen-plus 不遵从该格式),而是让回复就是音频转录文本,desktop 直接逐句流式喂 TTS
  // (首音最快、无翻译阻塞),中文显示由 desktop 在音频之后翻译给出(文字次要)。故此态 outputLang=合成语种。
  const dualOn = ((env['CHAT_A_TTS_DUAL_OUTPUT'] ?? '').trim().toLowerCase()).match(/^(on|1|true|yes)$/) !== null;
  const ttsLangRaw = (env['CHAT_A_TTS_LANG'] ?? '').trim();
  const audioFirst =
    dualOn && displayLang.length > 0 && ttsLangRaw.length > 0 && ttsLangRaw !== 'follow' && ttsLangRaw !== displayLang;
  // 回复语种:音频优先态=合成语种(回复直接是日语→喂 TTS);否则=显示语种(逐字现状)。
  const replyLang = audioFirst ? ttsLangRaw : displayLang;
  // 仅在启用音频优先态时打一行模式确认(默认/同语种用户零噪声);确认 outputLang=合成语种。
  if (audioFirst) console.log(`[audioFirst] display=${JSON.stringify(displayLang)} → 回复/合成=${JSON.stringify(replyLang)}`);

  // Conversation 工厂:`reset()` 用新 sessionId 重建全新上下文(同一套核心依赖)。
  // 注意:本共享层只装配**核心** Conversation(persona/memory/总线/trace 缺省);cli 的
  // LLM 认知升级 / 策略 / 语义召回 / 自我一致性等 opt-in 子系统仍由 cli 自己装配注入
  // (cli 不调用本工厂、用自己的 makeConvo)。desktop MVP 用本核心工厂即可文字可用。
  // §4.1:仅在 displayLang 非空时传 outputLang(让 LLM 用该语种回复);空 → 不传 → 逐字现状(自动)。
  const makeConvo = (sid: string): Conversation =>
    new Conversation({
      bus,
      llm,
      memory: mem.store,
      personaSeed: seed,
      personaStore,
      personaConfig,
      sessionId: sid,
      ...(appraiser ? { appraiser } : {}),
      // §4.1:回复语种。音频优先态=合成语种(回复直接喂 TTS、免译阻塞);否则=显示语种(逐字现状)。
      ...(replyLang.length > 0 ? { outputLang: replyLang } : {}),
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
    get seed(): PersonaSeed {
      return seed;
    },
    personaStore,
    personaCard: persona,
    get persona(): PersonaEngine {
      return personaEngine;
    },
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
    personaView: () => personaViewOf(seed),
    applyPersona(patch: PersonaPatch): PersonaView {
      // 1) 据补丁产出新种子(纯,夹取 [0,1] / 空名回落);2) 重建引擎 + 会话以让新人格运行时生效。
      seed = applyPersonaPatch(seed, patch);
      // PersonaEngine 从 store 复载 PAD 快照(故情绪状态续接),但用新 seed 的 dials/name 渲染 tone。
      // 同样透传 personaConfig(冷启动 + 情绪阈值),与 makeConvo 内部引擎阈值保持一致。
      personaEngine = new PersonaEngine({ seed, store: personaStore, config: personaConfig });
      // 重建 Conversation:沿用同一 sessionId(对话不断、记忆续接),让新 seed 进系统提示。
      convo = makeConvo(sessionId);
      return personaViewOf(seed);
    },
    tts,
    ttsConfig,
    get displayLang(): string {
      return displayLang;
    },
    applyLang(settings: LangSettings): Required<LangSettings> {
      // displayLang 变更 → 同步 env(供横幅/复读)+ **重建 Conversation**(沿用 sessionId,保留 memory/PAD)让新 outputLang 生效。
      if (settings.displayLang !== undefined) {
        const next = settings.displayLang.trim();
        if (next !== displayLang) {
          displayLang = next;
          env['CHAT_A_DISPLAY_LANG'] = next;
          // 语音模式输出语种(voice-profile 读 CHAT_A_VOICE_OUTPUT_LANG)与显示语种对齐:
          // 让免提路小雪也按显示语种说(空=自动,与文字路 outputLang 缺省一致)。
          env['CHAT_A_VOICE_OUTPUT_LANG'] = next;
          // 重建会话:对话不断、记忆续接,仅换 outputLang(空 → 不注入 = 自动)。
          convo = makeConvo(sessionId);
        }
      }
      // 合成语种:同步 voice-profile 读取的 CHAT_A_VOICE_OUTPUT_LANG(供语音模式)+ 本批次 CHAT_A_TTS_LANG(供朗读解析)。
      // 注:朗读侧的 follow/翻译解析在 desktop ipc-contract 纯函数里做;此处只透传 env 真相,convo 不依赖它。
      if (settings.ttsLang !== undefined) {
        env['CHAT_A_TTS_LANG'] = settings.ttsLang;
      }
      // 复刻参考语种:同步 voice-profile 读取的 CHAT_A_VOICE_CLONE_REF_LANG(即时复刻/未来 provider 用)。
      if (settings.cloneRefLang !== undefined) {
        env['CHAT_A_VOICE_CLONE_REF_LANG'] = settings.cloneRefLang;
      }
      // 朗读开关:同步 CHAT_A_DESKTOP_SPEAK(desktop 主进程读它决定是否朗读)。
      if (settings.speak !== undefined) {
        env['CHAT_A_DESKTOP_SPEAK'] = settings.speak ? 'on' : 'off';
      }
      return {
        displayLang,
        ttsLang: (env['CHAT_A_TTS_LANG'] ?? '').trim(),
        cloneRefLang: (env['CHAT_A_VOICE_CLONE_REF_LANG'] ?? '').trim(),
        speak: (env['CHAT_A_DESKTOP_SPEAK'] ?? '').trim().toLowerCase() === 'on',
      };
    },
    composeOmniInstructions: () => convo.composeOmniInstructions(),
    // omni-prosody-to-pad:闭包恒捕获当前 convo(reset/applyLang 重建后自动续接同源 persona/PAD)。
    advanceProsody: (emotion: SttEmotionLike) => convo.advanceProsody(emotion),
    cleanup,
    env,
  };
  return handle;
}
