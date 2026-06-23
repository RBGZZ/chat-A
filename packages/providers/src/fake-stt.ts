import type { PcmChunk } from './audio';
import { STT_SAMPLE_RATE_HZ } from './audio';
import { assertSttLanguage } from './stt';
import type { SttCapabilities, SttOptions, SttProvider, SttResult } from './stt';

/**
 * 确定性占位 STT(承 §3.2 可测试性;对应 FakeLlm/HashEmbedder 在各自接缝的角色)。
 * 无引擎依赖 / 离线 / 单测用。
 *
 * 行为(完全确定):
 * - 默认脚本:每吃到一个音频块,emit 一条 partial(文本 = "块#k:Ns" 累积转写);
 *   音频流结束后 emit 一条 final(累积全部块的合成文本)。
 *   "Ns" = 该块时长(秒,一位小数),让 partial→final 可被断言、与输入块一一对应。
 * - 可注入 `script`(罐装结果序列)做 record-replay:逐条 yield,忽略实际音频。
 * - 能力门:opts.language 不在 languages 内 → fail-fast(沿用 §4.3)。
 */
export interface FakeSttOptions {
  /** 罐装结果脚本(record-replay):提供则逐条回放,忽略音频内容。 */
  readonly script?: readonly SttResult[];
  /** 能力声明覆盖(默认:多语种 '*' / 流式 / 16kHz)。 */
  readonly capabilities?: Partial<SttCapabilities>;
}

export class FakeStt implements SttProvider {
  readonly id = 'fake';
  readonly capabilities: SttCapabilities;
  readonly #script: readonly SttResult[] | undefined;

  constructor(opts: FakeSttOptions = {}) {
    this.#script = opts.script;
    this.capabilities = {
      languages: opts.capabilities?.languages ?? ['*'],
      streaming: opts.capabilities?.streaming ?? true,
      sampleRate: opts.capabilities?.sampleRate ?? STT_SAMPLE_RATE_HZ,
      ...(opts.capabilities?.requiresCuda !== undefined
        ? { requiresCuda: opts.capabilities.requiresCuda }
        : {}),
    };
  }

  async *transcribe(
    audio: AsyncIterable<PcmChunk>,
    opts?: SttOptions,
    _signal?: AbortSignal,
  ): AsyncIterable<SttResult> {
    // 能力门 fail-fast(§4.3):不支持的语种提前拦,不"假装转写"。
    assertSttLanguage(this.capabilities, opts?.language);

    if (this.#script !== undefined) {
      for (const r of this.#script) yield r;
      return;
    }

    // 默认确定性脚本:每块一条 partial,流尾一条 final。
    const lang = opts?.language;
    let k = 0;
    const parts: string[] = [];
    for await (const chunk of audio) {
      const secs = (chunk.samples.length / Math.max(1, chunk.channels) / chunk.sampleRate).toFixed(1);
      parts.push(`块#${k}:${secs}s`);
      k++;
      yield {
        text: parts.join(' '),
        isFinal: false,
        ...(lang !== undefined ? { language: lang } : {}),
      };
    }
    yield {
      text: parts.length > 0 ? `转写[${parts.join(' ')}]` : '(空音频)',
      isFinal: true,
      ...(lang !== undefined ? { language: lang } : {}),
    };
  }
}
