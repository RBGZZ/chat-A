import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import process, { stdin, stdout, env, argv } from 'node:process';
import { Conversation, ToolCallingStrategy, type LightVoiceBus } from '@chat-a/runtime';
import { buildDefaultRegistry, createMemoryFactLookup } from '@chat-a/interaction';
import { createEmbedder, loadEmbedderConfig } from '@chat-a/providers';
import { createDecisionTraceSinkFromEnv, SqliteAutonomyDecisionSink } from '@chat-a/observability';
import { LlmMemoryExtractor, LlmReflector, NoopReflector } from '@chat-a/memory';
import type { Reflector } from '@chat-a/memory';
import { LlmAppraiser, LlmStanceDetector, LlmOceanEvolver, LlmSelfNotionEvolver, createSelfConsistencyGuard, parseSelfConsistencyMode } from '@chat-a/persona';
import { isAutonomyEnabled } from '@chat-a/autonomy';
import { assembleApp } from './assembly/app';
import { startVoiceMode, type VoiceModeHandle, type VoiceLoopAutonomyView } from './cli-voice';
import { assemblePerception, type PerceptionHandle } from './assembly/perception';
import { assembleAutonomy, type AutonomyHandle } from './assembly/autonomy';
import { assembleConsolidation, type ConsolidationHandle } from './assembly/consolidation';
import { createPresencePort, createCompanionCandidateSource } from './assembly/memory-autonomy-ports';
import { parseCommand, renderHelp, renderPersona, renderBanner } from './commands';

/**
 * chat-A 文字版 MVP REPL —— 面向用户的交互式终端前端(瘦客户端的文字形态,承 §9)。
 * 用 node:readline 异步迭代行;stdin EOF / Ctrl+C / `/quit` 三种情况统一优雅收尾(§3.2)。
 *
 * 交互层(横幅/命令)的纯逻辑抽到 commands.ts、env-file.ts(可单测);本文件是装配 + 副作用薄壳。
 * 核心会话装配(env/llm/bus/memory/persona/Conversation 工厂/收尾)抽到 assembly/app.ts 的
 * `assembleApp()`,与 Electron 桌面前端共用;cli 在其之上接 LLM 认知升级 / 策略 / 语义召回 /
 * 自我一致性 / 语音 / autonomy / 感知 / 巩固等 opt-in 子系统(行为与抽取前逐字一致)。
 */

