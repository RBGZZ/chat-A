import { describe, it, expect, vi } from 'vitest';
import { LightVoiceBus } from '@chat-a/runtime';
import { makeBusEvent } from '@chat-a/protocol';
import {
  IPC,
  deriveState,
  StateTracker,
  toMoodSummary,
  runSendTurn,
  probeVoice,
  runCloneVoice,
  upsertEnvLocal,
  CHAT_ERROR_TEXT,
  VOICE_UNAVAILABLE_REASON,
  clampDial,
  sanitizePersonaForm,
  type UiState,
  type VoiceCloneResult,
  // —— 代理B:主动消息纯逻辑 ——
  toProactiveMessage,
  isProactiveEnabled,
  type PersonaForm,
} from '../src/ipc-contract';

const cid = 's1/t1/0';

describe('deriveState 总线事件 → UI 四态(纯,确定性)', () => {
  it('turn:start→thinking,tts:first_audio→speaking,turn:end→idle', () => {
    expect(deriveState('idle', makeBusEvent('turn:start', { startedAtMs: 0 }, cid))).toBe('thinking');
    expect(deriveState('thinking', makeBusEvent('tts:first_audio', { atMs: 0 }, cid))).toBe('speaking');
    expect(deriveState('speaking', makeBusEvent('turn:end', { reason: 'completed', atMs: 0 }, cid))).toBe('idle');
  });

  it('vad:speech_start→listening;vad:speech_end 从 listening→thinking,否则保持', () => {
    expect(deriveState('idle', makeBusEvent('vad:speech_start', { atMs: 0 }, cid))).toBe('listening');
    expect(deriveState('listening', makeBusEvent('vad:speech_end', { atMs: 0 }, cid))).toBe('thinking');
    expect(deriveState('speaking', makeBusEvent('vad:speech_end', { atMs: 0 }, cid))).toBe('speaking');
  });

  it('无关事件保持当前态', () => {
    expect(deriveState('speaking', makeBusEvent('stt:final', { text: 'hi' }, cid))).toBe('speaking');
  });
});

describe('StateTracker 订阅总线驱动状态机', () => {
  it('喂事件序列推进态,仅变化时回调 onChange', () => {
    const bus = new LightVoiceBus();
    const tracker = new StateTracker();
    const seen: UiState[] = [];
    tracker.onChange((s) => seen.push(s));
    const off = tracker.start(bus);

    bus.emit(makeBusEvent('turn:start', { startedAtMs: 0 }, cid)); // → thinking
    bus.emit(makeBusEvent('tts:first_audio', { atMs: 1 }, cid)); // → speaking
    bus.emit(makeBusEvent('tts:first_audio', { atMs: 2 }, cid)); // 不变(已 speaking)→ 无回调
    bus.emit(makeBusEvent('turn:end', { reason: 'completed', atMs: 3 }, cid)); // → idle

    expect(seen).toEqual(['thinking', 'speaking', 'idle']);
    expect(tracker.state).toBe('idle');
    off();
  });
});

describe('toMoodSummary', () => {
  it('从 tone 摘要出 emotion + PAD', () => {
    const mood = toMoodSummary({ emotion: 'content', pad: { pleasure: 0.6, arousal: 0.3, dominance: 0.5 } });
    expect(mood).toEqual({ emotion: 'content', pleasure: 0.6, arousal: 0.3, dominance: 0.5 });
  });
});

describe('runSendTurn 回合编排(纯,可单测)', () => {
  it('流式 token 逐个 emit,resolve 后 emit reply,不 emit error', async () => {
    const emit = vi.fn();
    const send = async (_text: string, onToken: (t: string) => void): Promise<string> => {
      onToken('你');
      onToken('好');
      return '你好';
    };
    await runSendTurn({ send, emit }, '在吗');

    const calls = emit.mock.calls;
    expect(calls).toEqual([
      [IPC.token, '你'],
      [IPC.token, '好'],
      [IPC.reply, '你好'],
    ]);
    expect(emit).not.toHaveBeenCalledWith(IPC.error, expect.anything());
  });

  it('send 抛错 → emit error(友好文案),不 emit reply,不向上抛(绝不崩)', async () => {
    const emit = vi.fn();
    const send = async (): Promise<string> => {
      throw new Error('boom');
    };
    await expect(runSendTurn({ send, emit }, 'x')).resolves.toBeUndefined();

    expect(emit).toHaveBeenCalledWith(IPC.error, { text: CHAT_ERROR_TEXT, detail: 'boom' });
    expect(emit).not.toHaveBeenCalledWith(IPC.reply, expect.anything());
  });
});

