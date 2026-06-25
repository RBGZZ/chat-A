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
  toMemoryItems,
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
  type MemoryRecordLike,
  // —— 三语种控制 + 朗读(本批次) ——
  normalizeLangCode,
  normalizeTtsLang,
  resolveEffectiveTtsLang,
  resolveSpokenPlan,
  buildTranslateSystemPrompt,
  translateForSpeech,
  runSpeakReply,
  runStreamSpeakReply,
  makeTokenStreamReadout,
  isSpeakAvailable,
  TTS_LANG_FOLLOW,
  type TtsAudioChunk,
  type SentenceFeed,
  type SpeakStreamSession,
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

describe('toMemoryItems 记忆面板格式化(纯,可单测)(代理D)', () => {
  it('映射分层为中文标签 + 透传时间 + 夹取并保留两位重要度', () => {
    const recs: MemoryRecordLike[] = [
      { text: '用户喜欢咖啡', memoryKind: 'semantic', importance: 0.5, createdAtMs: 10, lastSeenAtMs: 20 },
      { text: '用户对花生过敏', memoryKind: 'core', importance: 0.987, createdAtMs: 5, lastSeenAtMs: 30 },
      { text: '某天聊到猫', memoryKind: 'episodic', importance: 0.123, createdAtMs: 1, lastSeenAtMs: 2 },
    ];
    const items = toMemoryItems(recs);
    expect(items.map((i) => i.kindLabel)).toEqual(['事实', '核心', '情景']);
    expect(items[0]?.text).toBe('用户喜欢咖啡');
    expect(items[0]?.lastSeenAtMs).toBe(20);
    expect(items[0]?.createdAtMs).toBe(10);
    // 保留两位:0.987→0.99、0.123→0.12。
    expect(items[1]?.importance).toBe(0.99);
    expect(items[2]?.importance).toBe(0.12);
  });

  it('缺省/未知分层兜底为「情景」,缺省重要度为 0,越界夹到 [0,1]', () => {
    const items = toMemoryItems([
      { text: '无分层无重要度', createdAtMs: 1, lastSeenAtMs: 1 },
      { text: '超界重要度', importance: 1.5, createdAtMs: 2, lastSeenAtMs: 2 },
      { text: '负重要度', importance: -0.3, createdAtMs: 3, lastSeenAtMs: 3 },
    ]);
    expect(items[0]?.kindLabel).toBe('情景');
    expect(items[0]?.importance).toBe(0);
    expect(items[1]?.importance).toBe(1);
    expect(items[2]?.importance).toBe(0);
  });

  it('空数组 → 空数组(不崩)', () => {
    expect(toMemoryItems([])).toEqual([]);
  });
});

// ═══════════════════════════════ 三语种控制 + 朗读(本批次) ═══════════════════════════════
describe('normalizeLangCode / normalizeTtsLang(语种码规整,纯)', () => {
  it('空/auto → 自动空串;trim 保留具体码', () => {
    expect(normalizeLangCode('')).toBe('');
    expect(normalizeLangCode('  ')).toBe('');
    expect(normalizeLangCode('auto')).toBe('');
    expect(normalizeLangCode('AUTO')).toBe('');
    expect(normalizeLangCode('  zh ')).toBe('zh');
    expect(normalizeLangCode(undefined)).toBe('');
  });

  it('ttsLang 空 → follow(默认跟随);follow 大小写不敏感;具体码经规整', () => {
    expect(normalizeTtsLang('')).toBe(TTS_LANG_FOLLOW);
    expect(normalizeTtsLang(undefined)).toBe(TTS_LANG_FOLLOW);
    expect(normalizeTtsLang('Follow')).toBe(TTS_LANG_FOLLOW);
    expect(normalizeTtsLang('en')).toBe('en');
    expect(normalizeTtsLang('auto')).toBe(''); // 用户显式 auto → 自动
  });
});

describe('resolveEffectiveTtsLang(实际合成语种,纯)', () => {
  it('follow/空 → 跟随显示语种', () => {
    expect(resolveEffectiveTtsLang('zh', 'follow')).toBe('zh');
    expect(resolveEffectiveTtsLang('ja', '')).toBe('ja');
    expect(resolveEffectiveTtsLang('', 'follow')).toBe(''); // 显示自动 → 合成也自动
  });
  it('具体 ttsLang → 用该值,不跟随显示', () => {
    expect(resolveEffectiveTtsLang('zh', 'en')).toBe('en');
    expect(resolveEffectiveTtsLang('', 'ja')).toBe('ja');
  });
});

