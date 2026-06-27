/**
 * 临时排查脚本 —— 把「已知清晰音频」灌进 NodeAudioDevice 的真采集路,定位静音/损坏 bug。
 *
 * 测 A:量 16k 采集输出的 RMS/峰值,落盘 captured-16k.wav。
 * 测 B:把这段 16k 喂真 ASR,看是否还原。
 * 测 C:整段 resampleSinc(24k→16k)(不走逐帧 carry)喂真 ASR,作对照。
 *
 * 跑法:pnpm tsx scripts/capture-pipeline-probe.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import process, { cwd, env, stdout } from 'node:process';
import { NodeAudioDevice } from '../packages/client/src/audio/node-audio-device';
import { resampleSinc } from '../packages/client/src/audio/resample';
import { decodeWav, encodeWav } from '../packages/client/src/audio/wav';
import { parseDotEnv, applyDotEnv } from '../packages/client/src/env-file';
import type { PcmFrame } from '@chat-a/protocol';
import {
  createStt,
  loadSttConfig,
  pcmChunk,
  STT_SAMPLE_RATE_HZ,
  type PcmChunk,
  type SttResult,
} from '../packages/providers/src/index';

const SCRATCH = 'C:/Users/Administrator/AppData/Local/Temp/claude/D--chat-A/46e2b947-68bf-426d-b006-7549f053df4b/scratchpad';

function loadEnvLocal(): void {
  try {
    applyDotEnv(parseDotEnv(readFileSync(join(cwd(), '.env.local'), 'utf8')), env);
  } catch {
    /* ignore */
  }
}

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

/** 线性重采样(只用于把 24k 模拟成 48k 设备原生率,不是被测对象)。 */
function resampleLinear(samples: Int16Array, fromRate: number, toRate: number): Int16Array {
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

function int16ToBytes(samples: Int16Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i] ?? 0, i * 2);
  return buf;
}

function stats(samples: Int16Array): { rms: number; peak: number; n: number } {
  let sumsq = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    sumsq += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const rms = samples.length ? Math.sqrt(sumsq / samples.length) : 0;
  return { rms, peak, n: samples.length };
}

/** 假原生模块:把给定 48k s16le 字节按块回放给 'data' 回调。 */
function makeFakeModule(bytes: Buffer, chunkBytes: number) {
  return {
    AudioIO(_opts: unknown) {
      let dataCb: ((b: Buffer) => void) | null = null;
      return {
        on(event: string, cb: (...args: unknown[]) => void) {
          if (event === 'data') dataCb = cb as (b: Buffer) => void;
        },
        start() {
          if (!dataCb) return;
          for (let off = 0; off < bytes.length; off += chunkBytes) {
            dataCb(bytes.subarray(off, Math.min(off + chunkBytes, bytes.length)));
          }
        },
        quit() {},
      };
    },
  };
}

async function* singleChunk(chunk: PcmChunk): AsyncIterable<PcmChunk> {
  yield chunk;
}

async function transcribe(samples16k: Int16Array): Promise<SttResult | undefined> {
  const presetEnv: NodeJS.ProcessEnv = {
    ...env,
    CHAT_A_STT_KIND: 'qwen-asr',
    ...(env['CHAT_A_STT_MODEL'] ? {} : { CHAT_A_STT_MODEL: 'qwen3-asr-flash' }),
  };
  const sttCfg = loadSttConfig(presetEnv);
  const stt = createStt(sttCfg);
  const chunk = pcmChunk(samples16k, STT_SAMPLE_RATE_HZ, 1);
  const results: SttResult[] = [];
  for await (const r of stt.transcribe(singleChunk(chunk))) results.push(r);
  return results.find((r) => r.isFinal) ?? results[results.length - 1];
}

