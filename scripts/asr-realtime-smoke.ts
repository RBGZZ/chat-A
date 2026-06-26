/**
 * realtime 流式 ASR 连通 smoke(手动跑,不进 CI):建 WS + 喂 out.wav(降16k) + 打印 partial/final,
 * 确认账号能用 qwen3-asr-flash-realtime(排雷:日期快照/邀测/端点)。无 key 跳过退出 0,绝不打印 key。
 *
 * 跑法:
 *   pnpm smoke:asr-rt                 # 默认读仓库根 out.wav(24k TTS 产物)
 *   pnpm smoke:asr-rt path/to.wav     # 指定 WAV
 *
 * 端点/模型可经环境变量覆盖排雷:
 *   CHAT_A_STT_REALTIME_MODEL=...     # 缺省 qwen3-asr-flash-realtime
 *   CHAT_A_STT_REALTIME_BASE_URL=...  # 缺省 wss://dashscope.aliyuncs.com/api-ws/v1/realtime
 *
 * 本脚本注入一个**诊断版 wsFactory**:除转发 provider 用到的 open/message/error/close 外,
 * 额外打印 WS close 的 code/reason(provider 默认吞掉),便于鉴权/邀测/端点错的完整记录。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import process, { argv, cwd, env, stdout } from 'node:process';
import {
  DEFAULT_QWEN_ASR_REALTIME_MODEL,
  QWEN_ASR_REALTIME_URL,
  QwenAsrRealtimeStt,
  pcmChunk,
  type RealtimeWsFactory,
  type RealtimeWsLike,
} from '../packages/providers/src/index';
import { applyDotEnv, parseDotEnv } from '../packages/client/src/env-file';
import { decodeWav } from '../packages/client/src/audio/wav';

function loadEnvLocal(): void {
  try {
    applyDotEnv(parseDotEnv(readFileSync(join(cwd(), '.env.local'), 'utf8')), env);
  } catch {
    /* 文件缺失:静默,可能直接用进程环境变量 */
  }
}

/** 线性插值重采样到 16k(单声道);抄 scripts/asr-smoke.ts 的 resampleMonoLinear,smoke 用够了。 */
function resample16k(samples: Int16Array, from: number): Int16Array {
  if (from === 16000) return samples;
  const ratio = 16000 / from;
  const out = new Int16Array(Math.max(1, Math.round(samples.length * ratio)));
  for (let i = 0; i < out.length; i++) {
    const p = i / ratio;
    const i0 = Math.floor(p);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const s0 = samples[i0] ?? 0;
    const s1 = samples[i1] ?? 0;
    out[i] = Math.round(s0 + (s1 - s0) * (p - i0));
  }
  return out;
}

/** 多声道交错下混为单声道。 */
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

/** 诊断版 wsFactory:真 `ws` 包 + 额外打印 close code/reason(provider 默认吞)。 */
const diagWsFactory: RealtimeWsFactory = (url, opts) => {
  const req = createRequire(import.meta.url);
  const WS = req('ws') as new (
    u: string,
    o?: { headers?: Record<string, string> },
  ) => RealtimeWsLike & {
    on(event: 'close', cb: (code?: number, reason?: unknown) => void): void;
  };
  const ws = new WS(url, { headers: opts.headers });
  ws.on('close', (code?: number, reason?: unknown) => {
    const reasonStr =
      reason instanceof Uint8Array ? new TextDecoder().decode(reason) : String(reason ?? '');
    stdout.write(`  [ws close] code=${code ?? '?'} reason=${reasonStr || '(空)'}\n`);
  });
  return ws;
};

async function main(): Promise<void> {
  loadEnvLocal();
  const key = env['CHAT_A_DASHSCOPE_API_KEY'] ?? env['CHAT_A_STT_API_KEY'];
  if (key === undefined || key.length === 0) {
    stdout.write('[smoke:asr-rt] 跳过:未填 CHAT_A_DASHSCOPE_API_KEY。\n');
    return;
  }

  const arg = (argv[2] ?? 'out.wav').trim();
  const wavPath = isAbsolute(arg) ? arg : resolve(cwd(), arg);
  let wavBytes: Uint8Array;
  try {
    wavBytes = readFileSync(wavPath);
  } catch (err) {
    stdout.write(
      `[smoke:asr-rt] 读不到 WAV "${wavPath}":${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const decoded = decodeWav(wavBytes);
  const mono = toMono(decoded.samples, decoded.channels);
  const pcm16 = resample16k(mono, decoded.sampleRate);
  const model = env['CHAT_A_STT_REALTIME_MODEL'] ?? DEFAULT_QWEN_ASR_REALTIME_MODEL;
  const baseURL = env['CHAT_A_STT_REALTIME_BASE_URL'] ?? QWEN_ASR_REALTIME_URL;
  stdout.write(
    `[smoke:asr-rt] ${wavPath} ${decoded.sampleRate}Hz/${decoded.channels}ch→16k/mono, ` +
      `${(pcm16.length / 16000).toFixed(2)}s\n` +
      `[smoke:asr-rt] model=${model} 端点=${baseURL}\n`,
  );

  const stt = new QwenAsrRealtimeStt({
    id: 'qwen-asr-rt',
    model,
    apiKey: key,
    baseURL,
    wsFactory: diagWsFactory,
  });

  await new Promise<void>((done) => {
    let finals = 0;
    let partials = 0;
    const session = stt.openSession({
      onSpeechStarted: () => stdout.write('  [speech_started]\n'),
      onPartial: (t) => {
        partials++;
        stdout.write(`  partial: ${t}\n`);
      },
      onFinal: (t, e, l) => {
        finals++;
        stdout.write(`  FINAL: ${t}  emotion=${e?.label ?? '(无)'} lang=${l ?? '(无)'}\n`);
      },
      onError: (err) =>
        stdout.write(
          `  [error] ${err instanceof Error ? err.message : JSON.stringify(err)}\n`,
        ),
    });

    // 分 ~100ms(1600 样本)一包推;推完留 2s 收尾再关。
    let off = 0;
    const tick = setInterval(() => {
      if (off >= pcm16.length) {
        clearInterval(tick);
        setTimeout(() => {
          session.close();
          stdout.write(
            `[smoke:asr-rt] 完成,共 ${partials} 句 partial / ${finals} 句 final\n`,
          );
          done();
        }, 2000);
        return;
      }
      session.pushAudio(pcmChunk(pcm16.subarray(off, off + 1600), 16000));
      off += 1600;
    }, 100);
  });
}

await main();
