import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { LightVoiceBus } from '@chat-a/runtime';
import { loadVoiceProfile, type TtsOptions } from '@chat-a/providers';
import { startVoiceMode, loadEchoGuardConfig } from '../src/cli-voice';

/** 假 sherpa 夹具的 file:// URL(动态 import 可解析的真实模块,导出顶层 infer)。 */
const FAKE_SHERPA_URL = pathToFileURL(
  fileURLToPath(new URL('./fixtures/fake-sherpa.mjs', import.meta.url)),
).href;

// ───────────────────────────── 夹具 ─────────────────────────────
// 验「按 env 选真/桩 + 真路径加载失败回落桩不崩 + info 标识」。
// 真路径经 CHAT_A_SHERPA_MODULE 指向一个不存在的模块名 → 动态 import 抛 → 回落桩(headless 无原生库)。

const baseDeps = () => ({
  send: async (_t: string, onToken: (s: string) => void) => {
    onToken('收到。');
    return '收到。';
  },
  memory: { appendMessage: vi.fn() },
  bus: new LightVoiceBus(),
  sessionId: 'voice-1',
});

describe('client/startVoiceMode 按 env 选真/桩 VAD·EOU', () => {
  it('缺省(不设 CHAT_A_VAD)→ 走桩,info 标识 stub', async () => {
    const env: NodeJS.ProcessEnv = { CHAT_A_AUDIO_DEVICE: 'fake' };
    const handle = await startVoiceMode({ ...baseDeps(), env });
    expect(handle.info.vad).toBe('stub');
    expect(handle.info.eou).toBe('stub');
    handle.stop();
  });

  it('CHAT_A_VAD=silero 但真模块缺失 → 回落桩,不崩,info 标识 stub', async () => {
    // 指向不存在的模块名 → createSherpa*Session 动态 import 抛 → 装配层 catch 回落桩。
    const env: NodeJS.ProcessEnv = {
      CHAT_A_AUDIO_DEVICE: 'fake',
      CHAT_A_VAD: 'silero',
      CHAT_A_SHERPA_MODULE: 'definitely-not-installed-sherpa-xyz',
    };
    const handle = await startVoiceMode({ ...baseDeps(), env });
    // 真路径失败 → 回落桩;info 反映实际(桩)。
    expect(handle.info.vad).toBe('stub');
    expect(handle.info.eou).toBe('stub');
    handle.stop(); // 不崩即通过
  });

  it('CHAT_A_VAD=silero + 真模块可加载(假 sherpa 夹具)→ 注入真适配器,info 标识 silero', async () => {
    const env: NodeJS.ProcessEnv = {
      CHAT_A_AUDIO_DEVICE: 'fake',
      CHAT_A_VAD: 'silero',
      CHAT_A_SHERPA_MODULE: FAKE_SHERPA_URL, // 真实可 import 的模块(file://),导出顶层 infer
    };
    const handle = await startVoiceMode({ ...baseDeps(), env });
    expect(handle.info.vad).toBe('silero');
    expect(handle.info.eou).toBe('silero');
    handle.stop();
  });
});

describe('client/startVoiceMode 按 CHAT_A_VOICE_PATH 选 STT/omni 语音路径(§4 双路径)', () => {
  it('缺省(不设 CHAT_A_VOICE_PATH)→ 走 STT,info.path=stt', async () => {
    const env: NodeJS.ProcessEnv = { CHAT_A_AUDIO_DEVICE: 'fake' };
    const handle = await startVoiceMode({ ...baseDeps(), env });
    expect(handle.info.path).toBe('stt');
    handle.stop();
  });

  it('CHAT_A_VOICE_PATH=omni 但缺 key → 回落 STT,不崩,info.path=stt', async () => {
    const env: NodeJS.ProcessEnv = {
      CHAT_A_AUDIO_DEVICE: 'fake',
      CHAT_A_VOICE_PATH: 'omni', // 无 CHAT_A_DASHSCOPE_API_KEY → createOmniAudioPort 返回 undefined
    };
    const handle = await startVoiceMode({ ...baseDeps(), env });
    expect(handle.info.path).toBe('stt'); // 回落 STT(端口缺失)
    handle.stop(); // 不崩即通过
  });

  it('CHAT_A_VOICE_PATH=omni + key 就绪 → 构造 omni 端口(惰性,不触网),info.path=omni', async () => {
    const env: NodeJS.ProcessEnv = {
      CHAT_A_AUDIO_DEVICE: 'fake',
      CHAT_A_VOICE_PATH: 'omni',
      CHAT_A_DASHSCOPE_API_KEY: 'sk-test-omni', // 仅构造,不连(QwenOmniLlm 惰性建连)
    };
    const handle = await startVoiceMode({ ...baseDeps(), env });
    expect(handle.info.path).toBe('omni');
    handle.stop();
  });
});

