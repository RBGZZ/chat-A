import type { PcmChunk } from './audio';
import { STT_SAMPLE_RATE_HZ } from './audio';
import { assertSttLanguage } from './stt';
import type { SttCapabilities, SttOptions, SttProvider, SttResult } from './stt';
import type { Device, ComputeType } from './hardware';

/**
 * 本地 Whisper 引擎(faster-whisper / whisper.cpp / sherpa-onnx CLI)的**注入式**适配(R1 隔离切片)。
 *
 * 为什么注入而非直接 `spawn`:worktree 里**不装原生二进制/模型、不测真硬件**(任务硬约束)。
 * 引擎经**注入的 {@link SpawnFn} 端口**调用:实现把入口音频流汇成一个 WAV,连同 CLI args 交给端口
 * → 端口起子进程喂 wav/stdin、收 stdout 文本 → 解析为单条 `SttResult{isFinal:true}`。
 * 运行时由调用方注入真 `SpawnFn`(包一层 `node:child_process` spawn);测试注入假端口。
 *
 * 形态(与 OpenAiCompatStt 对称):批式 CLI **非流式**(整段喂 → 整段转写),故
 * `capabilities.streaming=false`,只 emit 一条 `isFinal:true`(没有 partial)。
 *
 * 容错(沿用 LLM/STT 侧错误范式):子进程非 0 退出 / 抛错 → 抛带 code/stderr 片段的 Error;
 * 缺端口时构造即 fail-fast(明确"需运行时提供 spawn",不静默)。
 */

/**
 * 子进程调用端口(spawn 风格):给 wav 字节 + CLI args → 起子进程 → 收 stdout/stderr/退出码。
 *
 * 抽象到"一次性喂输入、收整段输出"的最小面:**不暴露 node 类型**(worktree 不引原生依赖),
 * 运行时实现自行包 `node:child_process`(把 wav 写 stdin 或临时文件、拼参数、收 stdout)。
 * 设计成 Promise 而非流:本地 Whisper CLI 是批式(整段进整段出),与 streaming=false 一致。
 */
export interface SpawnFn {
  /**
   * 起一次子进程转写。
   * @param input 待转写音频(完整 WAV 字节,16kHz mono s16le)。
   * @param args  CLI 参数(由适配按 config 拼好,如 ['--model','large-v3','--language','zh'])。
   * @param signal 中断信号(上层打断时杀子进程)。
   * @returns 子进程结果:stdout(转写文本载体)、stderr、退出码。
   */
  (input: Uint8Array, args: readonly string[], signal?: AbortSignal): Promise<SpawnResult>;
}

/** 子进程一次性结果(最小面;不依赖 node 类型)。 */
export interface SpawnResult {
  /** 标准输出(转写文本载体:纯文本或 JSON,由 textParser 解析)。 */
  readonly stdout: string;
  /** 标准错误(诊断/容错用);可空。 */
  readonly stderr?: string;
  /** 退出码;0 = 成功,非 0(或 null=被信号杀)视为失败。 */
  readonly code: number | null;
}

export interface WhisperLocalSttOptions {
  /** provider 标识(如 'whisper-local' / 'faster-whisper')——仅供 trace/日志(§8.1)。 */
  readonly id: string;
  /** 模型大小或路径(faster-whisper `model_size_or_path` / whisper.cpp `-m`)。 */
  readonly model: string;
  /** 注入的子进程端口;缺省构造即抛"需运行时提供 spawn"。 */
  readonly spawn: SpawnFn;
  /** 设备(faster-whisper `device`;共享 {@link Device})。 */
  readonly device?: Device;
  /** 计算精度(faster-whisper `compute_type`;共享 {@link ComputeType})。 */
  readonly computeType?: ComputeType;
  /** 默认目标语种(可被 transcribe opts 覆盖);省略 = 自动检测。 */
  readonly language?: string;
  /** beam search 宽度(faster-whisper `beam_size`)。 */
  readonly beamSize?: number;
  /** 是否启用 VAD 过滤(faster-whisper `vad_filter`)。 */
  readonly vadFilter?: boolean;
  /** 是否要求 CUDA(能力位,§4.3 能力门)。 */
  readonly requiresCuda?: boolean;
  /** 期望输入采样率(Hz);默认 16000(Whisper 系硬约定)。 */
  readonly sampleRate?: number;
  /** 声明支持语种(能力位);默认 ['*'](自动检测/多语种)。 */
  readonly languages?: readonly string[];
  /**
   * 把子进程 stdout 解析成转写文本(可选;默认整段 trim)。
   * 不同 CLI 输出不同(纯文本 / JSON);运行时按引擎注入对应解析器,适配核心不变。
   */
  readonly textParser?: (stdout: string) => string;
}

