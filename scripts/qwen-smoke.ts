/**
 * Qwen WS 连通性 smoke 脚本 —— **需真网络 + 真 key,手动跑,默认不进 CI**。
 *
 * 作用:有 `CHAT_A_DASHSCOPE_API_KEY` 时真连 `qwen-tts`(真 WebSocket 握手 + 收 PCM),
 * 合成一句存成 WAV,帮用户确认 key/网络通;无 key 时跳过并提示、以退出码 0 结束(绝不打印 key)。
 *
 * 跑法:`pnpm smoke:qwen`(或 `tsx scripts/qwen-smoke.ts`)。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process, { cwd, env, stdout } from 'node:process';
import { createTts, loadTtsConfig, type PcmChunk } from '../packages/providers/src/index';
import { parseDotEnv, applyDotEnv } from '../packages/client/src/env-file';
import { encodeWavBuffer } from '../packages/client/src/audio/wav';

function loadEnvLocal(): void {
  try {
    applyDotEnv(parseDotEnv(readFileSync(join(cwd(), '.env.local'), 'utf8')), env);
  } catch {
    /* 静默 */
  }
}

async function main(): Promise<void> {
  loadEnvLocal();

  const key = env['CHAT_A_DASHSCOPE_API_KEY'];
  if (key === undefined || key.length === 0) {
    stdout.write('[smoke:qwen] 跳过(需真网络 + key):请在 .env.local 填 CHAT_A_DASHSCOPE_API_KEY 后重跑。\n');
    process.exit(0);
  }

  const presetEnv: NodeJS.ProcessEnv = {
    ...env,
    CHAT_A_TTS_KIND: 'qwen-tts',
    CHAT_A_TTS_MODEL: env['CHAT_A_TTS_MODEL'] ?? 'qwen3-tts-flash-realtime',
    CHAT_A_TTS_VOICE: env['CHAT_A_TTS_VOICE'] ?? 'Cherry',
  };

  stdout.write('[smoke:qwen] 连接 qwen-tts(真 WebSocket)…\n');
  const tts = createTts(loadTtsConfig(presetEnv));
  const all: number[] = [];
  let sampleRate = 24_000;
  let chunks = 0;
  for await (const chunk of tts.synthesize('你好,这是一次连通性测试。') as AsyncIterable<PcmChunk>) {
    sampleRate = chunk.sampleRate;
    chunks++;
    for (const s of chunk.samples) all.push(s);
  }

  if (all.length === 0) {
    stdout.write('[smoke:qwen] 警告:握手成功但未收到音频(检查模型 id / 音色 / 额度)。\n');
    process.exit(1);
  }

  const outPath = join(cwd(), 'qwen-smoke.wav');
  writeFileSync(outPath, encodeWavBuffer(Int16Array.from(all), sampleRate, 1));
  stdout.write(`[smoke:qwen] OK:收到 ${chunks} 个 PCM 块,${all.length} 样本 @ ${sampleRate}Hz;已存 ${outPath}。\n`);
}

main().catch((err) => {
  stdout.write(`[smoke:qwen] 失败:${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
