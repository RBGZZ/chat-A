/**
 * 真推理 session 工厂 —— 把 sherpa-onnx 的同步声学推理包成 voice-detect 的注入端口。
 *
 * **隔离纪律(沿用 `node-audio-device.ts`)**:本文件**不**把 sherpa-onnx 写进 client 的 dependencies,
 * 也**不**在本环境跑真模型。原生库经**动态 import + 鸭子类型**在运行时按需加载;装不上 / 形状不符时
 * 抛**明确中文错误**(提示装哪个包、需 C++ 工具链 / 需补薄适配),绝不静默错配。
 *
 * 产物:`createSherpaVadSession` / `createSherpaEouSession` 各返回一个实现
 * {@link VadInferenceSession} / {@link EouInferenceSession} 的对象(`infer(Float32Array)->number` + `reset()`)。
 * 真 `SileroVadDetector` / `SmartTurnEouModel` 注入它即生效,**零改 VoiceLoop**。
 *
 * 鸭子类型:我们只假定库**某处**暴露一个「吃一窗 16k mono PCM(Float32)同步返回概率(number)」的可调用面
 * (顶层函数 / `default` / 具名 `infer`/`compute`/`run` 方法 / 工厂返回带该方法的对象)。
 * 返回值类型即 voice-detect 端口接口,**不暴露任何 sherpa-onnx / onnxruntime 原生类型**(最小面)。
 *
 * 重要假设(sherpa-onnx-node 真 API 形状未定,见 design.md 决策 3):
 *   sherpa 真实的 VAD/EOU API 很可能是 `Vad` / `CircularBuffer` + `acceptWaveform`/`isSpeechDetected` 的
 *   **流式 buffer** 语义,而非这里假定的「一窗一概率」纯函数。若如此,本模块的鸭子挑选会挑不到 → 抛明确错误,
 *   提示用户在**此处**补一个把 sherpa 句柄桥接成 `infer(window)->prob` 的薄适配(改这一处即可)。
 *   真形状以用户 PC 手测为准;CI 用鸭子类型假模块验证「装配 / 失败回落」接缝。
 */
import {
  DEFAULT_VAD_INFERENCE,
  DEFAULT_EOU_INFERENCE,
  type VadInferenceSession,
  type EouInferenceSession,
} from '@chat-a/voice-detect';

/** 默认要动态加载的 sherpa-onnx Node 绑定模块名(可经构造参数 / env 覆盖)。 */
export const DEFAULT_SHERPA_MODULE = 'sherpa-onnx-node';
/** 覆盖 sherpa 模块名的环境变量(沿用 CHAT_A_AUDIO_MODULE 范式)。 */
export const SHERPA_MODULE_ENV = 'CHAT_A_SHERPA_MODULE';

/** 鸭子类型:一个「吃一窗 PCM 同步返回概率」的可调用面。 */
type ProbInferer = (samples: Float32Array) => number;

/** 注入式动态 import(缺省走原生 `import()`;测试可注入假模块加载器)。 */
type Importer = (moduleName: string) => Promise<unknown>;