export class WhisperLocalStt implements SttProvider {
  readonly id: string;
  readonly capabilities: SttCapabilities;
  readonly #model: string;
  readonly #spawn: SpawnFn;
  readonly #device: Device | undefined;
  readonly #computeType: ComputeType | undefined;
  readonly #language: string | undefined;
  readonly #beamSize: number | undefined;
  readonly #vadFilter: boolean | undefined;
  readonly #sampleRate: number;
  readonly #parse: (stdout: string) => string;

  constructor(opts: WhisperLocalSttOptions) {
    if (typeof opts.spawn !== 'function') {
      // 缺端口 fail-fast(沿用"明确报错而非静默吞配置"):由运行时注入真 spawn。
      throw new Error(
        `whisper-local STT 需运行时提供 spawn 端口(SpawnFn);config 已就位:model=${opts.model}`,
      );
    }
    this.id = opts.id;
    this.#model = opts.model;
    this.#spawn = opts.spawn;
    this.#device = opts.device;
    this.#computeType = opts.computeType;
    this.#language = opts.language;
    this.#beamSize = opts.beamSize;
    this.#vadFilter = opts.vadFilter;
    this.#sampleRate = opts.sampleRate ?? STT_SAMPLE_RATE_HZ;
    this.#parse = opts.textParser ?? ((s) => s.trim());
    this.capabilities = {
      languages: opts.languages ?? ['*'],
      streaming: false, // 批式 CLI:整段喂,无 partial。
      sampleRate: this.#sampleRate,
      ...(opts.requiresCuda !== undefined ? { requiresCuda: opts.requiresCuda } : {}),
    };
  }

  async *transcribe(
    audio: AsyncIterable<PcmChunk>,
    opts?: SttOptions,
    signal?: AbortSignal,
  ): AsyncIterable<SttResult> {
    const language = opts?.language ?? this.#language;
    // 能力门 fail-fast(§4.3):不支持的语种提前拦,不起子进程。
    assertSttLanguage(this.capabilities, language);

    // 聚合音频流 → 单个 WAV(批式 CLI 要完整文件)。
    const chunks: PcmChunk[] = [];
    for await (const c of audio) chunks.push(c);
    const wav = encodeWav(chunks, this.#sampleRate);

    const args = this.#buildArgs(language, opts?.prompt);

    let result: SpawnResult;
    try {
      result = await this.#spawn(wav, args, signal);
    } catch (err) {
      // 子进程起不来 / 端口抛错 → 容错为带上下文的 Error。
      throw new Error(`${this.id} 子进程调用失败: ${(err as Error)?.message ?? String(err)}`);
    }
    if (result.code !== 0) {
      const detail = (result.stderr ?? '').slice(0, 500);
      throw new Error(
        `${this.id} 子进程非 0 退出(code=${result.code ?? 'null'})${detail ? `: ${detail}` : ''}`,
      );
    }

    const text = this.#parse(result.stdout);
    yield {
      text,
      isFinal: true,
      ...(language !== undefined ? { language } : {}),
    };
  }

  /** 按 config 拼 CLI 参数(贴合 faster-whisper / whisper.cpp 常见入参;运行时实现据此映射)。 */
  #buildArgs(language: string | undefined, prompt: string | undefined): string[] {
    const args: string[] = ['--model', this.#model];
    if (this.#device !== undefined) args.push('--device', this.#device);
    if (this.#computeType !== undefined) args.push('--compute-type', this.#computeType);
    if (language !== undefined) args.push('--language', language);
    if (this.#beamSize !== undefined) args.push('--beam-size', String(this.#beamSize));
    if (this.#vadFilter === true) args.push('--vad-filter');
    if (prompt !== undefined) args.push('--initial-prompt', prompt);
    return args;
  }
}

/**
 * 把若干 PcmChunk 拼成一个 16-bit PCM WAV(RIFF/WAVE)字节流。
 * 采样率优先取首块(实际录音参数),回落到 fallback;声道取首块(应为 1)。
 * (与 openai-compat-stt 的 encodeWav 同形,独立持有避免跨文件耦合。)
 */
function encodeWav(chunks: readonly PcmChunk[], fallbackRate: number): Uint8Array {
  const sampleRate = chunks[0]?.sampleRate ?? fallbackRate;
  const channels = chunks[0]?.channels ?? 1;
  let total = 0;
  for (const c of chunks) total += c.samples.length;

  const bytesPerSample = 2;
  const dataBytes = total * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk 大小
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true); // byte rate
  view.setUint16(32, channels * bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.samples.length; i++) {
      view.setInt16(offset, c.samples[i] ?? 0, true);
      offset += 2;
    }
  }
  return new Uint8Array(buf);
}

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}
