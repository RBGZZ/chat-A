import type { PcmChunk } from './audio';
import { TTS_SAMPLE_RATE_HZ, pcmChunk } from './audio';
import { assertTtsCloning, assertTtsLanguage } from './tts';
import type { TtsCapabilities, TtsOptions, TtsProvider } from './tts';

/**
 * 确定性占位 TTS(承 §3.2 可测试性;对应 FakeLlm 在 LLM 接缝的角色)。
 * 无引擎依赖 / 离线 / 单测用。
 *
 * 行为(完全确定,可校验):
 * - 把文本按"段"(默认按句末标点/换行切;无标点则整段一块)切成若干块,每段产出**一个 PcmChunk**;
 * - 每块样本数 = `段字符数 * samplesPerChar`(默认 1200,≈24kHz 下每字符 50ms),
 *   样本值用确定性公式由(块序号、字符码)生成 → 同输入同输出,测试可逐块断言长度/内容。
 * - **复刻路径标记**:当 opts 带 refAudio 或 voiceId 时,首样本写入"复刻标记"值(CLONE_MARK),
 *   供单测断言"复刻参数确实走到了合成"。
 * - 能力门:语种不支持 / 不支持复刻却传 refAudio → fail-fast(§4.3/v2.1)。
 */
export interface FakeTtsOptions {
  /** 每字符生成的样本数(默认 1200);决定块长度,便于测试按比例断言。 */
  readonly samplesPerChar?: number;
  /** 能力声明覆盖(默认:多语种 '*' / 含 voiceId 'fake-voice'+'xiaoxue_v2' / 24kHz / 流式 / 支持复刻)。 */
  readonly capabilities?: Partial<TtsCapabilities>;
}

/** 复刻路径标记值(写入复刻块首样本);单测据此确认走了复刻分支。 */
export const FAKE_TTS_CLONE_MARK = 12321;

export class FakeTts implements TtsProvider {
  readonly id = 'fake';
  readonly capabilities: TtsCapabilities;
  readonly #samplesPerChar: number;

  constructor(opts: FakeTtsOptions = {}) {
    this.#samplesPerChar = opts.samplesPerChar ?? 1200;
    this.capabilities = {
      languages: opts.capabilities?.languages ?? ['*'],
      voiceId: opts.capabilities?.voiceId ?? ['fake-voice', 'xiaoxue_v2'],
      sampleRate: opts.capabilities?.sampleRate ?? TTS_SAMPLE_RATE_HZ,
      streaming: opts.capabilities?.streaming ?? true,
      voiceCloning: opts.capabilities?.voiceCloning ?? true,
      ...(opts.capabilities?.requiresCuda !== undefined
        ? { requiresCuda: opts.capabilities.requiresCuda }
        : {}),
    };
  }

  async *synthesize(
    text: string,
    opts?: TtsOptions,
    _signal?: AbortSignal,
  ): AsyncIterable<PcmChunk> {
    // 能力门 fail-fast(§4.3/v2.1):语种、复刻能力提前校验。
    assertTtsLanguage(this.capabilities, opts?.language);
    assertTtsCloning(this.capabilities, opts);

    // 复刻路径:带 refAudio 或选了 voiceId(已注册复刻音色)即视为复刻,首样本打标记。
    const cloning = opts?.refAudio !== undefined || opts?.voiceId !== undefined;
    const rate = this.capabilities.sampleRate;

    const segments = splitSegments(text);
    let seg = 0;
    for (const s of segments) {
      const n = Math.max(1, s.length) * this.#samplesPerChar;
      const samples = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        // 确定性:段序号 + 段内字符码驱动;限制在 Int16 范围。
        const code = s.charCodeAt(i % Math.max(1, s.length)) || 0;
        samples[i] = ((seg * 31 + i * 7 + code) % 4096) - 2048;
      }
      if (cloning && n > 0) samples[0] = FAKE_TTS_CLONE_MARK; // 复刻标记(单测可断言)。
      yield pcmChunk(samples, rate);
      seg++;
    }
  }
}

/** 把文本切成"段":按中英句末标点/换行切,保留可发音内容;无标点则整段一段。 */
function splitSegments(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const parts = trimmed
    .split(/(?<=[。!?\.!?\n])/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : [trimmed];
}
