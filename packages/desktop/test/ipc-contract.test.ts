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
  CHAT_ERROR_TEXT,
  VOICE_UNAVAILABLE_REASON,
  type UiState,
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