// ───────────────────────────── EchoGuard 默认开(§4 自打断防护)─────────────────────────────

describe('client/loadEchoGuardConfig:语音模式默认开,CHAT_A_ECHO_GUARD=off 关', () => {
  it('缺省(不设 CHAT_A_ECHO_GUARD)→ 默认开启(enabled:true)', () => {
    const cfg = loadEchoGuardConfig({});
    expect(cfg).toBeDefined();
    expect(cfg?.enabled).toBe(true);
  });

  it('缺省 → confirmFrames=3(真去抖,≈30ms 连续高置信才打断,压单帧回声/噪声误打断)', () => {
    // barge-in-polish:装配层去抖默认从库默认 1 提升到 3(库默认仍 1=回归硬线)。
    expect(loadEchoGuardConfig({})?.confirmFrames).toBe(3);
  });

  it('CHAT_A_ECHO_GUARD=off → 不注入(undefined,回落逐字现状)', () => {
    expect(loadEchoGuardConfig({ CHAT_A_ECHO_GUARD: 'off' })).toBeUndefined();
    expect(loadEchoGuardConfig({ CHAT_A_ECHO_GUARD: 'false' })).toBeUndefined();
    expect(loadEchoGuardConfig({ CHAT_A_ECHO_GUARD: '0' })).toBeUndefined();
    expect(loadEchoGuardConfig({ CHAT_A_ECHO_GUARD: 'no' })).toBeUndefined();
    expect(loadEchoGuardConfig({ CHAT_A_ECHO_GUARD: 'disabled' })).toBeUndefined();
  });

  it('其它非关闭值(如 on)→ 仍默认开启且去抖(confirmFrames=3)', () => {
    const cfg = loadEchoGuardConfig({ CHAT_A_ECHO_GUARD: 'on' });
    expect(cfg?.enabled).toBe(true);
    expect(cfg?.confirmFrames).toBe(3);
  });
});

describe('client/startVoiceMode:info.echoGuard 反映默认开/env 关', () => {
  it('缺省 → info.echoGuard=on(语音模式默认启用自打断防护)', async () => {
    const env: NodeJS.ProcessEnv = { CHAT_A_AUDIO_DEVICE: 'fake' };
    const handle = await startVoiceMode({ ...baseDeps(), env });
    expect(handle.info.echoGuard).toBe('on');
    handle.stop();
  });

  it('CHAT_A_ECHO_GUARD=off → info.echoGuard=off(显式关闭回落现状)', async () => {
    const env: NodeJS.ProcessEnv = { CHAT_A_AUDIO_DEVICE: 'fake', CHAT_A_ECHO_GUARD: 'off' };
    const handle = await startVoiceMode({ ...baseDeps(), env });
    expect(handle.info.echoGuard).toBe('off');
    handle.stop();
  });
});

// ───────────────────────────── 音色复刻闭环:CHAT_A_VOICE_ID → ttsOptions.voiceId ─────────────────────────────
// 复刻把 voiceId 写进 CHAT_A_VOICE_ID;装配层(cli/desktop)经 loadVoiceProfile 读出拼成 ttsOptions.voiceId
// 注入 startVoiceMode → VoiceLoop #speak → tts.synthesize(opts.voiceId)。synthesize 收到 voiceId 由
// runtime/voice-io-decoupling.test.ts 钉死,此处钉「CHAT_A_VOICE_ID → ttsOptions.voiceId」这一公共转换契约。

describe('client/音色复刻闭环:CHAT_A_VOICE_ID 经 loadVoiceProfile 拼进 ttsOptions.voiceId', () => {
  /** 复用 cli/desktop 同一转换:profile → 合成 opts(仅有键时带键)。 */
  function buildTtsOptions(env: NodeJS.ProcessEnv): TtsOptions | undefined {
    const p = loadVoiceProfile(env);
    if (p.outputLang === undefined && p.voiceId === undefined && p.cloneRef === undefined) return undefined;
    return {
      ...(p.outputLang !== undefined ? { language: p.outputLang } : {}),
      ...(p.voiceId !== undefined ? { voiceId: p.voiceId } : {}),
    };
  }

  it('设了 CHAT_A_VOICE_ID → ttsOptions.voiceId 为该值(复刻音色被合成读取)', () => {
    const opts = buildTtsOptions({ CHAT_A_VOICE_ID: 'voice-cloned-abc' });
    expect(opts?.voiceId).toBe('voice-cloned-abc');
  });

  it('未设 CHAT_A_VOICE_ID 等键 → ttsOptions=undefined(用 provider 默认音色,逐字现状)', () => {
    expect(buildTtsOptions({})).toBeUndefined();
  });
});
