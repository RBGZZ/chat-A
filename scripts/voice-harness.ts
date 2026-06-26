/**
 * 语音管线开发 harness —— **不经 Electron、不经 naudiodon**,在纯 node 跑同一个 VoiceLoop。
 *
 * 动机(2026-06-27):桌面 Electron 把可恢复的 native 音频错误放大成段错误冻死、且日志块缓冲藏真因;
 * CLI/node 下同一管线失败是干净可捕获的错误、trace 直出、tsx 改完即跑不用重建。
 *
 * 做什么:合成「语音能量段→静音」16k 帧喂 WAV 设备 → assembleApp + startVoiceMode(与桌面同一装配)
 * → VAD→端点→STT→LLM→TTS 整条管线跑一遍 → `[vtrace]` 实时打印每步判定 → 回合结束自动退出 + 打印摘要。
 *
 * 跑法:
 *   pnpm voice:harness                 # 合成帧 + fake STT + 真 LLM/TTS(.env.local),确定性、快
 *   CHAT_A_STT_KIND=qwen-asr pnpm voice:harness --wav speech16k.wav   # 真 STT 跑真 16k 语音 WAV(集成)
 *   CHAT_A_LLM_PROVIDER=fake CHAT_A_TTS_KIND=fake pnpm voice:harness   # 全 fake,离线/秒级
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import process, { argv, cwd, env, stdout } from 'node:process';
import { assembleApp, startVoiceMode, type VoiceModeHandle } from '../packages/client/src/index';
import { encodeWavBuffer, decodeWav } from '../packages/client/src/audio/wav';
import { resampleSinc } from '../packages/client/src/audio/resample';
import { loadVoiceProfile, type TtsOptions } from '../packages/providers/src/index';

const SR = 16000;

/** 合成「0.4s 220Hz 有声(过 VAD)→ 2s 静音(触发端点)」16k mono s16le,写临时 WAV,返回路径。 */
function synthInputWav(): string {
  const voiced = Math.floor(SR * 0.4);
  const silence = Math.floor(SR * 2.0);
  const samples = new Int16Array(voiced + silence);
  for (let i = 0; i < voiced; i++) samples[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / SR) * 9000);
  const wav = encodeWavBuffer(samples, SR, 1);
  const path = join(tmpdir(), 'voice-harness-in.wav');
  writeFileSync(path, wav);
  return path;
}

/** 读任意采样率/声道的 WAV → 下混单声道 → 抗混叠重采样到 16k → 写临时 16k WAV(WAV 设备要 16k mono)。 */
function prepareWav(path: string): string {
  const dec = decodeWav(readFileSync(path));
  let s = dec.samples;
  if (dec.channels === 2) {
    const mono = new Int16Array(Math.floor(s.length / 2));
    for (let i = 0; i < mono.length; i++) mono[i] = s[2 * i] ?? 0;
    s = mono;
  }
  if (dec.sampleRate !== SR) s = resampleSinc(s, dec.sampleRate, SR);
  const out = join(tmpdir(), 'voice-harness-real16k.wav');
  writeFileSync(out, encodeWavBuffer(s, SR, 1));
  stdout.write(`[harness] --wav ${path}: ${dec.channels}ch@${dec.sampleRate}Hz → 16k mono(${s.length} 样本)\n`);
  return out;
}

/** 与桌面 buildVoiceTtsOptions 同口径:loadVoiceProfile → ttsOptions(voiceId/语种/复刻),供真 TTS 用。 */
function buildTtsOptions(): TtsOptions | undefined {
  const p = loadVoiceProfile(env);
  if (p.outputLang === undefined && p.voiceId === undefined && p.cloneRef === undefined) return undefined;
  return {
    ...(p.outputLang !== undefined ? { language: p.outputLang } : {}),
    ...(p.voiceId !== undefined ? { voiceId: p.voiceId } : {}),
    ...(p.cloneRef !== undefined
      ? { refAudio: { source: p.cloneRef.source, ...(p.cloneRef.refText !== undefined ? { refText: p.cloneRef.refText } : {}), ...(p.cloneRef.refLang !== undefined ? { refLang: p.cloneRef.refLang } : {}) } }
      : {}),
  };
}