describe('upsertEnvLocal(.env.local 键 upsert,纯)', () => {
  it('已存在键 → 原地替换值,保留其它行与注释', () => {
    const text = '# 配置\nCHAT_A_DASHSCOPE_API_KEY=sk-x\nCHAT_A_VOICE_ID=old\nCHAT_A_TTS_VOICE=Cherry\n';
    const out = upsertEnvLocal(text, 'CHAT_A_VOICE_ID', 'new-voice');
    expect(out).toContain('CHAT_A_VOICE_ID=new-voice');
    expect(out).not.toContain('CHAT_A_VOICE_ID=old');
    expect(out).toContain('# 配置');
    expect(out).toContain('CHAT_A_DASHSCOPE_API_KEY=sk-x');
    expect(out).toContain('CHAT_A_TTS_VOICE=Cherry');
  });

  it('不存在键 → 末尾追加一行', () => {
    const out = upsertEnvLocal('CHAT_A_TTS_VOICE=Cherry\n', 'CHAT_A_VOICE_ID', 'v1');
    expect(out).toContain('CHAT_A_TTS_VOICE=Cherry');
    expect(out.trimEnd().endsWith('CHAT_A_VOICE_ID=v1')).toBe(true);
  });

  it('空文本 → 直接产出键值行', () => {
    expect(upsertEnvLocal('', 'CHAT_A_VOICE_ID', 'v1')).toBe('CHAT_A_VOICE_ID=v1\n');
  });

  it('容忍 export 前缀与前导空白', () => {
    const out = upsertEnvLocal('  export CHAT_A_VOICE_ID=old\n', 'CHAT_A_VOICE_ID', 'new');
    expect(out).toBe('CHAT_A_VOICE_ID=new\n');
  });
});

describe('runCloneVoice 一键复刻编排(纯,可单测)', () => {
  it('成功 → persist 后 emit ok 结果(含 voiceId)', async () => {
    const emit = vi.fn();
    const persist = vi.fn();
    await runCloneVoice(
      { clone: async () => 'voice-abc', persist, emit },
      { path: '/x.wav' },
    );
    expect(persist).toHaveBeenCalledWith('voice-abc');
    const [ch, payload] = emit.mock.calls[0]!;
    expect(ch).toBe(IPC.voiceCloneResult);
    expect((payload as VoiceCloneResult).ok).toBe(true);
    expect((payload as VoiceCloneResult).voiceId).toBe('voice-abc');
  });

  it('clone 抛错 → emit 失败结果(友好中文),不向上抛、不 persist', async () => {
    const emit = vi.fn();
    const persist = vi.fn();
    await expect(
      runCloneVoice(
        { clone: async () => { throw new Error('音频太短'); }, persist, emit },
        { path: '/x.wav' },
      ),
    ).resolves.toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
    const payload = emit.mock.calls[0]![1] as VoiceCloneResult;
    expect(payload.ok).toBe(false);
    expect(payload.message).toContain('音频太短');
  });

  it('persist 抛错 → 仍 emit 成功(已拿 voiceId),文案附手动提示', async () => {
    const emit = vi.fn();
    await runCloneVoice(
      { clone: async () => 'voice-xyz', persist: () => { throw new Error('写盘失败'); }, emit },
      { bytes: new Uint8Array([1]), mime: 'audio/wav' },
    );
    const payload = emit.mock.calls[0]![1] as VoiceCloneResult;
    expect(payload.ok).toBe(true);
    expect(payload.voiceId).toBe('voice-xyz');
    expect(payload.message).toContain('写盘失败');
  });
});

describe('probeVoice naudiodon 探测降级(纯,可单测)', () => {
  it('init 成功 → available:true', async () => {
    const status = await probeVoice(() => ({ init: async () => undefined }));
    expect(status).toEqual({ available: true });
  });

  it('init 抛错(未装/未 rebuild)→ available:false + 中文原因,不抛', async () => {
    const status = await probeVoice(() => ({
      init: async () => {
        throw new Error('未能加载原生音频库 naudiodon');
      },
    }));
    expect(status.available).toBe(false);
    expect(status.reason).toBe(VOICE_UNAVAILABLE_REASON);
  });
});

