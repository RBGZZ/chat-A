import { describe, it, expect } from 'vitest';
import { prosodyToPadPull, DEFAULT_PROSODY_PAD_MAP } from '../src/index';
import type { PadPull } from '../src/index';

describe('prosodyToPadPull(语音情绪 → PAD 拉力,确定性内核 §7#5)', () => {
  it('7 类情绪 golden:逐条钉死 PadPull(对齐默认映射表)', () => {
    const cases: { label: string; expect: PadPull }[] = [
      { label: 'happy', expect: { pleasure: 0.4, arousal: 0.3, dominance: 0.2 } },
      { label: 'surprised', expect: { pleasure: 0.0, arousal: 0.5, dominance: -0.1 } },
      { label: 'sad', expect: { pleasure: -0.4, arousal: -0.3, dominance: -0.3 } },
      { label: 'fearful', expect: { pleasure: -0.3, arousal: 0.4, dominance: -0.4 } },
      { label: 'angry', expect: { pleasure: -0.3, arousal: 0.4, dominance: 0.3 } },
      { label: 'disgusted', expect: { pleasure: -0.4, arousal: 0.1, dominance: 0.1 } },
      // neutral 不入表 → 零拉力(下面单测覆盖)。
    ];
    for (const c of cases) {
      expect(prosodyToPadPull({ label: c.label })).toEqual(c.expect);
    }
  });

  it('neutral / 未知 / undefined → 零拉力(安全降级)', () => {
    const zero: PadPull = { pleasure: 0, arousal: 0, dominance: 0 };
    expect(prosodyToPadPull({ label: 'neutral' })).toEqual(zero);
    expect(prosodyToPadPull({ label: '__unknown__' })).toEqual(zero);
    expect(prosodyToPadPull(undefined)).toEqual(zero);
  });

  it('confidence ∈ (0,1] → 拉力线性缩放', () => {
    expect(prosodyToPadPull({ label: 'sad', confidence: 0.5 })).toEqual({
      pleasure: -0.2,
      arousal: -0.15,
      dominance: -0.15,
    });
  });

  it('confidence 缺省 / 越界(0、>1、负、NaN)→ 不缩放(视作 1)', () => {
    const full = DEFAULT_PROSODY_PAD_MAP['happy'];
    expect(prosodyToPadPull({ label: 'happy' })).toEqual(full);
    expect(prosodyToPadPull({ label: 'happy', confidence: 0 })).toEqual(full);
    expect(prosodyToPadPull({ label: 'happy', confidence: 1.5 })).toEqual(full);
    expect(prosodyToPadPull({ label: 'happy', confidence: -1 })).toEqual(full);
    expect(prosodyToPadPull({ label: 'happy', confidence: Number.NaN })).toEqual(full);
  });

  it('两次同入参输出全等(确定性,纯函数)', () => {
    const a = prosodyToPadPull({ label: 'angry', confidence: 0.8 });
    const b = prosodyToPadPull({ label: 'angry', confidence: 0.8 });
    expect(a).toEqual(b);
  });

  it('可注入自定义映射表(行为即配置)', () => {
    const custom = { whisper: { pleasure: 0.1, arousal: -0.2, dominance: 0 } } as const;
    expect(prosodyToPadPull({ label: 'whisper' }, custom)).toEqual({
      pleasure: 0.1,
      arousal: -0.2,
      dominance: 0,
    });
    // 默认表里的标签在自定义表外 → 零拉力。
    expect(prosodyToPadPull({ label: 'happy' }, custom)).toEqual({
      pleasure: 0,
      arousal: 0,
      dominance: 0,
    });
  });

  it('结果各维钳制 [-1,1]', () => {
    // 自定义超界拉力 → 钳制。
    const over = { x: { pleasure: 2, arousal: -3, dominance: 1.5 } } as const;
    expect(prosodyToPadPull({ label: 'x' }, over)).toEqual({
      pleasure: 1,
      arousal: -1,
      dominance: 1,
    });
  });
});
