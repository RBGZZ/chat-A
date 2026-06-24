import { describe, it, expect } from 'vitest';
import { evaluateAttention, DEFAULT_FOCUS_SUSTAIN_MS } from '../src/attention';

describe('runtime/evaluateAttention(§7 软反转 + attention_mode)', () => {
  it('companion:用户一开口即 URGENT + abort + 真打断', () => {
    const v = evaluateAttention('companion', { sustainedMs: 0 });
    expect(v.priority).toBe('URGENT');
    expect(v.abort).toBe(true);
    expect(v.trueInterrupt).toBe(true);
    expect(v.bottomLine).toBe(false);
  });

  it('balanced:有在飞输出才打断;无在飞则只感知', () => {
    const withFlight = evaluateAttention('balanced', { sustainedMs: 0, somethingInFlight: true });
    expect(withFlight.abort).toBe(true);
    expect(withFlight.trueInterrupt).toBe(true);

    const noFlight = evaluateAttention('balanced', { sustainedMs: 0, somethingInFlight: false });
    expect(noFlight.priority).toBe('URGENT'); // 仍永远感知
    expect(noFlight.abort).toBe(false);
    expect(noFlight.trueInterrupt).toBe(false);
  });

  it('focus:短促出声仅感知不打断;坚持够门槛才打断(绝不装聋)', () => {
    const brief = evaluateAttention('focus', { sustainedMs: DEFAULT_FOCUS_SUSTAIN_MS - 1 });
    expect(brief.priority).toBe('URGENT'); // 永远感知:不降级
    expect(brief.abort).toBe(false);
    expect(brief.trueInterrupt).toBe(false);

    const sustained = evaluateAttention('focus', { sustainedMs: DEFAULT_FOCUS_SUSTAIN_MS });
    expect(sustained.abort).toBe(true);
    expect(sustained.trueInterrupt).toBe(true);
  });

  it('不可配底线:危机覆盖任何模式立即最高优先 + 打断', () => {
    for (const mode of ['companion', 'balanced', 'focus'] as const) {
      const v = evaluateAttention(mode, { sustainedMs: 0, crisis: true });
      expect(v.priority).toBe('URGENT');
      expect(v.abort).toBe(true);
      expect(v.trueInterrupt).toBe(true);
      expect(v.bottomLine).toBe(true);
    }
  });

  it('不可配底线:硬打断词覆盖任何模式(即便 focus 短促)', () => {
    const v = evaluateAttention('focus', { sustainedMs: 0, hardInterrupt: true });
    expect(v.abort).toBe(true);
    expect(v.trueInterrupt).toBe(true);
    expect(v.bottomLine).toBe(true);
  });

  it('纯函数:同输入同输出', () => {
    const sig = { sustainedMs: 100, somethingInFlight: true };
    expect(evaluateAttention('balanced', sig)).toEqual(evaluateAttention('balanced', sig));
  });
});
