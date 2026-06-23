/**
 * 流式句级切分器(承 §4.2 听→想→说:onToken 流式凑句喂 TTS,搬自 voice-core 设计)。
 *
 * 为何要它:`Conversation.send` 经 onToken 把回复**逐 token** 吐出,但 TTS 合成以
 * **完整句**为最小单位(半句合成会破坏韵律、且难以在句界干净打断)。本类把零散 token
 * 累积成「完整句」流:每次 `push` 返回本次新凑成的整句(可 0..n 句),残余留缓冲等后续 token;
 * `flush` 在回合结束时吐出最后残余。
 *
 * 切句规则(CJK 友好):
 *   1. 句末标点 `。！？!?\n`(中英文)出现即在标点后切出一句;
 *   2. 缓冲超 `maxChars`(默认 120,防单句过长令 TTS 溢出/延迟)且无句末标点时,
 *      在 `maxChars` 窗口内**就近** fallback 标点 `，；,;` 与空格处切;实在没有则在
 *      `maxChars` 处**硬切**(宁可断句也不让 TTS 吃超长输入)。
 *
 * 无 magic number:标点集合与上限均为常量/构造参数。
 */

/** 句末标点(中英文):出现即可独立成句。 */
const SENTENCE_END_PUNCT = '。！？!?\n';

/** fallback 软切点(中英文逗号/分号 + 空格):超长无句末标点时就近切。 */
const SOFT_BREAK_PUNCT = '，；,; ';

/** 单句字符上限默认值(防 TTS 超长输入)。 */
const DEFAULT_MAX_CHARS = 120;

/** 单句最小字符默认值(过短的软切点不取,避免碎句)。 */
const DEFAULT_MIN_CHARS = 1;

export interface SentenceSplitterOptions {
  /** 单句字符上限,超过则在窗口内 fallback 软切或硬切。默认 120。 */
  readonly maxChars?: number;
  /** 单句最小字符:fallback 软切点须落在此长度之后,避免切出过短碎句。默认 1。 */
  readonly minChars?: number;
}

export class SentenceSplitter {
  /** 累积缓冲:尚未凑成整句的残余 token 文本。 */
  #buf = '';
  readonly #maxChars: number;
  readonly #minChars: number;

  constructor(opts: SentenceSplitterOptions = {}) {
    this.#maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    this.#minChars = opts.minChars ?? DEFAULT_MIN_CHARS;
  }

  /**
   * 喂入一段 token 文本,返回本次新凑成的完整句(0..n 句)。
   * 残余(无句末标点且未超长的尾部)留在缓冲,等后续 token。
   */
  push(text: string): string[] {
    this.#buf += text;
    const out: string[] = [];
    // 反复从缓冲头部切出整句,直到剩余不足以成句。
    for (;;) {
      const cut = this.#findCut();
      if (cut <= 0) break;
      out.push(this.#buf.slice(0, cut));
      this.#buf = this.#buf.slice(cut);
    }
    return out;
  }

  /**
   * 流结束时吐出最后残余:trim 后非空则返回并清空缓冲,否则返回 null。
   */
  flush(): string | null {
    const tail = this.#buf.trim();
    this.#buf = '';
    return tail.length > 0 ? tail : null;
  }

  /**
   * 计算从缓冲头部应切出的字符数(含切点);0 表示当前不切。
   * 优先句末标点;否则当缓冲超 maxChars 时按 fallback 软切 / 硬切。
   */
  #findCut(): number {
    // 1) 句末标点:扫描首个出现位置,在其后切。
    for (let i = 0; i < this.#buf.length; i++) {
      if (SENTENCE_END_PUNCT.includes(this.#buf[i]!)) {
        return i + 1;
      }
    }
    // 2) 未超长则暂不切(等更多 token 或句末标点)。
    if (this.#buf.length < this.#maxChars) return 0;
    // 3) 超长:在 [minChars, maxChars] 窗口内就近 fallback 软切点(自右向左找最靠后的)。
    for (let i = this.#maxChars - 1; i >= this.#minChars; i--) {
      if (SOFT_BREAK_PUNCT.includes(this.#buf[i]!)) {
        return i + 1;
      }
    }
    // 4) 窗口内无软切点:在 maxChars 处硬切。
    return this.#maxChars;
  }
}