async function main(): Promise<void> {
  loadEnvLocal();
  mkdirSync(SCRATCH, { recursive: true });

  // 1. 读 out.wav(24k mono s16le)
  const wavPath = join(cwd(), 'out.wav');
  const decoded = decodeWav(readFileSync(wavPath));
  const mono24k = toMono(decoded.samples, decoded.channels);
  const s24 = stats(mono24k);
  stdout.write(
    `[src] out.wav: ${decoded.sampleRate}Hz/${decoded.channels}ch → mono ${s24.n} 样本, ` +
      `RMS=${s24.rms.toFixed(1)} peak=${s24.peak}\n`,
  );

  // 模拟内置 Intel 麦原生率:24k → 48k 线性升采样,得 s16le 字节流
  const sim48k = resampleLinear(mono24k, decoded.sampleRate, 48000);
  const s48 = stats(sim48k);
  stdout.write(`[src] 模拟 48k 设备流: ${s48.n} 样本, RMS=${s48.rms.toFixed(1)} peak=${s48.peak}\n`);
  const bytes48k = int16ToBytes(sim48k);

  // 2. 假模块注入 NodeAudioDevice,deviceCaptureRate=48000 → captureSampleRate=16000
  const device = new NodeAudioDevice({ deviceCaptureRate: 48000, captureSampleRate: 16000 });
  // 设备原生流通常一次回调 ~几十ms;naudiodon framesPerBuffer 常见。用 1920 字节(=480样本=10ms@48k)模拟最坏切片;
  // 也试更大块更接近真实(下面用 1920 与 7680 各测一次)。
  const chunkBytesList = [1920, 7680];

  for (const cb of chunkBytesList) {
    await device.initWithModule(makeFakeModule(bytes48k, cb));
    const frames: PcmFrame[] = [];
    const stop = device.captureStart((f) => frames.push(f));
    stop();
    // 拼接所有 16k 帧
    let total = 0;
    for (const f of frames) total += f.samples.length;
    const captured = new Int16Array(total);
    let p = 0;
    for (const f of frames) {
      captured.set(f.samples, p);
      p += f.samples.length;
    }
    const sc = stats(captured);
    stdout.write(
      `\n[capture chunkBytes=${cb}] 帧数=${frames.length} 总样本=${sc.n} ` +
        `(${(sc.n / 16000).toFixed(2)}s) RMS=${sc.rms.toFixed(1)} peak=${sc.peak} ` +
        `帧sampleRate=${frames[0]?.sampleRate}\n`,
    );
    if (cb === 1920) {
      const outPath = join(SCRATCH, 'captured-16k.wav');
      writeFileSync(outPath, Buffer.from(encodeWav(captured, 16000, 1)));
      stdout.write(`[capture] 落盘: ${outPath}\n`);
      (globalThis as Record<string, unknown>)['__capturedB'] = captured;
    }
  }

  // 测 D:模拟「未按名选中麦 → deviceCaptureRate 缺省=16000 → 不重采样」,但设备实际吐 48k 字节。
  //   = 真机一种可能的误配:48k 字节被当 16k 解释(3x 过快/错位 → 乱码/静音幻觉)。
  {
    const deviceD = new NodeAudioDevice({ captureSampleRate: 16000 }); // deviceCaptureRate 缺省=16000
    await deviceD.initWithModule(makeFakeModule(bytes48k, 1920));
    const framesD: PcmFrame[] = [];
    const stopD = deviceD.captureStart((f) => framesD.push(f));
    stopD();
    let totalD = 0;
    for (const f of framesD) totalD += f.samples.length;
    const capturedD = new Int16Array(totalD);
    let pd = 0;
    for (const f of framesD) {
      capturedD.set(f.samples, pd);
      pd += f.samples.length;
    }
    const scD = stats(capturedD);
    stdout.write(
      `\n[D 误配:48k字节当16k解释] 样本=${scD.n} (标称${(scD.n / 16000).toFixed(2)}s) ` +
        `RMS=${scD.rms.toFixed(1)} peak=${scD.peak}\n`,
    );
    writeFileSync(join(SCRATCH, 'misconfig-D-16k.wav'), Buffer.from(encodeWav(capturedD, 16000, 1)));
    (globalThis as Record<string, unknown>)['__capturedD'] = capturedD;
  }

  // 测 C 对照:整段一次 resampleSinc(24k→16k),不走逐帧 carry
  const wholeC = resampleSinc(mono24k, decoded.sampleRate, 16000);
  const scC = stats(wholeC);
  stdout.write(
    `\n[C 整段resampleSinc] 样本=${scC.n} (${(scC.n / 16000).toFixed(2)}s) ` +
      `RMS=${scC.rms.toFixed(1)} peak=${scC.peak}\n`,
  );
  writeFileSync(join(SCRATCH, 'whole-C-16k.wav'), Buffer.from(encodeWav(wholeC, 16000, 1)));

  // ASR
  const hasKey = (env['CHAT_A_DASHSCOPE_API_KEY'] ?? env['CHAT_A_STT_API_KEY'] ?? '').length > 0;
  if (!hasKey) {
    stdout.write('\n[ASR] 无 key,跳过转写(只给电平数据)。\n');
    return;
  }

  const capturedB = (globalThis as Record<string, unknown>)['__capturedB'] as Int16Array;
  stdout.write('\n[ASR] 测 B(逐帧 carry 采集路 16k)转写中…\n');
  const rB = await transcribe(capturedB);
  stdout.write(`[ASR][B] 文本: ${rB?.text || '(空)'}  语种=${rB?.language ?? '?'} 情绪=${rB?.emotion?.label ?? '-'}\n`);

  stdout.write('[ASR] 测 C(整段 resampleSinc 16k)转写中…\n');
  const rC = await transcribe(wholeC);
  stdout.write(`[ASR][C] 文本: ${rC?.text || '(空)'}  语种=${rC?.language ?? '?'} 情绪=${rC?.emotion?.label ?? '-'}\n`);

  const capturedD = (globalThis as Record<string, unknown>)['__capturedD'] as Int16Array;
  stdout.write('[ASR] 测 D(48k字节当16k误配)转写中…\n');
  const rD = await transcribe(capturedD);
  stdout.write(`[ASR][D] 文本: ${rD?.text || '(空)'}  语种=${rD?.language ?? '?'} 情绪=${rD?.emotion?.label ?? '-'}\n`);
}

main().catch((err) => {
  stdout.write(`[probe] 失败: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
