import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { stdin, stdout, env, argv } from 'node:process';
import { Conversation, LightVoiceBus, ToolCallingStrategy } from '@chat-a/runtime';
import { buildDefaultRegistry } from '@chat-a/interaction';
import { createLlm, loadLlmConfig, createEmbedder, loadEmbedderConfig } from '@chat-a/providers';
import { initTelemetry, createDecisionTraceSinkFromEnv } from '@chat-a/observability';
import { createMemoryStoreFromEnv, LlmMemoryExtractor, LlmReflector, NoopReflector } from '@chat-a/memory';
import type { Reflector } from '@chat-a/memory';
import { loadPersonaFromEnv, seedPersonaMemories, createKvPersonaStore, LlmAppraiser, LlmStanceDetector, LlmOceanEvolver, LlmSelfNotionEvolver } from '@chat-a/persona';
import { startVoiceMode, type VoiceModeHandle } from './cli-voice';

/**
 * chat-A 文字版 MVP REPL(瘦客户端的文字形态,承 §9)。
 * 用 node:readline 异步迭代行;stdin EOF 时优雅退出(便于非交互冒烟)。
 */
async function main(): Promise<void> {
  const cfg = loadLlmConfig();
  const llm = createLlm(cfg);
  const bus = new LightVoiceBus();
  // 记忆按配置装配(默认 SQLite 真相源,跨重启记得;CHAT_A_MEMORY_BACKEND=memory 可退回内存)。
  const mem = createMemoryStoreFromEnv();
  // PersonaCard 装配(§6.2,card-as-config):卡优先、env 覆盖;PAD 状态复用记忆 SQLite KV(跨重启续接)。
  const persona = loadPersonaFromEnv();
  const seed = persona.seed;
  const personaStore = createKvPersonaStore(mem.store);
  // 种子化:角色背景/故事 → subject=agent 可召回 lore(不进骨架);多条用户画像 → subject=person 主用户。
  // CHAT_A_USER_PROFILE 单行画像并入(向后兼容)。全部经去重幂等,重复启动不新建(§5.8)。
  const seeded = seedPersonaMemories(mem.store, persona, env['CHAT_A_USER_PROFILE']);
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
  // 回合策略(§3.3/§12.2 Agent loop,默认单趟):CHAT_A_STRATEGY=tools 启用本地动作工具循环
  // (Provider 不支持工具/空注册表时自动降级回单趟)。
  const actionRegistry = buildDefaultRegistry();
  const useTools = (env['CHAT_A_STRATEGY'] ?? 'single').toLowerCase() === 'tools';
  const strategy = useTools ? new ToolCallingStrategy({ registry: actionRegistry }) : undefined;
  // 会话沉淀(§5/§6.1 Reflection,默认关):CHAT_A_REFLECTION=llm 用 LLM 在会话结束蒸馏高层记忆+第一人称自传。
  // sessionId 在此生成并贯穿 Conversation 与退出收尾的 reflect,保证沉淀只针对本会话消息。
  const sessionId = randomUUID().slice(0, 8);
  const reflectMode = (env['CHAT_A_REFLECTION'] ?? 'off').toLowerCase();
  const reflector: Reflector =
    reflectMode === 'llm' ? new LlmReflector({ provider: llm, store: mem.store }) : new NoopReflector();
  // 语义召回(c2b,§5.5/§5.7b,默认关):设 CHAT_A_EMBEDDER 才启用——query 异步嵌入(非阻塞)+
  // recallHybrid(关键词+向量加权归一)+ 回合收尾后台写侧嵌入。缺省=纯关键词召回,零额外开销。
  const embedderMode = (env['CHAT_A_EMBEDDER'] ?? '').trim();
  const embedder = embedderMode.length > 0 ? createEmbedder(loadEmbedderConfig(env)) : undefined;
  const convo = new Conversation({
    bus,
    llm,
    memory: mem.store,
    personaSeed: seed,
    personaStore,
    traceSink: trace.sink,
    sessionId,
    ...(appraiser ? { appraiser } : {}),
    ...(memoryExtractor ? { memoryExtractor } : {}),
    ...(stanceDetector ? { stanceDetector } : {}),
    ...(oceanEvolver ? { oceanEvolver } : {}),
    ...(selfNotionEvolver ? { selfNotionEvolver } : {}),
    ...(strategy ? { strategy } : {}),
    ...(embedder ? { embedder } : {}),
  });

  // OTel 追踪骨架(§8.1):默认不开以免刷屏;设 CHAT_A_TRACE=1 打开控制台 span 树。
  const traceOn = (env['CHAT_A_TRACE'] ?? '').length > 0;
  const telemetry = traceOn ? initTelemetry({ console: true }) : undefined;

  stdout.write(`chat-A · 文字版 MVP  [provider=${cfg.provider} model=${cfg.model}]\n`);
  stdout.write(`记忆: ${mem.backend}${mem.dbPath ? ` (${mem.dbPath})` : ''}\n`);
  stdout.write(`人格: ${seed.name}  [暖=${seed.dials.baselineWarmth} 外显=${seed.dials.expressiveness} 波动=${seed.dials.emotionalVolatility}]\n`);
  stdout.write(`来源: ${personaSource}${personaEnvOverride ? ' + env 覆盖' : ''}  lore=${seeded.lore} 画像=${seeded.userProfile} 观点=${seeded.selfNotions}\n`);
  stdout.write(`认知: appraiser=${appraiser ? 'llm' : 'default'}  记忆抽取=${memoryExtractor ? 'llm' : 'off'}\n`);
  stdout.write(`立场: 分歧检测=${stanceDetector ? 'llm' : 'default'}  敢顶嘴(assertiveness)=${seed.dials.assertiveness}\n`);
  stdout.write(`决策trace: ${trace.enabled ? `on (${trace.dbPath})` : 'off'}\n`);
  stdout.write(`语义召回: ${embedder ? `on (${embedder.id}, dim=${embedder.dimension})` : 'off (纯关键词)'}\n`);
  stdout.write(`沉淀: ${reflectMode === 'llm' ? 'llm (会话结束蒸馏)' : 'off'}  人格演化: ${oceanEvolver ? 'llm (每N轮)' : 'off'}  立场演化: ${selfNotionEvolver ? 'llm' : 'off'}\n`);
  stdout.write(`策略: ${useTools ? `tools (Agent loop, 动作=${actionRegistry.size})` : 'single (单趟)'}\n`);
  if (traceOn) stdout.write('(OTel trace 已开:每回合在控制台输出 turn→llm span。)\n');
  if (cfg.provider === 'fake') {
    stdout.write('(未检测到 ANTHROPIC_API_KEY → FakeLLM 占位。设 ANTHROPIC_API_KEY 用真 Claude;\n');
    stdout.write(' 或用 CHAT_A_LLM_PROVIDER / CHAT_A_LLM_MODEL 自选模型。)\n');
  }
  // 语音模式(R2,默认关):`--voice` 或 CHAT_A_VOICE=1 切语音;文字模式默认不变。
  // 装配 AudioDevice(真/Fake)→ InProcessAudioTransport → VoiceLoop;send 注入 convo.send(零改 Conversation)。
  const voiceOn = argv.includes('--voice') || (env['CHAT_A_VOICE'] ?? '').length > 0;
  let voice: VoiceModeHandle | undefined;
  if (voiceOn) {
    try {
      voice = await startVoiceMode({
        send: convo.send.bind(convo),
        memory: mem.store,
        bus,
        sessionId,
        env,
      });
      stdout.write(`语音: on  设备=${voice.info.device}  STT=${voice.info.stt}  TTS=${voice.info.tts}\n`);
    } catch (err) {
      stdout.write(`语音: 启动失败(回落纯文字):${err instanceof Error ? err.message : String(err)}\n`);
    }
  } else {
    stdout.write('语音: off (--voice 或 CHAT_A_VOICE=1 启用)\n');
  }
  stdout.write('和小雪打字对话,Ctrl+C 退出。\n\n');

  const rl = createInterface({ input: stdin, output: stdout });
  let closed = false;
  rl.on('close', () => {
    closed = true;
  });
  rl.setPrompt('你 › ');
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (text.length === 0) {
      rl.prompt();
      continue;
    }
    stdout.write('小雪 › ');
    try {
      await convo.send(text, (token) => stdout.write(token));
    } catch (err) {
      stdout.write(`\n[出错: ${err instanceof Error ? err.message : String(err)}]`);
    }
    stdout.write('\n\n');
    if (!closed) rl.prompt();
  }

  // 语音模式收尾:停采集/loop/设备(幂等;无语音则 no-op)。
  voice?.stop();
  // 会话结束的夜间沉淀(§5/§6.1):在关库之前异步蒸馏一次;幂等 + 全程降级,失败吞掉不影响退出。
  await reflector.reflect(sessionId).catch(() => {});
  mem.store.close();
  trace.sink.close();
  await telemetry?.shutdown();
}

await main();