export interface SherpaSessionOptions {
  /** 要动态 import 的模块名;缺省经 env `CHAT_A_SHERPA_MODULE`,再缺省 `sherpa-onnx-node`。 */
  readonly nativeModule?: string;
  /** 注入式模块加载器(仅测试用;缺省 `import(/* @vite-ignore *\/ name)`)。 */
  readonly importer?: Importer;
  /** 读取 env(缺省 `process.env`)。 */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * 解析模块名:显式参数 > env > 默认。
 */
function resolveModuleName(opts: SherpaSessionOptions): string {
  const env = opts.env ?? process.env;
  return opts.nativeModule ?? env[SHERPA_MODULE_ENV] ?? DEFAULT_SHERPA_MODULE;
}

/**
 * 动态加载模块并鸭子挑出推理面;装不上 / 形状不符 → 抛明确中文错误。
 * `what` 仅用于错误文案(区分 VAD / EOU)。
 */
async function loadProbInferer(opts: SherpaSessionOptions, what: string): Promise<ProbInferer> {
  const moduleName = resolveModuleName(opts);
  const importer: Importer =
    opts.importer ?? ((name) => import(/* @vite-ignore */ name));
  let mod: unknown;
  try {
    mod = await importer(moduleName);
  } catch (err) {
    throw new Error(
      `未能加载真 ${what} 推理库 "${moduleName}":请先安装(如 \`pnpm add -w ${moduleName}\`,` +
        `需本机有 C++ 构建工具链);或不设 CHAT_A_VAD(缺省走确定性桩)。原始错误:${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const inferer = pickProbInferer(mod);
  if (inferer === null) {
    throw new Error(
      `${what} 推理库 "${moduleName}" 已加载,但鸭子类型未挑到「吃 Float32Array 一窗、同步返回概率」的推理面。` +
        `sherpa-onnx 的真 VAD/EOU 多为 Vad/CircularBuffer 流式 buffer API(非一窗一概率),` +
        `请在 client/src/audio/sherpa-vad-session.ts 的 pickProbInferer 处补一个把其句柄桥接成 infer(window)->prob 的薄适配。`,
    );
  }
  return inferer;
}

/**
 * 构造真 VAD 同步推理端口(注入给 `SileroVadDetector`)。
 * 鸭子把 sherpa 推理面包成 `infer(Float32Array)->number` + `reset()`;不暴露原生类型。
 */
export async function createSherpaVadSession(
  opts: SherpaSessionOptions = {},
): Promise<VadInferenceSession> {
  const inferer = await loadProbInferer(opts, 'VAD');
  // 采样率仅作记录/未来扩展;真窗口大小由 SileroVadDetector 按 config(默认 512)缓冲后整窗喂入。
  void DEFAULT_VAD_INFERENCE;
  return {
    infer(samples: Float32Array): number {
      return clampProb(inferer(samples));
    },
    reset(): void {
      // 鸭子推理面无显式 reset(Silero RNN 隐状态由底层维护);若底层暴露 reset 可在此调用。
    },
  };
}

/**
 * 构造真 EOU 同步推理端口(注入给 `SmartTurnEouModel`)。
 */
export async function createSherpaEouSession(
  opts: SherpaSessionOptions = {},
): Promise<EouInferenceSession> {
  const inferer = await loadProbInferer(opts, 'EOU');
  void DEFAULT_EOU_INFERENCE;
  return {
    infer(samples: Float32Array): number {
      return clampProb(inferer(samples));
    },
    reset(): void {
      // 同上:窗时长/截窗由 SmartTurnEouModel 按 config 处理。
    },
  };
}

/** 把任意数值钳到 [0,1] 概率(防底层返回 logit/越界值污染下游去抖/endpointing)。 */
function clampProb(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * 鸭子挑选:从动态 import 的模块里挑出「吃 Float32Array 同步返回 number」的推理面。
 * 容错覆盖常见导出布局:顶层函数 / `default`(函数或对象)/ 具名方法 `infer`/`compute`/`run`/
 * 工厂返回带该方法的对象。挑不到返回 null(由调用方抛明确错误)。
 */
function pickProbInferer(mod: unknown): ProbInferer | null {
  const methodNames = ['infer', 'compute', 'run', 'predict'] as const;

  // 顶层就是函数(直接当推理面)。
  if (typeof mod === 'function') return mod as ProbInferer;

  if (mod && typeof mod === 'object') {
    const m = mod as Record<string, unknown>;
    // 顶层具名方法。
    for (const name of methodNames) {
      const fn = m[name];
      if (typeof fn === 'function') return bindInferer(fn as (s: Float32Array) => number, m);
    }
    // default 导出(esm interop):函数 / 带具名方法的对象。
    const d = m['default'];
    if (typeof d === 'function') return d as ProbInferer;
    if (d && typeof d === 'object') {
      const dm = d as Record<string, unknown>;
      for (const name of methodNames) {
        const fn = dm[name];
        if (typeof fn === 'function') return bindInferer(fn as (s: Float32Array) => number, dm);
      }
    }
  }
  return null;
}

/** 绑定方法到其宿主对象(保留 `this`),返回纯 `infer(samples)->number`。 */
function bindInferer(fn: (s: Float32Array) => number, host: object): ProbInferer {
  return (samples: Float32Array) => fn.call(host, samples) as number;
}
