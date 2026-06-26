import { describe, it, expect } from 'vitest';
import { resampleSinc } from '../src/audio/resample';

/** 生成 rate Hz 下 freq Hz 的正弦，n 样本，幅度 a（Int16）。 */
function tone(freq: number, rate: number, n: number, a = 8000): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(a * Math.sin((2 * Math.PI * freq * i) / rate));
  return out;
}
/** 在 rate 下用朴素 DFT 估某频点幅度（仅测试用，小 n）。 */
function mag(x: Int16Array, freq: number, rate: number): number {
  let re = 0, im = 0;
  for (let i = 0; i < x.length; i++) {
    const p = (2 * Math.PI * freq * i) / rate;
    re += x[i]! * Math.cos(p); im -= x[i]! * Math.sin(p);
  }
  return Math.sqrt(re * re + im * im) / x.length;
}

describe('resampleSinc', () => {
  it('恒等率返回等值拷贝', () => {
    const x = tone(1000, 16000, 320);
    const y = resampleSinc(x, 16000, 16000);
    expect(y).not.toBe(x);
    expect(Array.from(y)).toEqual(Array.from(x));
  });

  it('输出长度按比例', () => {
    const x = tone(1000, 48000, 480);
    expect(resampleSinc(x, 48000, 16000).length).toBe(160);
  });

  it('48k→16k：低频(1kHz)保留、超奈奎斯特(10kHz)被抗混叠压制(不折回6kHz)', () => {
    const N = 4800; // 0.1s @48k
    const low = resampleSinc(tone(1000, 48000, N), 48000, 16000);
    const high = resampleSinc(tone(10000, 48000, N), 48000, 16000);
    // 1kHz 在输出里仍有明显能量
    const lowMag = mag(low, 1000, 16000);
    // 10kHz>8k 输出奈奎斯特：劣质降采样会折回 16000-10000=6000Hz；抗混叠后该处应很弱
    const aliasMag = mag(high, 6000, 16000);
    expect(lowMag).toBeGreaterThan(500);
    expect(aliasMag).toBeLessThan(lowMag * 0.1); // 混叠分量 < 低频能量 10%
  });
});
