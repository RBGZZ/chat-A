import { describe, it, expect } from 'vitest';
import { nextState } from '../src/voice-turn-state';

describe('runtime/voice-turn-state', () => {
  it('完整闭环合法迁移', () => {
    expect(nextState('listening', 'vad:speech_start')).toBe('endpointing');
    expect(nextState('endpointing', 'stt:final')).toBe('thinking');
    expect(nextState('thinking', 'tts:first_audio')).toBe('speaking');
    expect(nextState('speaking', 'turn:end')).toBe('listening');
  });
  it('打断迁移', () => {
    expect(nextState('speaking', 'vad:speech_start')).toBe('barge_in_pending');
    expect(nextState('barge_in_pending', 'turn:interrupt')).toBe('listening');
  });
  it('非法迁移返回 null', () => {
    expect(nextState('listening', 'tts:first_audio')).toBeNull();
  });
  it('committing 中间态:endpointing→committing→thinking;失败/超越回 listening', () => {
    // 关重入窗的瞬态忙:批式路 await 转写之前先迁入 committing,期间 onAudio 不再累积/判 EOU。
    expect(nextState('endpointing', 'eou')).toBe('committing');
    expect(nextState('committing', 'stt:final')).toBe('thinking');
    expect(nextState('committing', 'vad:speech_end')).toBe('listening');
  });
});
