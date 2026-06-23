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
});