// ═══════════════════════════════ 代理B:主动消息纯逻辑 ═══════════════════════════════
describe('toProactiveMessage 归一(纯,防空气泡)', () => {
  it('裁首尾空白,补 signalKind/preempted 缺省', () => {
    expect(toProactiveMessage({ text: '  在忙吗?  ' })).toEqual({
      text: '在忙吗?',
      signalKind: 'unknown',
      preempted: false,
    });
  });

  it('透传 signalKind 与 preempted', () => {
    expect(toProactiveMessage({ text: '等一下!', signalKind: 'temporal:idle-tick', preempted: true })).toEqual({
      text: '等一下!',
      signalKind: 'temporal:idle-tick',
      preempted: true,
    });
  });

  it('空白文本 → null(调用方不推空气泡)', () => {
    expect(toProactiveMessage({ text: '   ' })).toBeNull();
    expect(toProactiveMessage({ text: '' })).toBeNull();
  });

  // IPC 通道常量已注册(防散落字符串)。
  it('IPC.proactiveMessage 常量为 proactive:message', () => {
    expect(IPC.proactiveMessage).toBe('proactive:message');
  });
});

describe('isProactiveEnabled 开关解析(默认关、安全)', () => {
  it('CHAT_A_AUTONOMY=on(含大小写/空白)→ 启用;其余 → 关', () => {
    expect(isProactiveEnabled({ CHAT_A_AUTONOMY: 'on' })).toBe(true);
    expect(isProactiveEnabled({ CHAT_A_AUTONOMY: ' ON ' })).toBe(true);
    expect(isProactiveEnabled({})).toBe(false);
    expect(isProactiveEnabled({ CHAT_A_AUTONOMY: 'off' })).toBe(false);
    expect(isProactiveEnabled({ CHAT_A_AUTONOMY: '1' })).toBe(false);
  });
});

// —— 人格自定义(代理C) ——
describe('clampDial(单档夹取 [0,1],纯)', () => {
  it('区间内原样', () => {
    expect(clampDial(0.6, 0.5)).toBe(0.6);
    expect(clampDial(0, 0.5)).toBe(0);
    expect(clampDial(1, 0.5)).toBe(1);
  });
  it('超界夹取到边界', () => {
    expect(clampDial(1.5, 0.5)).toBe(1);
    expect(clampDial(-0.3, 0.5)).toBe(0);
  });
  it('非有限(NaN/Infinity)→ 回落 fallback', () => {
    expect(clampDial(Number.NaN, 0.42)).toBe(0.42);
    expect(clampDial(Number.POSITIVE_INFINITY, 0.7)).toBe(0.7);
  });
});

describe('sanitizePersonaForm(人格表单规整,纯)', () => {
  const fallback: PersonaForm = { name: '小雪', warmth: 0.6, expressiveness: 0.5, volatility: 0.5 };

  it('合法输入原样(名字 trim)', () => {
    expect(sanitizePersonaForm({ name: '  阿狸 ', warmth: 0.9, expressiveness: 0.2, volatility: 0.7 }, fallback)).toEqual({
      name: '阿狸',
      warmth: 0.9,
      expressiveness: 0.2,
      volatility: 0.7,
    });
  });

  it('三档超界夹取 [0,1]', () => {
    const out = sanitizePersonaForm({ name: 'x', warmth: 2, expressiveness: -1, volatility: 1.2 }, fallback);
    expect(out.warmth).toBe(1);
    expect(out.expressiveness).toBe(0);
    expect(out.volatility).toBe(1);
  });

  it('空白名字 / 缺省档 → 回落 fallback', () => {
    const out = sanitizePersonaForm({ name: '   ' }, fallback);
    expect(out).toEqual(fallback);
  });

  it('非数字档(NaN/非 number)→ 回落 fallback 对应档', () => {
    const out = sanitizePersonaForm(
      { name: '小冬', warmth: Number.NaN, expressiveness: undefined as unknown as number },
      fallback,
    );
    expect(out.name).toBe('小冬');
    expect(out.warmth).toBe(fallback.warmth);
    expect(out.expressiveness).toBe(fallback.expressiveness);
  });
});
