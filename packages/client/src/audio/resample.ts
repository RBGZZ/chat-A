/**
 * 抗混叠重采样（窗口 sinc / band-limited 插值）—— 替换裸线性插值，消除降采样混叠（修 bug2）。
 * 低通截止 = 较低采样率的奈奎斯特（归一 cutoff=min(1, outRate/inRate)），故升/降采样皆抗混叠。
 * 纯函数、无依赖、嵌入式友好（定长核、O(n*taps)）。
 */

/** 核半宽：taps = 2*HALF+1。16 对语音足够（过渡带陡度 vs 计算量折中）。 */
export const RESAMPLE_HALF_TAPS = 16;

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}
/** Blackman 窗（[-half, half] 上），抑制旁瓣。 */
function blackman(n: number, half: number): number {
  const t = (n + half) / (2 * half); // 映射到 [0,1]
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
}
function clampInt16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

export function resampleSinc(input: Int16Array, inRate: number, outRate: number): Int16Array {
  if (inRate === outRate) return Int16Array.from(input);
  const inLen = input.length;
  if (inLen === 0) return new Int16Array(0);
  const ratio = outRate / inRate;
  const outLen = Math.max(1, Math.round(inLen * ratio));
  const out = new Int16Array(outLen);
  const cutoff = Math.min(1, ratio); // 归一截止（较低率的奈奎斯特）
  const half = RESAMPLE_HALF_TAPS;
  for (let i = 0; i < outLen; i++) {
    const center = i / ratio; // 对应输入样本位置
    const left = Math.ceil(center - half);
    const right = Math.floor(center + half);
    let acc = 0;
    let wsum = 0;
    for (let j = left; j <= right; j++) {
      const xi = j < 0 ? 0 : j >= inLen ? inLen - 1 : j; // 边界 clamp
      const t = center - j;
      const w = sinc(cutoff * t) * cutoff * blackman(t, half);
      acc += input[xi]! * w;
      wsum += w;
    }
    out[i] = clampInt16(Math.round(wsum !== 0 ? acc / wsum : acc));
  }
  return out;
}
