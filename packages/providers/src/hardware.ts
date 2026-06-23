/**
 * 硬件能力共享类型 + profile→默认解析 helper(C1 接缝先行,§5.10 C1 / §5.6 / §4.3)。
 *
 * 背景(`docs/embedded-lightweight-findings-2026-06-23.md`):**量化绑 profile 非 backend**——
 * 同一 backend(faster-whisper / openai-compat / kokoro …)在不同硬件档跑不同 `computeType`/`device`,
 * 故把"档 → 默认 device/computeType"收成纯函数解析,各 Provider config **统一补可选** `device`/`computeType`,
 * 留 `--target pc|raspberry|browser` 的 profile→config 解析接缝。
 *
 * **本切片只埋字段与 helper,不接 cli、不接 profile gate 消费**(那是以后串行步,§5.10 C1)。
 * 字段均**可选、纯加法**:省略时各 config/工厂行为与现状完全一致(向后兼容)。
 */

/**
 * 部署硬件档(profile gate `--target pc|raspberry|browser`,§5.6)。
 * - `pc`:有独显的台式/笔记本(CUDA + float16);
 * - `raspberry`:树莓派等嵌入式 ARM(纯 CPU + int8 量化);
 * - `browser`:浏览器/WASM(纯 CPU + int8)。
 */
export type HardwareProfile = 'pc' | 'raspberry' | 'browser';

/**
 * 计算设备(沿用 STT whisper-local 现有命名 faster-whisper `device`)。
 * `auto` = 由引擎自动探测(如 sherpa-onnx `provider=cuda/cpu` 自检、faster-whisper `device=auto`)。
 */
export type Device = 'cpu' | 'cuda' | 'auto';

/**
 * 计算精度 / 量化档(沿用 STT whisper-local 现有命名 faster-whisper `compute_type`,并补 `int8_float16`)。
 * - `int8`:嵌入式/CPU 首选(体积≈1/4,近无损);
 * - `float16`:有 CUDA 时常用;
 * - `int8_float16`:权重 int8 + 计算 float16(faster-whisper 混合档,GPU 省显存);
 * - `float32`:全精度兜底。
 */
export type ComputeType = 'int8' | 'float16' | 'int8_float16' | 'float32';

/** profile 默认解析产物:一档对应的默认 device + computeType。 */
export interface HardwareDefaults {
  readonly device: Device;
  readonly computeType: ComputeType;
}

/**
 * 各 profile 的默认 device/computeType(纯数据表;若需可配,改此表即可)。
 * 依据 `embedded-lightweight-findings`:pc→{cuda,float16}、raspberry/browser→{cpu,int8}。
 */
const PROFILE_DEFAULTS: { readonly [P in HardwareProfile]: HardwareDefaults } = {
  pc: { device: 'cuda', computeType: 'float16' },
  raspberry: { device: 'cpu', computeType: 'int8' },
  browser: { device: 'cpu', computeType: 'int8' },
};

/**
 * profile → 默认 device/computeType(纯函数,无副作用)。
 * `pc→{cuda,float16}`、`raspberry→{cpu,int8}`、`browser→{cpu,int8}`。
 */
export function resolveHardwareDefaults(profile: HardwareProfile): HardwareDefaults {
  return PROFILE_DEFAULTS[profile];
}

/** {@link applyHardwareDefaults} 关心的硬件能力字段子集(各 config 都含的可选交集)。 */
export interface HardwareFields {
  readonly device?: Device;
  readonly computeType?: ComputeType;
}

/**
 * 把 profile 默认**填进未显式指定的** device/computeType(显式值优先;纯加法、纯函数)。
 *
 * 语义:逐字段合并——`cfg` 已显式给的字段原样保留,**仅缺失字段**用 profile 默认补齐。
 * exactOptionalPropertyTypes 合规:此处两字段恒被 profile 默认覆盖,产物必有值,绝不写 `undefined`。
 *
 * **本切片不被 cli/profile gate 消费**——仅作以后 `--target` 解析的接缝 helper。
 */
export function applyHardwareDefaults<T extends HardwareFields>(
  cfg: T,
  profile: HardwareProfile,
): T & HardwareDefaults {
  const defaults = resolveHardwareDefaults(profile);
  return {
    ...cfg,
    device: cfg.device ?? defaults.device,
    computeType: cfg.computeType ?? defaults.computeType,
  };
}
