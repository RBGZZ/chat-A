/**
 * 真 STT 云端闭环 smoke 脚本 —— **需真网络 + 真 key,手动跑,默认不进 CI**。
 *
 * 闭环(roadmap 战线 1 / M1.1–M1.3):**WAV 音频 → 真云 STT(qwen3-asr-flash,带说话人情绪)
 * → 转写文本 + emotion → emotion 映射进人格 PAD 拉力**。这是「语音入」唯一未真机验证的一环。
 *
 * 作用:有 `CHAT_A_DASHSCOPE_API_KEY` 时,读取一段 WAV(默认仓库根 `out.wav`),按 qwen ASR 硬约定
 * 重采样到 16kHz/mono/s16le,经 `QwenAsrStt`(OpenAI 兼容 `/chat/completions`,input_audio Data URL)
 * 真网络转写,打印**转写文本 + 情绪标签(7 类之一)+ 检测语种**,并演示 `prosodyToPadPull` 把该情绪
 * 映射成 PAD 拉力(确定性纯函数,不触网)。无 key 时跳过并提示、以退出码 0 结束(**绝不打印 key**)。
 *
 * 跑法:
 *   pnpm smoke:asr                 # 默认读 out.wav
 *   pnpm smoke:asr path/to.wav     # 指定 WAV
 *   CHAT_A_STT_LANGUAGE=zh pnpm smoke:asr   # 限定语种(省略 = 自动检测)
 *
 * 注:`out.wav` / `qwen-smoke.wav` 是 TTS 产物(24kHz),本脚本会就地降采样到 16kHz——
 * qwen3-asr 要求 PCM16/16kHz/mono(见 docs/usability-roadmap §3.6)。
 */
import { readFileSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import process, { argv, cwd, env, stdout } from 'node:process';
import {
  createStt,
  loadSttConfig,
  pcmChunk,
  STT_SAMPLE_RATE_HZ,
  type PcmChunk,
  type SttResult,
} from '../packages/providers/src/index';
import { prosodyToPadPull, type SttEmotionLike } from '../packages/persona/src/index';
import { parseDotEnv, applyDotEnv } from '../packages/client/src/env-file';
import { decodeWav } from '../packages/client/src/audio/wav';

function loadEnvLocal(): void {
  try {
    applyDotEnv(parseDotEnv(readFileSync(join(cwd(), '.env.local'), 'utf8')), env);
  } catch {
    /* 文件缺失/读失败:静默,可能直接用进程环境变量 */
  }
}

/**
 * 线性插值降/重采样到目标采样率(单声道)。
 * qwen ASR 要 16kHz;测试 WAV 多为 24kHz TTS 产物,需重采样。无需追求高保真——
 * STT 对轻微重采样伪影鲁棒;线性插值足够把闭环跑通(roadmap 这步只验「转写 + 情绪」通路)。
 */
function resampleMonoLinear(samples: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return samples;
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(samples.length * ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = srcPos - i0;
    const s0 = samples[i0] ?? 0;
    const s1 = samples[i1] ?? 0;
    out[i] = Math.round(s0 + (s1 - s0) * frac);
  }
  return out;
}

/** 把多声道交错样本下混为单声道(取声道均值);channels=1 时原样返回。 */
function toMono(samples: Int16Array, channels: number): Int16Array {
  if (channels <= 1) return samples;
  const frames = Math.floor(samples.length / channels);
  const out = new Int16Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[f * channels + c] ?? 0;
    out[f] = Math.round(sum / channels);
  }
  return out;
}

/** 把单个 PcmChunk 包成 AsyncIterable(QwenAsrStt 批式聚合,整段上传)。 */
async function* singleChunk(chunk: PcmChunk): AsyncIterable<PcmChunk> {
  yield chunk;
}

