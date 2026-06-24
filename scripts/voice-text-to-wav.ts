/**
 * 「填 key 即测」100% key-only 路径(路径 A):**文本输入 → 云 LLM(qwen)→ 云 TTS(qwen-tts)→ WAV 文件**。
 *
 * 只需 `.env.local` 里填一行 `CHAT_A_DASHSCOPE_API_KEY=sk-...` + 网络即可跑(跳过 STT/麦克风,绝对可跑)。
 * 跑法:`pnpm test:voice`(或 `pnpm test:voice "你想对小雪说的话"`)。
 *
 * 产物:把小雪的回复合成成 `out.wav`(可改 `CHAT_A_AUDIO_OUT_WAV`),用任意播放器试听。
 *
 * 注:本脚本**需真网络 + 真 key**,默认不进 CI;无 key 时明确提示并退出 0。绝不打印 key。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process, { argv, cwd, env, stdout } from 'node:process';
import {
  createLlm,
  loadLlmConfig,
  createTts,
  loadTtsConfig,
  type PcmChunk,
} from '../packages/providers/src/index';
import { parseDotEnv, applyDotEnv } from '../packages/client/src/env-file';
import { encodeWavBuffer } from '../packages/client/src/audio/wav';

function loadEnvLocal(): void {
  try {
    applyDotEnv(parseDotEnv(readFileSync(join(cwd(), '.env.local'), 'utf8')), env);
  } catch {
    /* 文件缺失/读失败:静默,可能直接用进程环境变量 */
  }
}

async function main(): Promise<void> {
  loadEnvLocal();

  const key = env['CHAT_A_DASHSCOPE_API_KEY'] ?? env['CHAT_A_LLM_API_KEY'];
  if (key === undefined || key.length === 0) {
    stdout.write(
      '[test:voice] 跳过:未填 DashScope key。请在项目根 .env.local 写一行:\n' +
        '            CHAT_A_DASHSCOPE_API_KEY=sk-你的key\n' +
        '            然后重跑 `pnpm test:voice`。\n',
    );
    process.exit(0);
  }

  // 预设档:LLM=qwen / TTS=qwen-tts,key 统一回落 DashScope key(用户只填一个 key)。
  const presetEnv: NodeJS.ProcessEnv = {
    ...env,
    CHAT_A_LLM_PROVIDER: env['CHAT_A_LLM_PROVIDER'] ?? 'qwen',
    CHAT_A_LLM_MODEL: env['CHAT_A_LLM_MODEL'] ?? 'qwen-plus',
    CHAT_A_LLM_API_KEY: env['CHAT_A_LLM_API_KEY'] ?? key,
    CHAT_A_TTS_KIND: env['CHAT_A_TTS_KIND'] ?? 'qwen-tts',
    CHAT_A_TTS_MODEL: env['CHAT_A_TTS_MODEL'] ?? 'qwen3-tts-flash-realtime',
    CHAT_A_TTS_VOICE: env['CHAT_A_TTS_VOICE'] ?? 'Cherry',
  };

  const userText = argv.slice(2).join(' ').trim() || '你好小雪,简单介绍一下你自己。';
  const outPath = env['CHAT_A_AUDIO_OUT_WAV'] ?? join(cwd(), 'out.wav');

  stdout.write(`[test:voice] LLM=${presetEnv.CHAT_A_LLM_PROVIDER}/${presetEnv.CHAT_A_LLM_MODEL}  TTS=qwen-tts  输入="${userText}"\n`);

  // 1) 云 LLM 生成回复(用既有 OpenAiCompatLlm 经 qwen provider)。
  const llm = createLlm(loadLlmConfig(presetEnv));
  let reply = '';
  for await (const tok of llm.stream({ system: '你是小雪,一个温暖的语音陪伴。回答简短自然。', messages: [{ role: 'user', content: userText }] })) {
    reply += tok;
    stdout.write(tok);
  }
  stdout.write('\n');
  if (reply.trim().length === 0) reply = '嗯,我在的。';

  // 2) 云 TTS 合成 PCM(qwen-tts WS 流式)→ 累积。
  const tts = createTts(loadTtsConfig(presetEnv));
  const all: number[] = [];
  let sampleRate = 24_000;
  for await (const chunk of tts.synthesize(reply) as AsyncIterable<PcmChunk>) {
    sampleRate = chunk.sampleRate;
    for (const s of chunk.samples) all.push(s);
  }

  // 3) 编码成 WAV 落盘。
  const wav = encodeWavBuffer(Int16Array.from(all), sampleRate, 1);
  writeFileSync(outPath, wav);
  stdout.write(`[test:voice] 已写出 ${outPath}(${all.length} 样本 @ ${sampleRate}Hz);用任意播放器试听。\n`);
}

main().catch((err) => {
  stdout.write(`[test:voice] 失败:${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