describe('resolveSpokenPlan(显示/合成解耦 golden 钉死四分支,纯)', () => {
  it('跟随:ttsLang=follow → effective=display,不翻译', () => {
    expect(resolveSpokenPlan('zh', 'follow')).toEqual({ ttsLang: 'zh', needsTranslation: false });
  });
  it('相同:effective == display → 不翻译', () => {
    expect(resolveSpokenPlan('en', 'en')).toEqual({ ttsLang: 'en', needsTranslation: false });
  });
  it('不同:effective 具体且 ≠ display → 翻译', () => {
    expect(resolveSpokenPlan('zh', 'en')).toEqual({ ttsLang: 'en', needsTranslation: true });
  });
  it('display 为空(自动)但 ttsLang 具体 → 翻译(无法假定显示语种)', () => {
    expect(resolveSpokenPlan('', 'ja')).toEqual({ ttsLang: 'ja', needsTranslation: true });
  });
  it('自动:effective 为空 → 不翻译、不发 language', () => {
    expect(resolveSpokenPlan('', 'follow')).toEqual({ ttsLang: '', needsTranslation: false });
    expect(resolveSpokenPlan('', '')).toEqual({ ttsLang: '', needsTranslation: false });
  });
});

describe('buildTranslateSystemPrompt / translateForSpeech(翻译通道,纯+mock LLM)', () => {
  it('提示含目标语言中文名 + 只输出译文约束', () => {
    const p = buildTranslateSystemPrompt('en');
    expect(p).toContain('英文');
    expect(p).toContain('只输出译文');
  });

  it('成功 → 返回 trim 后译文', async () => {
    const complete = vi.fn(async () => '  Hello there.  ');
    const out = await translateForSpeech({ complete }, '你好呀', 'en');
    expect(out).toBe('Hello there.');
    expect(complete).toHaveBeenCalledOnce();
  });

  it('翻译抛错 → 降级返回原文(有声优先、不崩)', async () => {
    const out = await translateForSpeech(
      { complete: async () => { throw new Error('网络'); } },
      '你好呀',
      'en',
    );
    expect(out).toBe('你好呀');
  });

  it('译文空白 → 降级返回原文', async () => {
    const out = await translateForSpeech({ complete: async () => '   ' }, '你好呀', 'en');
    expect(out).toBe('你好呀');
  });
});

describe('runSpeakReply(朗读编排:解耦+分句+逐块+取消,纯)', () => {
  const splitSentences = (t: string): string[] => t.split(/(?<=[。!?])/).filter((s) => s.length > 0);
  const fakeSynth = (sentence: string, ttsLang: string): AsyncIterable<TtsAudioChunk> => ({
    async *[Symbol.asyncIterator]() {
      yield { pcm: new Int16Array([sentence.length, ttsLang.length]), sampleRate: 24000 };
    },
  });

  it('同语种(不翻译)→ 直接合成显示 reply,逐句逐块 emitAudio', async () => {
    const emitted: TtsAudioChunk[] = [];
    const translate = vi.fn(async (t: string) => t);
    const spoken = await runSpeakReply(
      {
        splitSentences,
        synthesize: fakeSynth,
        translate,
        emitAudio: (c) => emitted.push(c),
      },
      '你好。再见。',
      'zh',
      'follow',
      new AbortController().signal,
    );
    expect(translate).not.toHaveBeenCalled(); // 不翻译
    expect(spoken).toBe('你好。再见。');
    expect(emitted.length).toBe(2); // 两句各一块
    expect(emitted[0]?.sampleRate).toBe(24000);
  });

  it('不同语种 → 先 translate 得 spokenText,再合成译文', async () => {
    const emitted: TtsAudioChunk[] = [];
    const translate = vi.fn(async () => 'Hi!');
    const spoken = await runSpeakReply(
      { splitSentences, synthesize: fakeSynth, translate, emitAudio: (c) => emitted.push(c) },
      '你好!',
      'zh',
      'en',
      new AbortController().signal,
    );
    expect(translate).toHaveBeenCalledWith('你好!', 'en');
    expect(spoken).toBe('Hi!');
    expect(emitted.length).toBe(1);
  });

  it('已 abort → 不合成(被打断/回合切换)', async () => {
    const emitted: TtsAudioChunk[] = [];
    const ac = new AbortController();
    ac.abort();
    await runSpeakReply(
      { splitSentences, synthesize: fakeSynth, translate: async (t) => t, emitAudio: (c) => emitted.push(c) },
      '你好。再见。',
      'zh',
      'follow',
      ac.signal,
    );
    expect(emitted.length).toBe(0);
  });

  it('单句合成抛错 → 跳过该句继续后续(有声尽力,不崩)', async () => {
    const emitted: TtsAudioChunk[] = [];
    let i = 0;
    const synth = (s: string): AsyncIterable<TtsAudioChunk> => ({
      async *[Symbol.asyncIterator]() {
        if (i++ === 0) throw new Error('第一句合成失败');
        yield { pcm: new Int16Array([s.length]), sampleRate: 24000 };
      },
    });
    await runSpeakReply(
      { splitSentences, synthesize: synth, translate: async (t) => t, emitAudio: (c) => emitted.push(c) },
      '甲。乙。',
      'zh',
      'follow',
      new AbortController().signal,
    );
    expect(emitted.length).toBe(1); // 第一句失败,第二句成功
  });
});