async function main(): Promise<void> {
  loadEnvLocal();

  const key = env['CHAT_A_DASHSCOPE_API_KEY'] ?? env['CHAT_A_STT_API_KEY'];
  if (key === undefined || key.length === 0) {
    stdout.write(
      '[smoke:asr] 跳过(需真网络 + key):请在项目根 .env.local 写一行:\n' +
        '            CHAT_A_DASHSCOPE_API_KEY=sk-你的key\n' +
        '            然后重跑 `pnpm smoke:asr`。\n',
    );
    process.exit(0);
  }

  // 输入 WAV:命令行参数优先,否则默认 out.wav(test:voice 的产物)。
  const argPath = argv.slice(2).join(' ').trim();
  const wavPath = argPath
    ? isAbsolute(argPath)
      ? argPath
      : resolve(cwd(), argPath)
    : join(cwd(), 'out.wav');

  let wavBytes: Uint8Array;
  try {
    wavBytes = readFileSync(wavPath);
  } catch (err) {
    stdout.write(
      `[smoke:asr] 读不到 WAV "${wavPath}":${err instanceof Error ? err.message : String(err)}\n` +
        '            先跑 `pnpm test:voice` 生成 out.wav,或传入 `pnpm smoke:asr <文件>`。\n',
    );
    process.exit(1);
  }

  const decoded = decodeWav(wavBytes);
  const mono = toMono(decoded.samples, decoded.channels);
  const samples16k = resampleMonoLinear(mono, decoded.sampleRate, STT_SAMPLE_RATE_HZ);
  const chunk = pcmChunk(samples16k, STT_SAMPLE_RATE_HZ, 1);

  const durSec = (samples16k.length / STT_SAMPLE_RATE_HZ).toFixed(2);
  stdout.write(
    `[smoke:asr] 输入 ${wavPath}(${decoded.sampleRate}Hz/${decoded.channels}ch → ` +
      `${STT_SAMPLE_RATE_HZ}Hz/mono,${durSec}s)\n`,
  );

  // 预设档:CHAT_A_STT_KIND=qwen-asr → QwenAsrStt(/chat/completions,带 prosody 情绪)。
  // key 回落 DASHSCOPE;language 省略 = 自动检测(可用 CHAT_A_STT_LANGUAGE 覆盖)。
  const presetEnv: NodeJS.ProcessEnv = {
    ...env,
    CHAT_A_STT_KIND: 'qwen-asr',
    ...(env['CHAT_A_STT_MODEL'] ? {} : { CHAT_A_STT_MODEL: 'qwen3-asr-flash' }),
  };

  const sttCfg = loadSttConfig(presetEnv);
  stdout.write(
    `[smoke:asr] STT=${sttCfg.kind}/${'model' in sttCfg ? sttCfg.model : '?'}  ` +
      `语种=${'language' in sttCfg && sttCfg.language ? sttCfg.language : '自动检测'}  连接真云 qwen-asr…\n`,
  );

  const stt = createStt(sttCfg);
  const results: SttResult[] = [];
  for await (const r of stt.transcribe(singleChunk(chunk))) results.push(r);

  const final = results.find((r) => r.isFinal) ?? results[results.length - 1];
  if (final === undefined) {
    stdout.write('[smoke:asr] 警告:请求成功但无转写结果(检查音频内容 / 额度)。\n');
    process.exit(1);
  }

  stdout.write('\n==== 真 STT 云端闭环结果 ====\n');
  stdout.write(`转写文本 : ${final.text || '(空)'}\n`);
  stdout.write(`检测语种 : ${final.language ?? '(未回报)'}\n`);
  const emotion = final.emotion;
  stdout.write(`说话人情绪: ${emotion ? emotion.label : '(未回报 / neutral 不入表)'}`);
  if (emotion?.confidence !== undefined) stdout.write(`  (置信度 ${emotion.confidence})`);
  stdout.write('\n');

  // emotion → 人格 PAD 拉力(确定性纯函数,不触网):这是闭环的最后一跳,把「怎么说的」喂入情感内核。
  const emotionLike: SttEmotionLike | undefined = emotion
    ? { label: emotion.label, ...(emotion.confidence !== undefined ? { confidence: emotion.confidence } : {}) }
    : undefined;
  const pull = prosodyToPadPull(emotionLike);
  stdout.write(
    `→ PAD 拉力 : pleasure=${pull.pleasure}  arousal=${pull.arousal}  dominance=${pull.dominance}` +
      `${emotion ? '' : '  (无情绪 → 零拉力,安全降级)'}\n`,
  );
  stdout.write('=============================\n');
  stdout.write('[smoke:asr] OK:WAV → 真云 STT → 文本+情绪 → PAD 拉力 闭环跑通。\n');
}

main().catch((err) => {
  stdout.write(`[smoke:asr] 失败:${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
