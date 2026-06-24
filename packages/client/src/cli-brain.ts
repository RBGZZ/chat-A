/**
 * 大脑侧进程入口(runtime-assembly-wiring,承 §1/§2 B 方案):本地双进程手测的「大脑」。
 *
 * 用法(双进程免提连续对话手测):
 *   1. 终端 A(大脑):`CHAT_A_TRANSPORT=websocket pnpm --filter @chat-a/client brain`
 *      (或根 `pnpm dev:brain`)——起 WebSocketServer 监听 `CHAT_A_GATEWAY_PORT`(默认 8787)。
 *   2. 终端 B(瘦终端):`CHAT_A_VOICE=1 CHAT_A_TRANSPORT=websocket pnpm dev`
 *      ——经 `CHAT_A_GATEWAY_URL`(默认 ws://127.0.0.1:8787)连大脑;麦克风/扬声器在终端,
 *      STT/TTS/VAD/EOU/VoiceLoop 在大脑。
 *
 * 每条连接装配一套 STT/TTS/VAD/EOU + `Conversation.send` 闭包 + 新 bus 喂给 VoiceLoop;
 * STT/TTS 经 `createStt/createTts`(缺省 Fake),VAD/EOU 经 `createDetectors`(缺省桩,真路径回落)。
 * 真模型/真硬件由各 env 切换,本入口零改 VoiceLoop(实现同接口即换,§3.1)。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process, { stdout, env, cwd } from 'node:process';
import { Conversation, LightVoiceBus } from '@chat-a/runtime';
import { createLlm, loadLlmConfig, createStt, loadSttConfig, createTts, loadTtsConfig } from '@chat-a/providers';
import { createMemoryStoreFromEnv } from '@chat-a/memory';
import { loadPersonaFromEnv, createKvPersonaStore } from '@chat-a/persona';
import { createDetectors } from './cli-voice';
import { startBrainServer, loadGatewayPort, type BrainLoopFactoryDeps } from './audio/brain-server';
import { parseDotEnv, applyDotEnv } from './env-file';

function loadEnvLocal(): void {
  try {
    applyDotEnv(parseDotEnv(readFileSync(join(cwd(), '.env.local'), 'utf8')), env);
  } catch {
    /* 缺文件/读失败静默(§3.2) */
  }
}

async function main(): Promise<void> {
  loadEnvLocal();

  const port = loadGatewayPort(env);
  const cfg = loadLlmConfig();
  const llm = createLlm(cfg);
  const mem = createMemoryStoreFromEnv();
  const persona = loadPersonaFromEnv();
  const personaStore = createKvPersonaStore(mem.store);

  // 端点检测进程级预建(detectors 装配是 async,且无连接级状态,可进程共用);
  // STT/TTS/send/bus/session 仍**每连接新建**(独立会话上下文)。
  // startBrainServer 的 loopDepsFor 是同步契约,故 detectors 必须在此先 await 好。
  const sharedDetectors = await createDetectors(env);
  const loopDepsFor = (connectionId: string): BrainLoopFactoryDeps => {
    const sessionId = `${connectionId}-${randomUUID().slice(0, 4)}`;
    const bus = new LightVoiceBus();
    const convo = new Conversation({
      bus,
      llm,
      memory: mem.store,
      personaSeed: persona.seed,
      personaStore,
      sessionId,
    });
    return {
      vad: sharedDetectors.vad,
      turnDetector: sharedDetectors.turnDetector,
      stt: createStt(loadSttConfig(env)),
      tts: createTts(loadTtsConfig(env)),
      send: (text, onToken) => convo.send(text, onToken),
      memory: mem.store,
      sessionId,
    };
  };

  const server = startBrainServer({ port, loopDepsFor });
  stdout.write(
    `大脑侧已启动:ws://127.0.0.1:${port}(LLM=${cfg.provider}/${cfg.model},STT/TTS/VAD/EOU 在大脑侧)\n` +
      `终端连接:CHAT_A_VOICE=1 CHAT_A_TRANSPORT=websocket pnpm dev\n`,
  );

  const shutdown = (): void => {
    stdout.write('\n大脑侧收尾…\n');
    try {
      server.stop();
    } catch {
      /* ignore */
    }
    try {
      mem.store.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
