/**
 * SentenceAggregator —— B 层帧管线「句级聚合」处理器(承 §4.2 帧管线 + frame-processing spec)。
 *
 * 把 LLM 的 **token 流**聚合为**句级单元**供下游 TTS 消费:首句尽快下发以降 TTFA,
 * 残余留缓冲等后续 token,流结束 `flush` 吐尾。
 *
 * 与既有 `SentenceSplitter` 的关系(承 spec「替换或等价于现有 SentenceSplitter 并保持既有测试通过」):
 * 本类是 SentenceSplitter 的**语义等价封装 + 命名对齐**——切句规则与上限完全复用 SentenceSplitter
 * (单一权威,杜绝两套切句逻辑漂移),只把对外方法名对齐帧管线词汇(`aggregate`/`flush`)。
 * VoiceLoop 既有「说」路径仍可用 SentenceSplitter,亦可平替为本类,既有 sentence-splitter 测试不受影响。
 *
 * 纯增量状态机:`aggregate(token)` 返回本次新成的整句(0..n);确定性,可 golden test。
 */
import { SentenceSplitter, type SentenceSplitterOptions } from './sentence-splitter';

/** 句级聚合旋钮(透传给底层 SentenceSplitter;无 magic number)。 */
export type SentenceAggregatorOptions = SentenceSplitterOptions;

export class SentenceAggregator {
  /** 底层切句引擎(单一权威切句规则,复用 SentenceSplitter)。 */
  readonly #splitter: SentenceSplitter;

  constructor(opts: SentenceAggregatorOptions = {}) {
    this.#splitter = new SentenceSplitter(opts);
  }

  /**
   * 喂入一段 token 文本,返回本次新聚合成的完整句(0..n 句);残余留缓冲等后续 token。
   * 与 `SentenceSplitter.push` 行为逐字一致(等价封装)。
   */
  aggregate(token: string): string[] {
    return this.#splitter.push(token);
  }

  /** 流结束:吐出最后残余(trim 后非空)或 null,并清空缓冲。 */
  flush(): string | null {
    return this.#splitter.flush();
  }
}
