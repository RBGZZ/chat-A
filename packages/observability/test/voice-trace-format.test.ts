import { describe, it, expect } from 'vitest';
import type { VoiceTraceEvent } from '@chat-a/protocol';
import { formatVoiceTrace } from '../src/index';

// 公共字段(缝合键)对实时日志行无影响:格式只取 kind 专属字段。
const base = { atMs: 1000, correlationId: 'corr-1', sessionId: 'sess-1', turnId: 'turn-1' } as const;

describe('formatVoiceTrace:每种 kind → 单行 [vtrace] 紧凑格式(对齐 spec §6 样例)', () => {
  it('mic-sample → mic rms(4 位小数,判麦有无信号)', () => {
    const ev: VoiceTraceEvent = { ...base, kind: 'mic-sample', rmsNorm: 0.0001 };
    const line = formatVoiceTrace(ev);
    expect(line).toBe('[vtrace] mic rms=0.0001');
    expect(line).not.toContain('\n');
  });

  it('vad → vad <event>', () => {
    expect(formatVoiceTrace({ ...base, kind: 'vad', event: 'speech_start' })).toBe(
      '[vtrace] vad speech_start',
    );
    expect(formatVoiceTrace({ ...base, kind: 'vad', event: 'speech_end' })).toBe(
      '[vtrace] vad speech_end',
    );
  });

  it('endpoint → endpoint silence=<ms>ms', () => {
    const ev: VoiceTraceEvent = { ...base, kind: 'endpoint', silenceMs: 600 };
    expect(formatVoiceTrace(ev)).toBe('[vtrace] endpoint silence=600ms');
  });

  it('echo-guard → tier/rms(3 位)/run/passed', () => {
    const ev: VoiceTraceEvent = {
      ...base,
      kind: 'echo-guard',
      tier: 'speaking',
      rmsNorm: 0.001,
      run: 0,
      passed: false,
    };
    expect(formatVoiceTrace(ev)).toBe('[vtrace] echo-guard tier=speaking rms=0.001 run=0 passed=false');
  });

  it('speech-gate → passed/total/voiced', () => {
    const ev: VoiceTraceEvent = {
      ...base,
      kind: 'speech-gate',
      passed: false,
      totalMs: 300,
      voicedMs: 40,
    };
    expect(formatVoiceTrace(ev)).toBe('[vtrace] speech-gate passed=false total=300ms voiced=40ms');
  });

  it('backchannel(fired,带 clipText)→ 含 clipText 引号包裹', () => {
    const ev: VoiceTraceEvent = { ...base, kind: 'backchannel', fired: true, clipText: '嗯' };
    expect(formatVoiceTrace(ev)).toBe('[vtrace] backchannel fired=true clipText="嗯"');
  });

  it('backchannel(未 fire,无 clipText)→ 省略 clipText', () => {
    const ev: VoiceTraceEvent = { ...base, kind: 'backchannel', fired: false };
    expect(formatVoiceTrace(ev)).toBe('[vtrace] backchannel fired=false');
  });

  it('state → from→to(箭头)', () => {
    const ev: VoiceTraceEvent = { ...base, kind: 'state', from: 'listening', to: 'endpointing' };
    expect(formatVoiceTrace(ev)).toBe('[vtrace] state listening→endpointing');
  });

  it('stt-input → path/dur/rms(3 位,带尾零)', () => {
    const ev: VoiceTraceEvent = {
      ...base,
      kind: 'stt-input',
      path: 'stt-stream',
      durationMs: 1200,
      rmsNorm: 0.03,
    };
    expect(formatVoiceTrace(ev)).toBe('[vtrace] stt-input path=stt-stream dur=1200ms rms=0.030');
  });

  it('stt-result(final,带 emotion/lang)→ final + text 引号 + 可选字段', () => {
    const ev: VoiceTraceEvent = {
      ...base,
      kind: 'stt-result',
      text: '你好世界',
      emotion: 'happy',
      lang: 'zh',
      isFinal: true,
    };
    expect(formatVoiceTrace(ev)).toBe('[vtrace] stt-result final text="你好世界" emotion=happy lang=zh');
  });

  it('stt-result(partial,无 emotion/lang)→ partial + 省略可选字段', () => {
    const ev: VoiceTraceEvent = { ...base, kind: 'stt-result', text: '你好', isFinal: false };
    expect(formatVoiceTrace(ev)).toBe('[vtrace] stt-result partial text="你好"');
  });

  it('turn(replied,带 ttfa)→ outcome + ttfa', () => {
    const ev: VoiceTraceEvent = { ...base, kind: 'turn', outcome: 'replied', ttfaMs: 620 };
    expect(formatVoiceTrace(ev)).toBe('[vtrace] turn outcome=replied ttfa=620ms');
  });

  it('turn(gated,无 ttfa)→ 省略 ttfa', () => {
    const ev: VoiceTraceEvent = { ...base, kind: 'turn', outcome: 'gated' };
    expect(formatVoiceTrace(ev)).toBe('[vtrace] turn outcome=gated');
  });

  it('所有产出均为单行、以 [vtrace] 前缀打头', () => {
    const samples: VoiceTraceEvent[] = [
      { ...base, kind: 'mic-sample', rmsNorm: 0.5 },
      { ...base, kind: 'vad', event: 'speech_end' },
      { ...base, kind: 'endpoint', silenceMs: 800 },
      { ...base, kind: 'echo-guard', tier: 'idle', rmsNorm: 0.2, run: 3, passed: true },
      { ...base, kind: 'speech-gate', passed: true, totalMs: 1000, voicedMs: 700 },
      { ...base, kind: 'backchannel', fired: true, clipText: '对' },
      { ...base, kind: 'state', from: 'idle', to: 'listening' },
      { ...base, kind: 'stt-input', path: 'omni', durationMs: 500, rmsNorm: 0.1 },
      { ...base, kind: 'stt-result', text: 'hi', isFinal: true },
      { ...base, kind: 'turn', outcome: 'error' },
    ];
    for (const ev of samples) {
      const line = formatVoiceTrace(ev);
      expect(line.startsWith('[vtrace] ')).toBe(true);
      expect(line).not.toContain('\n');
    }
  });
});