async function main(): Promise<void> {
  // 核心装配(env 加载 + llm + bus + memory + persona + 基础收尾):与 desktop 共用同一套。
  const app = assembleApp();
  const cfg = app.llmConfig;
  const llm = app.llm;
  const bus = app.bus;
  // memory:复用共享装配开的同一个 store(避免双开 SQLite);保持 mem.store / backend / dbPath 形态。
  const mem = { store: app.memory, backend: app.memoryInfo.backend, dbPath: app.memoryInfo.dbPath };
  // PersonaCard:复用共享装配的卡加载结果与种子/持久化(card 元信息供下方状态行)。
  const persona = app.personaCard;
  const seed = app.seed;
  const personaStore = app.personaStore;
  // 种子化(角色背景/用户画像 → 记忆,去重幂等)已在 assembleApp 内完成,此处不再重复。
  const cardPath = env['CHAT_A_PERSONA_CARD'];
  const personaSource = cardPath && cardPath.trim().length > 0 ? `卡(${cardPath})` : '默认种子';
  const personaEnvOverride =
    [env['CHAT_A_PERSONA_NAME'], env['CHAT_A_PERSONA_IDENTITY'], env['CHAT_A_DIAL_WARMTH'], env['CHAT_A_DIAL_EXPRESSIVENESS'], env['CHAT_A_DIAL_VOLATILITY'], env['CHAT_A_DIAL_INTENSITY']]
      .some((v) => v !== undefined && v.length > 0);
  // LLM 认知升级(默认关):CHAT_A_APPRAISER=llm 用 LLM 评估情绪;CHAT_A_MEMORY_EXTRACT=llm 抽取记忆要点。
  const appraiserMode = (env['CHAT_A_APPRAISER'] ?? 'default').toLowerCase();
  const extractMode = (env['CHAT_A_MEMORY_EXTRACT'] ?? 'off').toLowerCase();
  const appraiser = appraiserMode === 'llm' ? new LlmAppraiser({ provider: llm }) : undefined;
  const memoryExtractor = extractMode === 'llm' ? new LlmMemoryExtractor({ provider: llm }) : undefined;
  // 分歧检测(§7#3 会反对):默认确定性话题命中;CHAT_A_STANCE=llm 用 LLM 检测器(失败降级)。
  const stanceMode = (env['CHAT_A_STANCE'] ?? 'default').toLowerCase();
  const stanceDetector = stanceMode === 'llm' ? new LlmStanceDetector({ provider: llm }) : undefined;
  // 决策 trace(§8.1 可重放):CHAT_A_DECISION_TRACE=1 开启 SQLite sink(默认 Noop)。
  const trace = createDecisionTraceSinkFromEnv();
  // 二级 OCEAN 演化(§6.1,默认关):CHAT_A_OCEAN_EVOLVE=llm 每 N 轮让 LLM 微调人格(失败降级)。
  const evolveMode = (env['CHAT_A_OCEAN_EVOLVE'] ?? 'off').toLowerCase();
  const oceanEvolver = evolveMode === 'llm' ? new LlmOceanEvolver({ provider: llm }) : undefined;
  // 立场强度演化(§7#3,默认关):CHAT_A_SELF_NOTIONS_EVOLVE=llm 让 LLM 据对话强化立场(失败降级)。
  const notionEvolveMode = (env['CHAT_A_SELF_NOTIONS_EVOLVE'] ?? 'off').toLowerCase();
  const selfNotionEvolver = notionEvolveMode === 'llm' ? new LlmSelfNotionEvolver({ provider: llm }) : undefined;
  // 自我一致性锚定(§6.1,companion-coherence-wiring,默认关):CHAT_A_SELF_CONSISTENCY=on|llm 创建启用态 Guard。
  // 回合在回复后判定,drift → 下轮温和重锚;判定经 onDecision 落决策 trace(有 sink 才记);失败降级不锚定不崩。
  // off / 缺省 → 不创建不注入 → 回合不调用 Guard、行为字面不变(缺省安全)。
  const selfConsistencyMode = parseSelfConsistencyMode(env['CHAT_A_SELF_CONSISTENCY']);
  // 判定 trace(§8.1):trace 开启时把漂移判定记一行(可重放最小形态;SQLite 落库为后续可选扩展)。
  const onSelfConsistencyDecision = trace.enabled
    ? (d: import('@chat-a/persona').SelfConsistencyDecision): void => {
        if (d.drift) {
          stdout.write(
            `[自我一致性] drift(${d.mode})${d.anchorText ? ` 锚点=${d.anchorText}` : ''}${d.reason ? ` 理由=${d.reason}` : ''}\n`,
          );
        }
      }
    : undefined;
  const selfConsistencyGuard = createSelfConsistencyGuard(selfConsistencyMode, {
    ...(selfConsistencyMode === 'llm' ? { provider: llm } : {}),
    ...(onSelfConsistencyDecision ? { onDecision: onSelfConsistencyDecision } : {}),
    onError: (err) =>
      stdout.write(`[自我一致性] LLM 判定失败(已降级不锚定):${err instanceof Error ? err.message : String(err)}\n`),
  });
  // 回合策略(§3.3/§12.2 Agent loop,默认单趟):CHAT_A_STRATEGY=tools 启用本地动作工具循环
  // (Provider 不支持工具/空注册表时自动降级回单趟)。
  // recall_fact 接真 memory 检索(§12.2 事实查询接缝):把 mem.store 适配成同步 FactLookup
  // 注入 buildDefaultRegistry——命中走真 recall,空/出错优雅降级为"想不起"(§3.2,不崩不哑)。
  // topN 行为即配置:CHAT_A_RECALL_FACT_TOP_N 覆盖(非法/缺省回落适配器默认),不写 magic number。
  const recallTopNRaw = Number.parseInt(env['CHAT_A_RECALL_FACT_TOP_N'] ?? '', 10);
  const recallTopN = Number.isInteger(recallTopNRaw) && recallTopNRaw > 0 ? recallTopNRaw : undefined;
  const factLookup = createMemoryFactLookup(mem.store, recallTopN !== undefined ? { topN: recallTopN } : {});
  const actionRegistry = buildDefaultRegistry({ factLookup });
  const useTools = (env['CHAT_A_STRATEGY'] ?? 'single').toLowerCase() === 'tools';
  const strategy = useTools ? new ToolCallingStrategy({ registry: actionRegistry }) : undefined;
  // 会话沉淀(§5/§6.1 Reflection,默认关):CHAT_A_REFLECTION=llm 用 LLM 在会话结束蒸馏高层记忆+第一人称自传。
  // sessionId 贯穿 Conversation 与退出收尾的 reflect,保证沉淀只针对本会话消息;`/reset` 会换新 sessionId。
  let sessionId = randomUUID().slice(0, 8);
  const reflectMode = (env['CHAT_A_REFLECTION'] ?? 'off').toLowerCase();
  const reflector: Reflector =
    reflectMode === 'llm' ? new LlmReflector({ provider: llm, store: mem.store }) : new NoopReflector();
  // 语义召回(c2b,§5.5/§5.7b,默认关):设 CHAT_A_EMBEDDER 才启用——query 异步嵌入(非阻塞)+
  // recallHybrid(关键词+向量加权归一)+ 回合收尾后台写侧嵌入。缺省=纯关键词召回,零额外开销。
  const embedderMode = (env['CHAT_A_EMBEDDER'] ?? '').trim();
  const embedder = embedderMode.length > 0 ? createEmbedder(loadEmbedderConfig(env)) : undefined;

  // Conversation 工厂:`/reset` 需用新 sessionId 重建一个全新上下文(同一套依赖装配)。
  const makeConvo = (sid: string): Conversation =>
    new Conversation({
      bus,
      llm,
      memory: mem.store,
      personaSeed: seed,
      personaStore,
      traceSink: trace.sink,
      sessionId: sid,
      ...(appraiser ? { appraiser } : {}),
      ...(memoryExtractor ? { memoryExtractor } : {}),
      ...(stanceDetector ? { stanceDetector } : {}),
      ...(oceanEvolver ? { oceanEvolver } : {}),
      ...(selfNotionEvolver ? { selfNotionEvolver } : {}),
      ...(strategy ? { strategy } : {}),
      ...(embedder ? { embedder } : {}),
      ...(selfConsistencyGuard ? { selfConsistencyGuard } : {}),
    });
  let convo = makeConvo(sessionId);

  // OTel 追踪骨架(§8.1):由 assembleApp 按 CHAT_A_TRACE 统一 init + 在 app.cleanup() 关闭
  // (与抽取前等价:默认不开,设 CHAT_A_TRACE=1 打开控制台 span 树)。此处不再重复 init。

  // ── 友好横幅(面向用户)+ 开发者向的精简状态行(可一眼看出各能力开关) ──
  stdout.write(
    renderBanner({
      name: seed.name,
      provider: cfg.provider,
      model: cfg.model,
      memoryBackend: `${mem.backend}${mem.dbPath ? ` (${mem.dbPath})` : ''}`,
      warmth: seed.dials.baselineWarmth,
      expressiveness: seed.dials.expressiveness,
      volatility: seed.dials.emotionalVolatility,
      isFake: cfg.provider === 'fake',
    }) + '\n',
  );
  // 精简状态行:仅在偏离默认时点亮,避免刷屏(默认全关/默认值时这几行多为 default/off)。
  stdout.write(
    `状态: 人格来源=${personaSource}${personaEnvOverride ? '+env' : ''} | 认知 appraiser=${appraiser ? 'llm' : 'default'} 抽取=${memoryExtractor ? 'llm' : 'off'} | ` +
      `分歧=${stanceDetector ? 'llm' : 'default'} | 策略=${useTools ? `tools(${actionRegistry.size})` : 'single'} | 语义召回=${embedder ? embedder.id : 'off'} | ` +
      `自我一致性=${selfConsistencyMode} | 沉淀=${reflectMode === 'llm' ? 'on' : 'off'} trace=${trace.enabled ? 'on' : 'off'}\n`,
  );

  // ── 伴侣主动性接线准备(companion-live-wiring,默认关随 CHAT_A_AUTONOMY) ──
  // autonomy on 时:构造装配层在场近似端口 + 真候选源(未了话题跟进 + idle 想念弧),文字与语音两路共用。
  // off 时全不构造(零开销,逐字不变)。presence 由用户回合/语音活跃刷新,驱动 idle 情绪弧。
  const autonomyOn = isAutonomyEnabled(env);
  const presence = autonomyOn ? createPresencePort() : undefined;
  const companionCandidateSource =
    autonomyOn && presence ? createCompanionCandidateSource({ store: mem.store, presence }) : undefined;
  // 语音活跃也刷新在场:用户开口(vad:speech_start)→ markActive(驱动 idle 弧 once-per-episode)。
  // 经共享总线订阅;off / 无 presence 时不订阅(零开销)。退订纳入收尾。
  const unsubPresence = presence ? bus.on('vad:speech_start', () => presence.markActive()) : undefined;
  // 语音 autonomy 装配钩子(语音模式拿到 VoiceLoop 后回调):on 时注入 voiceState(is_speaking 真闸)+
  // preempt(真打断,受 §7 约束:用户 URGENT 最高、不凌驾用户,沿用 VoiceLoop 内既有实现)+ 真候选源。
  // off 时不传(语音侧零构造 autonomy)。
  const assembleVoiceAutonomy = autonomyOn
    ? (loop: VoiceLoopAutonomyView, voiceBus: LightVoiceBus): AutonomyHandle | undefined =>
        assembleAutonomy(env, {
          bus: voiceBus,
          llm,
          decisionSink: new SqliteAutonomyDecisionSink({ sink: trace.sink }),
          voiceState: () => loop.speakState(),
          preempt: (reason) => void loop.requestAutonomyPreempt(reason),
          ...(companionCandidateSource ? { candidateSource: companionCandidateSource } : {}),
        })
    : undefined;

  // 语音模式(R2,默认关):`--voice` 或 CHAT_A_VOICE=1 切语音;文字模式默认不变。
  // 装配 AudioDevice(真/Fake)→ InProcessAudioTransport → VoiceLoop;send 注入 convo.send(零改 Conversation)。
  const voiceOn = argv.includes('--voice') || (env['CHAT_A_VOICE'] ?? '').length > 0;
  let voice: VoiceModeHandle | undefined;
  if (voiceOn) {
    try {
      voice = await startVoiceMode({
        // 语音用一个稳定的 send 适配器,内部读当前 convo(/reset 后也能拿到新上下文)。
        send: (text, onToken) => convo.send(text, onToken),
        // omni 直路系统提示组装(omni-persona-context):与文字链路同一 Conversation,同源 persona/记忆/语气。
        // 闭包读当前 convo(/reset 后换上下文也跟随);仅 omni 路用到,STT 路与现状逐字不变。
        composeOmniInstructions: () => convo.composeOmniInstructions(),
        memory: mem.store,
        bus,
        sessionId,
        env,
        // 语音 autonomy(默认关):on 时语音侧拿到 VoiceLoop 回调装配 + 注入真闸/抢占/候选源。
        ...(assembleVoiceAutonomy ? { assembleVoiceAutonomy } : {}),
      });
      stdout.write(`语音: on  路径=${voice.info.path}  设备=${voice.info.device}  STT=${voice.info.stt}  TTS=${voice.info.tts}  VAD=${voice.info.vad}  EOU=${voice.info.eou}\n`);
    } catch (err) {
      stdout.write(`语音: 启动失败(回落纯文字):${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  // ── 端到端装配接线(runtime-assembly-wiring,全部默认关 / 缺省 inprocess) ──
  // 感知中枢接真总线(CHAT_A_PERCEPTION=on 才挂;off → undefined,总线零新事件)。
  let perception: PerceptionHandle | undefined;
  try {
    perception = await assemblePerception(env, bus);
  } catch {
    /* 感知装配失败不影响主对话(§3.2) */
  }
  // autonomy 上线(CHAT_A_AUTONOMY=on 才挂;决策落 SQLite 决策 trace,同 correlationId 缝合)。
  // 决策 sink:把 autonomy 决策映射进既有 decision_traces 表(复用回合 trace sink 句柄)。
  // companion-live-wiring:文字路注入真候选源(未了话题 + idle 弧);语音模式已在 startVoiceMode 内
  // 用 VoiceLoop 真闸/抢占装配过 autonomy,故此处仅在**未进语音模式**时挂文字路 autonomy(避免双挂同一总线)。
  const autonomy: AutonomyHandle | undefined = voice
    ? undefined
    : assembleAutonomy(env, {
        bus,
        llm,
        decisionSink: new SqliteAutonomyDecisionSink({ sink: trace.sink }),
        ...(companionCandidateSource ? { candidateSource: companionCandidateSource } : {}),
      });
  // 夜间巩固触发(CHAT_A_CONSOLIDATION=on 才挂;会话结束 / /reset 触发,后台 fire-and-forget)。
  const consolidation: ConsolidationHandle | undefined = assembleConsolidation(env, {
    llm,
    store: mem.store,
  });
  // 巩固节奏触发驱动状态(companion-coherence-wiring,§5.1):进程内累计"距上次巩固轮数"+ 记"上次巩固时刻"。
  // 仅 consolidation 在场(CHAT_A_CONSOLIDATION=on)才计数/触发;off 时全不动(零行为变更)。
  // 两类触发各用独立幂等键:每 N 轮用递增 batchIndex,daily 用日期串(同窗口/同日不重复;run 内存在性检查再兜底)。
  let turnsSinceLast = 0;
  let lastConsolidatedAtMs: number | undefined = undefined;
  let consolidationBatch = 0;
  /** 每个用户回合后(非首字热路径)按轮数/日期驱动巩固;触发即重置窗口。失败仅告警,绝不阻塞热路径。 */
  const driveConsolidationCadence = async (): Promise<void> => {
    if (consolidation === undefined) return;
    turnsSinceLast += 1;
    const state = { turnsSinceLast, ...(lastConsolidatedAtMs !== undefined ? { lastConsolidatedAtMs } : {}) };
    const today = new Date().toISOString().slice(0, 10);
    // 单元同时承载两类触发的语义:轮数键含 batchIndex(每 N 轮一个新键)、日期串(同日只一次)。
    // maybeConsolidateByCadence 内 every-n-turns / daily 任一到阈值即触发;此处 unit 用轮数键 + 日期串复合,
    // 保证"换天"与"满 N 轮"都得到唯一幂等键。
    const unit = `cadence:${sessionId}:${today}:${consolidationBatch}`;
    const fired = await consolidation.maybeConsolidateByCadence(unit, state).catch(() => false);
    if (fired) {
      turnsSinceLast = 0;
      lastConsolidatedAtMs = Date.now();
      consolidationBatch += 1;
    }
  };
  // 主动状态:文字路有 autonomy handle 显示 tick;语音路 autonomy 在 startVoiceMode 内装配(显示 on(语音))。
  const autonomyStatus = autonomy
    ? `on(tick ${autonomy.tickMs}ms)`
    : voice && autonomyOn
      ? 'on(语音)'
      : 'off';
  stdout.write(
    `接线: 感知=${perception ? `on(tick ${perception.tickMs}ms)` : 'off'} | 主动=${autonomyStatus} | 巩固=${consolidation ? 'on' : 'off'}\n`,
  );

  stdout.write('\n');

  // ── 统一优雅收尾(EOF / Ctrl+C / /quit 共用;幂等,多次触发只跑一次) ──
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    // 语音模式收尾:停采集/loop/设备(幂等;无语音则 no-op)。
    voice?.stop();
    // 接线收尾:停感知中枢(停 tick/源)、停 autonomy 调度(停定时器 + 退订总线);均幂等、失败吞。
    // (语音模式的 autonomy 由 voice.stop() 负责;此处仅停文字路 autonomy。)
    try {
      autonomy?.stop();
    } catch {
      /* ignore */
    }
    // companion-live-wiring:退订在场刷新(幂等、失败吞);off / 无 presence 时为 no-op。
    try {
      unsubPresence?.();
    } catch {
      /* ignore */
    }
    await perception?.stop().catch(() => {});
    // 会话结束的夜间沉淀(§5/§6.1):在关库之前异步蒸馏一次;幂等 + 全程降级,失败吞掉不影响退出。
    await reflector.reflect(sessionId).catch(() => {});
    // 会话结束的夜间巩固触发(§5.1,默认关):后台幂等、失败仅告警,绝不阻塞退出。
    await consolidation?.consolidateSession(sessionId).catch(() => {});
    // cli 特有的决策 trace sink 收尾(共享层不持有它);失败吞。
    try {
      trace.sink.close();
    } catch {
      /* 同上 */
    }
    // 共享层收尾:关 memory store + 关 telemetry(幂等、失败吞)。在 reflect/巩固之后关库。
    await app.cleanup();
  };

  const rl = createInterface({ input: stdin, output: stdout });
  let closed = false;
  rl.on('close', () => {
    closed = true;
  });

  // Ctrl+C:打印告别 → 收尾 → 退出,不抛栈(§3.2 优雅退出)。
  // readline 默认把 SIGINT 转成 'SIGINT' 事件;我们接管它做优雅收尾。
  rl.on('SIGINT', () => {
    stdout.write('\n小雪: 先到这儿,下次见。\n');
    rl.close();
    void cleanup().then(() => process.exit(0));
  });

  rl.setPrompt('你 › ');
  rl.prompt();
  for await (const line of rl) {
    const parsed = parseCommand(line);
    switch (parsed.kind) {
      case 'empty':
        rl.prompt();
        continue;
      case 'quit':
        rl.close();
        continue; // 跳出循环由 rl.close 触发(下一次迭代结束)
      case 'help':
        stdout.write(renderHelp() + '\n\n');
        if (!closed) rl.prompt();
        continue;
      case 'persona':
        stdout.write(
          renderPersona({
            name: seed.name,
            identity: seed.identity,
            warmth: seed.dials.baselineWarmth,
            expressiveness: seed.dials.expressiveness,
            volatility: seed.dials.emotionalVolatility,
            assertiveness: seed.dials.assertiveness,
          }) + '\n\n',
        );
        if (!closed) rl.prompt();
        continue;
      case 'clear':
        // 清屏(ANSI);非 TTY(管道)下也无害。
        stdout.write('\x1b[2J\x1b[H');
        if (!closed) rl.prompt();
        continue;
      case 'reset': {
        // 换会话前:对旧会话触发夜间巩固(默认关;后台 fire-and-forget,不阻塞 REPL)。
        const endingSession = sessionId;
        void consolidation?.consolidateSession(endingSession).catch(() => {});
        sessionId = randomUUID().slice(0, 8);
        convo = makeConvo(sessionId);
        // 换会话即重置节奏计数(新 session 重新累计;daily 的上次时刻保留以跨会话维持每日间隔)。
        turnsSinceLast = 0;
        consolidationBatch = 0;
        stdout.write('(已开新一段对话,之前的上下文不再带入。长期记忆仍保留。)\n\n');
        if (!closed) rl.prompt();
        continue;
      }
      case 'unknown':
        stdout.write(`未知命令:${parsed.name}。输入 /help 查看可用命令。\n\n`);
        if (!closed) rl.prompt();
        continue;
      case 'chat': {
        // companion-live-wiring:用户开口即刷新在场(驱动 idle 情绪弧的 once-per-episode);off 时无 presence。
        presence?.markActive();
        stdout.write('小雪 › ');
        try {
          await convo.send(parsed.text, (token) => stdout.write(token));
        } catch (err) {
          // §3.2 永不崩永不哑:友好中文降级,会话继续。
          const detail = err instanceof Error ? err.message : String(err);
          stdout.write(`\n(小雪一时没接上话——可能是网络或模型出了点问题,稍后再试。)\n[${detail}]`);
        }
        stdout.write('\n\n');
        // 巩固节奏触发(§5.1,默认关):回复之后(非首字热路径)按轮数/日期驱动 daily/每 N 轮巩固;
        // 后台 fire-and-forget,失败仅告警,绝不阻塞 REPL。consolidation off 时为 no-op。
        void driveConsolidationCadence();
        if (!closed) rl.prompt();
        continue;
      }
    }
  }

  await cleanup();
}

await main();
