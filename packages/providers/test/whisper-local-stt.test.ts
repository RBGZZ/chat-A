import { describe, it, expect } from 'vitest';
import {
  WhisperLocalStt,
  createStt,
  pcmChunk,
  STT_SAMPLE_RATE_HZ,
} from '../src/index';
import type { PcmChunk, SpawnResult, SpawnFn } from '../src/index';

/** 把若干 PcmChunk 包成 AsyncIterable(模拟麦克风流)。 */
async function* streamOf(...chunks: PcmChunk[]): AsyncIterable<PcmChunk> {
  for (const c of chunks) yield c;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

function chunkSecs(secs: number): PcmChunk {
  return pcmChunk(new Int16Array(Math.round(STT_SAMPLE_RATE_HZ * secs)), STT_SAMPLE_RATE_HZ);
}

/** 记录调用的假 SpawnFn 工厂:返回固定结果,并把收到的 wav/args 暴露给断言。 */
function fakeSpawn(result: SpawnResult): {
  fn: SpawnFn;
  calls: { input: Uint8Array; args: readonly string[] }[];
} {
  const calls: { input: Uint8Array; args: readonly string[] }[] = [];
  const fn: SpawnFn = async (input, args) => {
    calls.push({ input, args });
    return result;
  };
  return { fn, calls };
}

describe('WhisperLocalStt(注入式 SpawnFn → 单条 final)', () => {
  it('假 SpawnFn 返回固定文本 → 产对应 SttResult(isFinal:true)', async () => {
    const { fn } = fakeSpawn({ stdout: '  你好世界  ', code: 0 });
    const stt = new WhisperLocalStt({ id: 'whisper-local', model: 'large-v3', spawn: fn });
    const results = await collect(stt.transcribe(streamOf(chunkSecs(1.0)), { language: 'zh' }));
    expect(results).toEqual([{ text: '你好世界', isFinal: true, language: 'zh' }]);
  });

  it('非流式能力声明:streaming=false,16kHz', () => {
    const { fn } = fakeSpawn({ stdout: 'x', code: 0 });
    const stt = new WhisperLocalStt({ id: 'whisper-local', model: 'm', spawn: fn });
    expect(stt.capabilities.streaming).toBe(false);
    expect(stt.capabilities.sampleRate).toBe(STT_SAMPLE_RATE_HZ);
  });

  it('把音频汇成 WAV 喂子进程(input 以 RIFF/WAVE 开头,含 data 帧)', async () => {
    const { fn, calls } = fakeSpawn({ stdout: 'ok', code: 0 });
    const stt = new WhisperLocalStt({ id: 'whisper-local', model: 'm', spawn: fn });
    await collect(stt.transcribe(streamOf(chunkSecs(0.1), chunkSecs(0.1))));
    const wav = calls[0]?.input as Uint8Array;
    // RIFF....WAVE 头(前 4 字节 'RIFF',8..12 'WAVE')。
    const ascii = (a: Uint8Array, o: number, n: number) =>
      String.fromCharCode(...Array.from(a.subarray(o, o + n)));
    expect(ascii(wav, 0, 4)).toBe('RIFF');
    expect(ascii(wav, 8, 4)).toBe('WAVE');
    // 0.2s @16k mono s16le ≈ 3200 样本 * 2 字节 = 6400 data 字节 + 44 头。
    expect(wav.length).toBe(44 + 3200 * 2);
  });

  it('按 config 拼 CLI 参数(model/device/computeType/language/beamSize/vadFilter/prompt)', async () => {
    const { fn, calls } = fakeSpawn({ stdout: 'ok', code: 0 });
    const stt = new WhisperLocalStt({
      id: 'whisper-local',
      model: 'large-v3',
      spawn: fn,
      device: 'cuda',
      computeType: 'float16',
      beamSize: 5,
      vadFilter: true,
    });
    await collect(stt.transcribe(streamOf(chunkSecs(0.1)), { language: 'zh', prompt: '小雪' }));
    expect(calls[0]?.args).toEqual([
      '--model',
      'large-v3',
      '--device',
      'cuda',
      '--compute-type',
      'float16',
      '--language',
      'zh',
      '--beam-size',
      '5',
      '--vad-filter',
      '--initial-prompt',
      '小雪',
    ]);
  });

  it('自定义 textParser:解析 JSON stdout 取 text', async () => {
    const { fn } = fakeSpawn({ stdout: '{"text":"解析出来的"}', code: 0 });
    const stt = new WhisperLocalStt({
      id: 'whisper-local',
      model: 'm',
      spawn: fn,
      textParser: (s) => (JSON.parse(s) as { text: string }).text,
    });
    const results = await collect(stt.transcribe(streamOf(chunkSecs(0.5))));
    expect(results[0]?.text).toBe('解析出来的');
  });

  it('子进程非 0 退出 → 容错抛带 code/stderr 的 Error', async () => {
    const { fn } = fakeSpawn({ stdout: '', stderr: 'model not found', code: 1 });
    const stt = new WhisperLocalStt({ id: 'whisper-local', model: 'm', spawn: fn });
    await expect(collect(stt.transcribe(streamOf(chunkSecs(0.5))))).rejects.toThrow(
      /非 0 退出.*code=1.*model not found/,
    );
  });

  it('子进程端口本身抛错 → 容错为带上下文的 Error', async () => {
    const fn: SpawnFn = async () => {
      throw new Error('ENOENT spawn whisper');
    };
    const stt = new WhisperLocalStt({ id: 'whisper-local', model: 'm', spawn: fn });
    await expect(collect(stt.transcribe(streamOf(chunkSecs(0.5))))).rejects.toThrow(
      /子进程调用失败.*ENOENT/,
    );
  });

  it('能力门:限定语种 + 外语种 → 起子进程前 fail-fast', async () => {
    const { fn, calls } = fakeSpawn({ stdout: 'x', code: 0 });
    const stt = new WhisperLocalStt({ id: 'whisper-local', model: 'm', spawn: fn, languages: ['en'] });
    await expect(collect(stt.transcribe(streamOf(chunkSecs(0.5)), { language: 'zh' }))).rejects.toThrow(
      /不支持语种 "zh"/,
    );
    expect(calls.length).toBe(0); // 未起子进程。
  });

  it('缺 spawn 端口 → 构造即 fail-fast(明确"需运行时提供 spawn")', () => {
    expect(
      () => new WhisperLocalStt({ id: 'whisper-local', model: 'm', spawn: undefined as unknown as SpawnFn }),
    ).toThrow(/需运行时提供 spawn 端口/);
  });
});

describe('createStt 注入端口(工厂层)', () => {
  it('注入 spawn → 建真适配并能转写', async () => {
    const { fn } = fakeSpawn({ stdout: 'hi', code: 0 });
    const stt = createStt({ kind: 'whisper-local', id: 'fw', model: 'large-v3' }, { spawn: fn });
    expect(stt).toBeInstanceOf(WhisperLocalStt);
    expect(stt.id).toBe('fw');
    const results = await collect(stt.transcribe(streamOf(chunkSecs(0.5))));
    expect(results[0]).toMatchObject({ text: 'hi', isFinal: true });
  });

  it('未注入 spawn → 明确报错(非崩)', () => {
    expect(() => createStt({ kind: 'whisper-local', model: 'm' })).toThrow(/需运行时提供 spawn 端口/);
  });
});