describe('runStreamSpeakReply(同会话流式喂:整段后句切,纯)', () => {
  // 简单句切器:遇 。!? 切句,残余 flush。
  const newSplitter = (): SentenceFeed => {
    let buf = '';
    return {
      push(text: string): string[] {
        buf += text;
        const out: string[] = [];
        for (;;) {
          const m = buf.search(/[。!?]/);
          if (m < 0) break;
          out.push(buf.slice(0, m + 1));
          buf = buf.slice(m + 1);
        }
        return out;
      },
      flush(): string | null {
        const t = buf.trim();
        buf = '';
        return t.length > 0 ? t : null;
      },
    };
  };

  /** 记录式假会话:记 push 的句子,chunks 按句各产一块。 */
  function fakeSession(): SpeakStreamSession & { pushed: string[]; finished: boolean; aborted: boolean } {
    const pushed: string[] = [];
    const s = {
      pushed,
      finished: false,
      aborted: false,
      push(t: string): void {
        pushed.push(t);
      },
      finish(): void {
        s.finished = true;
      },
      abort(): void {
        s.aborted = true;
      },
      get chunks(): AsyncIterable<TtsAudioChunk> {
        return {
          async *[Symbol.asyncIterator]() {
            for (const sentence of pushed) {
              yield { pcm: new Int16Array([sentence.length]), sampleRate: 24000 };
            }
          },
        };
      },
    };
    return s;
  }

  it('同语种:整段句切成多句 push 进同一会话 + finish,逐块 emit', async () => {
    const emitted: TtsAudioChunk[] = [];
    const session = fakeSession();
    const spoken = await runStreamSpeakReply(
      {
        newSplitter,
        openSession: () => session,
        translate: async (t) => t,
        emitAudio: (c) => emitted.push(c),
      },
      '你好。再见!',
      'zh',
      'follow',
      new AbortController().signal,
    );
    expect(spoken).toBe('你好。再见!');
    expect(session.pushed).toEqual(['你好。', '再见!']); // 同一会话两句
    expect(session.finished).toBe(true);
    expect(emitted.length).toBe(2);
  });

  it('不同语种:先 translate 得整段译文,再句切流式喂', async () => {
    const emitted: TtsAudioChunk[] = [];
    const session = fakeSession();
    const translate = vi.fn(async () => 'Hello! Bye!');
    const spoken = await runStreamSpeakReply(
      { newSplitter, openSession: () => session, translate, emitAudio: (c) => emitted.push(c) },
      '你好!',
      'zh',
      'en',
      new AbortController().signal,
    );
    expect(translate).toHaveBeenCalledWith('你好!', 'en');
    expect(spoken).toBe('Hello! Bye!');
    expect(session.pushed).toEqual(['Hello!', ' Bye!']);
  });

  it('已 abort → 不开会话合成', async () => {
    const emitted: TtsAudioChunk[] = [];
    const ac = new AbortController();
    ac.abort();
    let opened = false;
    await runStreamSpeakReply(
      {
        newSplitter,
        openSession: () => {
          opened = true;
          return fakeSession();
        },
        translate: async (t) => t,
        emitAudio: (c) => emitted.push(c),
      },
      '你好。',
      'zh',
      'follow',
      ac.signal,
    );
    expect(opened).toBe(false);
    expect(emitted.length).toBe(0);
  });

  it('流式抛错 → session.abort + 抛 stream-readout-failed(上层据此降级整段)', async () => {
    const session = fakeSession();
    const errSession: SpeakStreamSession = {
      push: session.push,
      finish: session.finish,
      abort: () => {
        session.aborted = true;
      },
      get chunks(): AsyncIterable<TtsAudioChunk> {
        return {
          async *[Symbol.asyncIterator]() {
            throw new Error('task-failed');
            yield { pcm: new Int16Array([0]), sampleRate: 24000 };
          },
        };
      },
    };
    await expect(
      runStreamSpeakReply(
        { newSplitter, openSession: () => errSession, translate: async (t) => t, emitAudio: () => {} },
        '你好。',
        'zh',
        'follow',
        new AbortController().signal,
      ),
    ).rejects.toThrow(/stream-readout-failed/);
    expect(session.aborted).toBe(true);
  });
});

