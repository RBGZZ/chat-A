import { describe, expect, it } from 'vitest';
import { arbitrate } from '../src/arbiter';
import type { SpeakRequest, SpeakState } from '../src/types';

function req(overrides: Partial<SpeakRequest> = {}): SpeakRequest {
  return { skillId: 's', priority: 'PERCEPTION', deferrable: false, ...overrides };
}

describe('arbitrate(requestSpeak 输出仲裁,§7)', () => {
  it('空闲直接放行 → speak,不抢占', () => {
    const out = arbitrate(req(), { isSpeaking: false });
    expect(out.decision).toBe('speak');
    expect(out.preempted).toBe(false);
  });

  it('忙且来者优先级更高 → speak 且 preempted', () => {
    const state: SpeakState = { isSpeaking: true, speakingPriority: 'PERCEPTION' };
    const out = arbitrate(req({ priority: 'URGENT' }), state);
    expect(out.decision).toBe('speak');
    expect(out.preempted).toBe(true);
  });

  it('忙、同级、可延续 → defer', () => {
    const state: SpeakState = { isSpeaking: true, speakingPriority: 'PERCEPTION' };
    const out = arbitrate(req({ priority: 'PERCEPTION', deferrable: true }), state);
    expect(out.decision).toBe('defer');
    expect(out.preempted).toBe(false);
  });

  it('忙、同级、不可延续 → drop', () => {
    const state: SpeakState = { isSpeaking: true, speakingPriority: 'PERCEPTION' };
    const out = arbitrate(req({ priority: 'PERCEPTION', deferrable: false }), state);
    expect(out.decision).toBe('drop');
  });

  it('忙、来者更低优先级、可延续 → defer(低优先级不抢占)', () => {
    const state: SpeakState = { isSpeaking: true, speakingPriority: 'URGENT' };
    const out = arbitrate(req({ priority: 'LOWEST', deferrable: true }), state);
    expect(out.decision).toBe('defer');
    expect(out.preempted).toBe(false);
  });

  it('忙、来者更低优先级、不可延续 → drop', () => {
    const state: SpeakState = { isSpeaking: true, speakingPriority: 'URGENT' };
    const out = arbitrate(req({ priority: 'LOWEST', deferrable: false }), state);
    expect(out.decision).toBe('drop');
  });

  it('在说者优先级缺省时任何明确优先级都能抢占', () => {
    const out = arbitrate(req({ priority: 'LOWEST' }), { isSpeaking: true });
    expect(out.decision).toBe('speak');
    expect(out.preempted).toBe(true);
  });

  it('纯函数:同输入恒同输出,不改入参', () => {
    const r = req({ priority: 'URGENT' });
    const s: SpeakState = { isSpeaking: true, speakingPriority: 'PERCEPTION' };
    const a = arbitrate(r, s);
    const b = arbitrate(r, s);
    expect(a).toEqual(b);
    expect(r.priority).toBe('URGENT'); // 入参未被改动
  });
});
