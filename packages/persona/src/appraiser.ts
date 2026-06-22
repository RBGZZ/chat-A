import type { Appraiser, AppraiseContext, PadPull } from './types';

/**
 * P1 默认情绪评估(确定性,无网络)。最小 valence 词典 → 小幅 PAD 拉力,
 * 让心情随对话起伏可用、可写 golden test。**占位**:后续可整体替换为 LLM OCC→PAD 版本(§6.1)。
 * 词典外置(构造可覆盖),不散落 magic 词。
 */
export interface DefaultAppraiserOptions {
  readonly positive?: readonly string[];
  readonly negative?: readonly string[];
  /** 命中一个词的基础拉力幅度。 */
  readonly unit?: number;
}

const POSITIVE = ['谢谢', '喜欢', '爱', '开心', '高兴', '哈哈', '太好了', '棒', '好喜欢', 'love', 'thanks', 'great'];
const NEGATIVE = ['讨厌', '烦', '难过', '生气', '滚', '闭嘴', '失望', '伤心', '无聊', 'hate', 'sad', 'angry'];

export class DefaultAppraiser implements Appraiser {
  readonly #positive: readonly string[];
  readonly #negative: readonly string[];
  readonly #unit: number;

  constructor(opts: DefaultAppraiserOptions = {}) {
    this.#positive = opts.positive ?? POSITIVE;
    this.#negative = opts.negative ?? NEGATIVE;
    this.#unit = opts.unit ?? 0.4;
  }

  appraise(ctx: AppraiseContext): PadPull {
    const text = ctx.userText.toLowerCase();
    let pos = 0;
    let neg = 0;
    for (const w of this.#positive) if (text.includes(w.toLowerCase())) pos++;
    for (const w of this.#negative) if (text.includes(w.toLowerCase())) neg++;
    const valence = (pos - neg) * this.#unit;
    // 正向→愉悦上拉;负向→愉悦下拉且唤醒上升(烦躁),无明显信号则零拉力。
    return {
      pleasure: valence,
      arousal: neg > 0 ? neg * this.#unit * 0.5 : 0,
      dominance: 0,
    };
  }
}