describe('makeTokenStreamReadout(边生成边喂同会话:同语种解 R7,纯)', () => {
  const newSplitter = (): SentenceFeed => {
    let buf = '';
    return {
      push(text: string): string[] {
        buf += text;
        const out: string[] = [];
        for (;;) {
          const m = buf.search(/[。!?]/);
          if (m < 0) break;
          out.push(buf.slice(0, m + 1));
          buf = buf.slice(m + 1);
        }
        return out;
      },
      flush(): string | null {
        const t = buf.trim();
        buf = '';
        return t.length > 0 ? t : null;
      },
    };
  };

  function liveSession() {
    const pushed: string[] = [];
    let resolveNext: (() => void) | undefined;
    const waiters: Array<() => void> = [];
    let finished = false;
    const session = {
      pushed,
      aborted: false,
      push(t: string): void {
        pushed.push(t);
        const w = waiters.shift();
        if (w) w();
        if (resolveNext) {
          resolveNext();
          resolveNext = undefined;
        }
      },
      finish(): void {
        finished = true;
        const w = waiters.shift();
        if (w) w();
      },
      abort(): void {
        session.aborted = true;
        finished = true;
      },
      get chunks(): AsyncIterable<TtsAudioChunk> {
        let i = 0;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<TtsAudioChunk>> {
                for (;;) {
                  if (i < pushed.length) {
                    const sentence = pushed[i++]!;
                    return { done: false, value: { pcm: new Int16Array([sentence.length]), sampleRate: 24000 } };
                  }
                  if (finished) return { done: true, value: undefined };
                  await new Promise<void>((r) => waiters.push(r));
                }
              },
            };
          },
        };
      },
    };
    return session;
  }

  it('token 流逐字喂:凑成整句即 push,首句先于整段', async () => {
    const emitted: TtsAudioChunk[] = [];
    const session = liveSession();
    const readout = makeTokenStreamReadout(
      { newSplitter, openSession: () => session, emitAudio: (c) => emitted.push(c) },
      'zh',
      new AbortController().signal,
    );
    // 逐 token 喂:第一句到「。」即应 push。
    readout.onToken('你');
    readout.onToken('好');
    readout.onToken('。'); // 第一句凑齐
    expect(session.pushed).toEqual(['你好。']);
    readout.onToken('再见!'); // 第二句
    expect(session.pushed).toEqual(['你好。', '再见!']);
    readout.done(); // 无残余
    await readout.consumed;
    expect(emitted.length).toBe(2);
  });

  it('done flush 残余(末句无标点)', async () => {
    const emitted: TtsAudioChunk[] = [];
    const session = liveSession();
    const readout = makeTokenStreamReadout(
      { newSplitter, openSession: () => session, emitAudio: (c) => emitted.push(c) },
      'zh',
      new AbortController().signal,
    );
    readout.onToken('在听');
    expect(session.pushed).toEqual([]); // 无句末标点,未 push
    readout.done(); // flush 残余
    expect(session.pushed).toEqual(['在听']);
    await readout.consumed;
    expect(emitted.length).toBe(1);
  });

  it('abort → session.abort,后续 token 不再 push', async () => {
    const session = liveSession();
    const ac = new AbortController();
    const readout = makeTokenStreamReadout(
      { newSplitter, openSession: () => session, emitAudio: () => {} },
      'zh',
      ac.signal,
    );
    readout.onToken('你好。');
    ac.abort();
    expect(session.aborted).toBe(true);
    readout.onToken('再见。'); // abort 后忽略
    expect(session.pushed).toEqual(['你好。']);
    await readout.consumed;
  });
});

describe('isSpeakAvailable(朗读可用性,纯)', () => {
  it('fake → 不可用;真合成 kind → 可用', () => {
    expect(isSpeakAvailable('fake')).toBe(false);
    expect(isSpeakAvailable('qwen-tts')).toBe(true);
    expect(isSpeakAvailable('openai-compat')).toBe(true);
    expect(isSpeakAvailable('kokoro')).toBe(true);
  });
});

describe('新增 IPC 通道常量(防散落字符串)', () => {
  it('langGet/langSet/ttsAudio/ttsAudioStop 已注册', () => {
    expect(IPC.langGet).toBe('lang:get');
    expect(IPC.langSet).toBe('lang:set');
    expect(IPC.ttsAudio).toBe('tts:audio');
    expect(IPC.ttsAudioStop).toBe('tts:audio-stop');
  });
});