async function main(): Promise<void> {
  const liveMic = argv.includes('--mic');
  const wavArg = argv.includes('--wav') ? argv[argv.indexOf('--wav') + 1] : undefined;

  // 公共固定档:无 Electron;避开 better-sqlite3 ABI125;trace 直出。
  env['CHAT_A_VOICE_TRACE'] ??= '1';
  env['CHAT_A_VOICE_TRACE_DB'] = ''; // 只要 stdout [vtrace];不落库(避开 better-sqlite3 ABI125)
  env['CHAT_A_SQLITE_BACKEND'] = ''; // 任何 sqlite 走 node:sqlite(node24 内建),不强制 better-sqlite3
  env['CHAT_A_MEMORY_BACKEND'] = 'memory'; // 避开 better-sqlite3(Electron ABI125,node 加载不了)

  let inWav = '';
  if (liveMic) {
    // 🎤 真麦模式:naudiodon 实时麦(**须为 node ABI137 重编**)。STT/TTS/VOICE_PATH/设备名全用 .env.local
    // (stt-stream/qwen-asr/cosyvoice/输入输出设备);本机 WASAPI 渲染失败在 node 下是优雅错误非段错误。
    env['CHAT_A_AUDIO_DEVICE'] = 'node';
    // naudiodon 是 desktop 的依赖、不是 client 的 → ESM 裸名 'naudiodon' 解析不到;从 desktop 包位置解析真实
    // 入口、以 file:// URL 经 CHAT_A_AUDIO_MODULE 传入(node-audio-device 动态 import 之)。须先为 node 重编 naudiodon。
    try {
      const req = createRequire(pathToFileURL(join(cwd(), 'packages/desktop/package.json')).href);
      env['CHAT_A_AUDIO_MODULE'] = pathToFileURL(req.resolve('naudiodon')).href;
    } catch (e) {
      stdout.write(`[harness] ⚠️ 解析 naudiodon 失败(将回落 Fake):${e instanceof Error ? e.message : String(e)}\n`);
    }
  } else {
    // 确定性 WAV/合成帧路:无 naudiodon,默认 fake STT/TTS + 真 LLM。
    inWav = wavArg ? prepareWav(wavArg) : synthInputWav();
    env['CHAT_A_AUDIO_DEVICE'] = 'wav';
    env['CHAT_A_AUDIO_IN_WAV'] = inWav;
    env['CHAT_A_AUDIO_OUT_WAV'] = join(tmpdir(), 'voice-harness-out.wav');
    env['CHAT_A_STT_KIND'] ??= 'fake';
    env['CHAT_A_TTS_KIND'] ??= 'fake';
    env['CHAT_A_VOICE_PATH'] ??= 'stt';
  }

  const handle = assembleApp(); // 读 .env.local(LLM/TTS 等真 provider),env 覆盖优先
  stdout.write(
    `[harness] mode=${liveMic ? 'mic' : 'wav'} llm=${handle.llm.id}/${handle.llm.model} stt=${env['CHAT_A_STT_KIND'] ?? '(env)'} path=${env['CHAT_A_VOICE_PATH'] ?? '(env)'} ${inWav ? 'in=' + inWav : ''}\n`,
  );

  let reply = '';
  const t0 = Date.now();
  // 回合收尾信号:conversation.send 完成时 emit turn:end。
  const done = new Promise<void>((resolve) => {
    handle.bus.on('turn:end', (e) => {
      stdout.write(`[harness] turn:end reason=${(e.data as { reason?: string }).reason} @${Date.now() - t0}ms\n`);
      resolve();
    });
  });

  let voice: VoiceModeHandle | undefined;
  const timer = setTimeout(() => stdout.write(`[harness] ⏱ 40s 超时(回合未收尾)\n`), 40000);
  try {
    voice = await startVoiceMode({
      send: (t, onToken, signal, prosody) => handle.convo.send(t, (tok) => { reply += tok; return onToken(tok); }, signal, prosody),
      composeOmniInstructions: () => handle.convo.composeOmniInstructions(),
      advanceProsody: (em) => handle.convo.advanceProsody(em),
      memory: handle.memory,
      bus: handle.bus,
      sessionId: handle.sessionId,
      env,
      ...(buildTtsOptions() ? { ttsOptions: buildTtsOptions()! } : {}), // 真 TTS 用 voiceId/语种;fake 时忽略
    });
    stdout.write(`[harness] 已启动 info=${JSON.stringify(voice.info)}\n`);
    if (liveMic) {
      stdout.write('[harness] 🎤 真麦模式:对麦说话,小雪会回复(听 TTS + 看 [vtrace]);Ctrl+C 退出。\n');
      process.on('SIGINT', () => { try { voice?.stop(); } catch { /* */ } process.exit(0); });
      await new Promise(() => {}); // 持续监听,直到 Ctrl+C(多回合)
    } else {
      await done;
      await new Promise((r) => setTimeout(r, 1500)); // 等 TTS 出尽
      stdout.write(`[harness] ✅ 完整管线跑通 @${Date.now() - t0}ms  小雪回复="${reply.slice(0, 80)}"\n`);
    }
  } catch (err) {
    stdout.write(`[harness] ❌ 抛错 @${Date.now() - t0}ms: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    try { voice?.stop(); } catch { /* ignore */ }
  }
  process.exit(process.exitCode ?? 0);
}

void main();
