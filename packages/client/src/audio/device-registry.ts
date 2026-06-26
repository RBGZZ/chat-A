// packages/client/src/audio/device-registry.ts
/**
 * 音频设备枚举 + 按名解析（纯函数；注入 naudiodon 模块的 getDevices 以可单测）。
 * 设备**只用名字持久化**（数字 id 不稳定：插拔/重启/改默认会变）；启动按名重解析当前 id。
 */

export interface AudioDeviceInfo {
  /** 当前 PortAudio id（仅本进程有效，不持久化）。 */
  readonly id: number;
  /** 设备名（持久化用这个）。 */
  readonly name: string;
  /** hostAPIName（同一物理设备在 MME/WASAPI 各出现一次，用于消歧）。 */
  readonly hostApi: string;
  readonly maxInputChannels: number;
  readonly maxOutputChannels: number;
  /** 设备原生采样率 → 启动时自动推导开流率（设备只用「名字」标识，采集率随名解析到的设备走，免手配）。 */
  readonly defaultSampleRate: number;
}

function num(v: unknown, dflt = 0): number {
  // null/undefined/空串先回落默认:否则 Number(null)/Number('') === 0 会吞掉默认值
  // (如 defaultSampleRate 缺失被算成 0,而非回落 16000)。
  if (v === null || v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** 从注入模块取原始设备数组（鸭子类型，缺失/异常一律空数组，降级不崩）。 */
function rawDevices(mod: unknown): Array<Record<string, unknown>> {
  if (mod === null || typeof mod !== 'object') return [];
  const m = mod as { getDevices?: unknown; default?: { getDevices?: unknown } };
  // esm interop:naudiodon 经 ESM import CJS 时 getDevices 可能落在 .default
  // (对齐同目录 node-audio-device.ts pickAudioIoFactory 的处理);先试顶层,再回落 .default。
  const fn = typeof m.getDevices === 'function' ? m.getDevices : m.default?.getDevices;
  if (typeof fn !== 'function') return [];
  try {
    const list = (fn as () => unknown)();
    return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

function toInfo(d: Record<string, unknown>): AudioDeviceInfo {
  return {
    id: num(d['id'], -1),
    name: String(d['name'] ?? ''),
    hostApi: String(d['hostAPIName'] ?? ''),
    maxInputChannels: num(d['maxInputChannels']),
    maxOutputChannels: num(d['maxOutputChannels']),
    defaultSampleRate: num(d['defaultSampleRate'], 16000),
  };
}

export function listInputDevices(mod: unknown): AudioDeviceInfo[] {
  return rawDevices(mod).map(toInfo).filter((d) => d.maxInputChannels > 0);
}

export function listOutputDevices(mod: unknown): AudioDeviceInfo[] {
  return rawDevices(mod).map(toInfo).filter((d) => d.maxOutputChannels > 0);
}

/**
 * 按设备名解析当前 id（同名用 hostApi 消歧；仍歧义取第一个）。未命中返回 null。
 */
export function resolveDeviceByName(
  devices: readonly AudioDeviceInfo[],
  name: string,
  hostApi?: string,
): AudioDeviceInfo | null {
  const byName = devices.filter((d) => d.name === name);
  if (byName.length === 0) return null;
  if (hostApi !== undefined && hostApi.length > 0) {
    const exact = byName.find((d) => d.hostApi === hostApi);
    if (exact) return exact;
  }
  // 仍歧义(同名多条 / 指定 hostApi 未精确命中)→ 取第一个并 warn(对齐 design §4)。
  if (byName.length > 1) {
    console.warn(
      `[设备] 同名设备「${name}」有 ${byName.length} 条${hostApi ? `(指定 hostApi=${hostApi} 未精确命中)` : ''},` +
        `取第一个(hostApi=${byName[0]!.hostApi});如需指定请设 *_DEVICE_HOST 消歧。`,
    );
  }
  return byName[0]!;
}
