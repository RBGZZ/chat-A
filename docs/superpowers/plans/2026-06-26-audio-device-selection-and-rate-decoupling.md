# 音频设备选择 + 采样率修复与能力驱动解耦 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 开机枚举输入/输出音频设备让用户选择（存设备名、CLI 菜单 + desktop 下拉框），修复输入/输出 deviceId 串用与降采样混叠乱码，并让采集采样率由 provider 能力声明驱动（STT/omni 解耦）。

**Architecture:** 在 `packages/client/src/audio` 新增两个纯函数模块（`device-registry` 枚举/按名解析、`resample` 抗混叠重采样），`NodeAudioDevice` 消费它们；装配层 `cli-voice.ts` 据 provider 能力声明决定重采样目标率并按设备名解析当前 id；CLI 与 desktop 各接一个选择壳，共享 client 内核。omni 路对称解耦（端口声明输入率 + model/turn_detection 配置化）。

**Tech Stack:** TypeScript（pnpm workspace），测试 vitest，Electron（desktop），naudiodon（原生音频，鸭子类型注入）。

## Global Constraints

- 包管理器 `pnpm@11.8.0`；测试 `pnpm vitest run <file>`；类型检查 `pnpm typecheck`。
- 文档与注释用**中文**（项目约定）。
- §3.2 优雅降级：所有新路径在失败/缺设备/非交互环境**绝不崩、绝不哑**，回退系统默认设备(-1) + 明确中文提示。
- exactOptionalPropertyTypes：可选字段**缺席即不写键**，绝不显式赋 `undefined`。
- 纯函数核与副作用壳分离（接缝可单测，不 import electron 到纯逻辑）。
- 不改 VAD/EOU 的 16k 硬约束；VAD/EOU 永远拿抗混叠后的 16k。
- 设备**只存名字**（`CHAT_A_AUDIO_*_DEVICE_NAME`，可选 `_HOST`），不存数字 id；数字 id env（`CHAT_A_AUDIO_INPUT_DEVICE_ID`/`_OUTPUT_DEVICE_ID`/`_CAPTURE_RATE`）保留为显式覆盖逃生口。
- omni 默认 model = `qwen3.5-omni-flash-realtime`，默认 turn_detection = `semantic_vad`（均可经 env 覆盖）。
- 复用既有 `upsertEnvLocal(text, key, value)`（ipc-contract.ts 导出）做 `.env.local` 写回，逐键覆盖幂等。

---

## 任务依赖与并行分组（供并行派发参考）

- **Phase 1（无依赖，可并行）**：Task 1（resample）、Task 2（device-registry）、Task 5a（OmniAudioPort.inputSampleRate）、Task 5b（QwenOmniLlm 解耦）、Task 8（desktop IPC 纯逻辑）
- **Phase 2（依赖 Phase 1）**：Task 3（NodeAudioDevice，依赖 1+2）、Task 5c（createOmniAudioPort，依赖 5a+5b）、Task 9（desktop main/preload，依赖 8）、Task 10（desktop renderer，依赖 8）
- **Phase 3（依赖 Phase 2）**：Task 6（createAudioDevice 解析流程，依赖 2+3+5c）
- **Phase 4（依赖 Phase 3）**：Task 7（CLI 选择菜单，依赖 6）
- **Phase 5（收尾，依赖全部）**：Task 11（清理诊断日志）

---

### Task 1: 抗混叠重采样 `resample.ts`（纯函数，修 bug2）

**Files:**
- Create: `packages/client/src/audio/resample.ts`
- Test: `packages/client/test/resample.test.ts`

**Interfaces:**
- Produces:
  - `export function resampleSinc(input: Int16Array, inRate: number, outRate: number): Int16Array` — 带低通的窗口 sinc 重采样；`inRate===outRate` 时返回拷贝；输出长度 `round(input.length * outRate/inRate)`。
  - `export const RESAMPLE_HALF_TAPS = 16` — 核半宽（供调用方做跨帧 carry 用）。

- [ ] **Step 1: 写失败测试**

```typescript
// packages/client/test/resample.test.ts
import { describe, it, expect } from 'vitest';
import { resampleSinc } from '../src/audio/resample';

/** 生成 rate Hz 下 freq Hz 的正弦，n 样本，幅度 a（Int16）。 */
function tone(freq: number, rate: number, n: number, a = 8000): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(a * Math.sin((2 * Math.PI * freq * i) / rate));
  return out;
}
/** 在 rate 下用朴素 DFT 估某频点幅度（仅测试用，小 n）。 */
function mag(x: Int16Array, freq: number, rate: number): number {
  let re = 0, im = 0;
  for (let i = 0; i < x.length; i++) {
    const p = (2 * Math.PI * freq * i) / rate;
    re += x[i]! * Math.cos(p); im -= x[i]! * Math.sin(p);
  }
  return Math.sqrt(re * re + im * im) / x.length;
}

describe('resampleSinc', () => {
  it('恒等率返回等值拷贝', () => {
    const x = tone(1000, 16000, 320);
    const y = resampleSinc(x, 16000, 16000);
    expect(y).not.toBe(x);
    expect(Array.from(y)).toEqual(Array.from(x));
  });

  it('输出长度按比例', () => {
    const x = tone(1000, 48000, 480);
    expect(resampleSinc(x, 48000, 16000).length).toBe(160);
  });

  it('48k→16k：低频(1kHz)保留、超奈奎斯特(10kHz)被抗混叠压制(不折回6kHz)', () => {
    const N = 4800; // 0.1s @48k
    const low = resampleSinc(tone(1000, 48000, N), 48000, 16000);
    const high = resampleSinc(tone(10000, 48000, N), 48000, 16000);
    // 1kHz 在输出里仍有明显能量
    const lowMag = mag(low, 1000, 16000);
    // 10kHz>8k 输出奈奎斯特：劣质降采样会折回 16000-10000=6000Hz；抗混叠后该处应很弱
    const aliasMag = mag(high, 6000, 16000);
    expect(lowMag).toBeGreaterThan(500);
    expect(aliasMag).toBeLessThan(lowMag * 0.1); // 混叠分量 < 低频能量 10%
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/client/test/resample.test.ts`
Expected: FAIL（`resampleSinc` 未定义 / 模块不存在）

- [ ] **Step 3: 实现**

```typescript
// packages/client/src/audio/resample.ts
/**
 * 抗混叠重采样（窗口 sinc / band-limited 插值）—— 替换裸线性插值，消除降采样混叠（修 bug2）。
 * 低通截止 = 较低采样率的奈奎斯特（归一 cutoff=min(1, outRate/inRate)），故升/降采样皆抗混叠。
 * 纯函数、无依赖、嵌入式友好（定长核、O(n*taps)）。
 */

/** 核半宽：taps = 2*HALF+1。16 对语音足够（过渡带陡度 vs 计算量折中）。 */
export const RESAMPLE_HALF_TAPS = 16;

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}
/** Blackman 窗（[-half, half] 上），抑制旁瓣。 */
function blackman(n: number, half: number): number {
  const t = (n + half) / (2 * half); // 映射到 [0,1]
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
}
function clampInt16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

export function resampleSinc(input: Int16Array, inRate: number, outRate: number): Int16Array {
  if (inRate === outRate) return Int16Array.from(input);
  const inLen = input.length;
  if (inLen === 0) return new Int16Array(0);
  const ratio = outRate / inRate;
  const outLen = Math.max(1, Math.round(inLen * ratio));
  const out = new Int16Array(outLen);
  const cutoff = Math.min(1, ratio); // 归一截止（较低率的奈奎斯特）
  const half = RESAMPLE_HALF_TAPS;
  for (let i = 0; i < outLen; i++) {
    const center = i / ratio; // 对应输入样本位置
    const left = Math.ceil(center - half);
    const right = Math.floor(center + half);
    let acc = 0;
    let wsum = 0;
    for (let j = left; j <= right; j++) {
      const xi = j < 0 ? 0 : j >= inLen ? inLen - 1 : j; // 边界 clamp
      const t = center - j;
      const w = sinc(cutoff * t) * cutoff * blackman(t, half);
      acc += input[xi]! * w;
      wsum += w;
    }
    out[i] = clampInt16(Math.round(wsum !== 0 ? acc / wsum : acc));
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/client/test/resample.test.ts`
Expected: PASS（3 个用例全绿）

- [ ] **Step 5: 提交**

```bash
git add packages/client/src/audio/resample.ts packages/client/test/resample.test.ts
git commit -m "feat(voice): 抗混叠窗口sinc重采样(替换裸线性插值,修降采样混叠乱码bug2)"
```

---

### Task 2: 设备枚举/按名解析 `device-registry.ts`（纯函数）

**Files:**
- Create: `packages/client/src/audio/device-registry.ts`
- Test: `packages/client/test/device-registry.test.ts`

**Interfaces:**
- Produces:
  - `export interface AudioDeviceInfo { id: number; name: string; hostApi: string; maxInputChannels: number; maxOutputChannels: number; defaultSampleRate: number; }`
  - `export interface NativeDevicesModule { getDevices?: () => Array<Record<string, unknown>>; }`
  - `export function listInputDevices(mod: unknown): AudioDeviceInfo[]`
  - `export function listOutputDevices(mod: unknown): AudioDeviceInfo[]`
  - `export function resolveDeviceByName(devices: readonly AudioDeviceInfo[], name: string, hostApi?: string): AudioDeviceInfo | null`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/client/test/device-registry.test.ts
import { describe, it, expect } from 'vitest';
import { listInputDevices, listOutputDevices, resolveDeviceByName } from '../src/audio/device-registry';

const fakeMod = {
  getDevices: () => [
    { id: 0, name: '麦克风 (Realtek)', hostAPIName: 'MME', maxInputChannels: 2, maxOutputChannels: 0, defaultSampleRate: 44100 },
    { id: 8, name: '麦克风阵列 (Intel)', hostAPIName: 'WASAPI', maxInputChannels: 4, maxOutputChannels: 0, defaultSampleRate: 48000 },
    { id: 3, name: '扬声器 (Realtek)', hostAPIName: 'MME', maxInputChannels: 0, maxOutputChannels: 2, defaultSampleRate: 48000 },
    { id: 9, name: '麦克风阵列 (Intel)', hostAPIName: 'MME', maxInputChannels: 2, maxOutputChannels: 0, defaultSampleRate: 44100 },
  ],
};

describe('device-registry', () => {
  it('listInputDevices 只留有输入通道的，字段映射正确', () => {
    const ins = listInputDevices(fakeMod);
    expect(ins.map((d) => d.id).sort((a, b) => a - b)).toEqual([0, 8, 9]);
    const intel = ins.find((d) => d.id === 8)!;
    expect(intel).toMatchObject({ name: '麦克风阵列 (Intel)', hostApi: 'WASAPI', defaultSampleRate: 48000 });
  });

  it('listOutputDevices 只留有输出通道的', () => {
    expect(listOutputDevices(fakeMod).map((d) => d.id)).toEqual([3]);
  });

  it('resolveDeviceByName 命中返回当前 id', () => {
    const ins = listInputDevices(fakeMod);
    expect(resolveDeviceByName(ins, '麦克风 (Realtek)')!.id).toBe(0);
  });

  it('resolveDeviceByName 同名用 hostApi 消歧', () => {
    const ins = listInputDevices(fakeMod);
    expect(resolveDeviceByName(ins, '麦克风阵列 (Intel)', 'WASAPI')!.id).toBe(8);
    expect(resolveDeviceByName(ins, '麦克风阵列 (Intel)', 'MME')!.id).toBe(9);
  });

  it('resolveDeviceByName 未命中返回 null', () => {
    expect(resolveDeviceByName(listInputDevices(fakeMod), '不存在的设备')).toBeNull();
  });

  it('mod 无 getDevices 时返回空数组（降级不崩）', () => {
    expect(listInputDevices({})).toEqual([]);
    expect(listInputDevices(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/client/test/device-registry.test.ts`
Expected: FAIL（模块/导出不存在）

- [ ] **Step 3: 实现**

```typescript
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
  /** 设备原生采样率 → 自动推导开流率（免用户配 CHAT_A_AUDIO_CAPTURE_RATE）。 */
  readonly defaultSampleRate: number;
}

function num(v: unknown, dflt = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** 从注入模块取原始设备数组（鸭子类型，缺失/异常一律空数组，降级不崩）。 */
function rawDevices(mod: unknown): Array<Record<string, unknown>> {
  if (mod === null || typeof mod !== 'object') return [];
  const fn = (mod as { getDevices?: unknown }).getDevices;
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
  return byName[0]!;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/client/test/device-registry.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client/src/audio/device-registry.ts packages/client/test/device-registry.test.ts
git commit -m "feat(voice): 音频设备枚举+按名解析内核(存名不存id,hostApi消歧)"
```

---

### Task 3: `NodeAudioDevice` — 输入/输出 deviceId 分离(bug1) + 抗混叠重采样 + 枚举复用

**Files:**
- Modify: `packages/client/src/audio/node-audio-device.ts`
- Test: `packages/client/test/node-audio-device.test.ts`（新建）

**Interfaces:**
- Consumes: `resampleSinc`, `RESAMPLE_HALF_TAPS`（Task 1）；`listInputDevices`（Task 2）。
- Produces:
  - `NodeAudioDeviceOptions` 新增 `readonly outputDeviceId?: number;`
  - `NodeAudioDevice` 输出流用 `#outputDeviceId`（缺省 -1）；采集帧用 `resampleSinc(inSamples, deviceCaptureRate, captureRate)`（带跨帧 carry）。

- [ ] **Step 1: 写失败测试**（注入假 factory，断言输入/输出用不同 deviceId）

```typescript
// packages/client/test/node-audio-device.test.ts
import { describe, it, expect } from 'vitest';
import { NodeAudioDevice } from '../src/audio/node-audio-device';

// 记录每次开流用的 options，供断言。
function makeSpyModule() {
  const opens: Array<{ inOptions?: any; outOptions?: any }> = [];
  const AudioIO = (opts: any) => {
    opens.push(opts);
    return { on() {}, start() {}, write() {}, quit() {} };
  };
  return { mod: { AudioIO, getDevices: () => [] }, opens };
}

describe('NodeAudioDevice 输入/输出 deviceId 分离 (bug1)', () => {
  it('采集用 inputDeviceId、播放用 outputDeviceId（不串用）', async () => {
    const { mod, opens } = makeSpyModule();
    const dev = new NodeAudioDevice({ nativeModule: 'x', deviceId: 8, outputDeviceId: 3 } as any);
    // 注入假模块：绕过真 import（构造接受 nativeModule，但我们直接喂 factory）
    (dev as any)['#factory']; // no-op 占位
    await (dev as any).initWithModule(mod); // 见实现：测试专用注入入口
    dev.captureStart(() => {});
    dev.play({ samples: new Int16Array([1, 2, 3]), sampleRate: 24000, channels: 1 });
    const inOpen = opens.find((o) => o.inOptions);
    const outOpen = opens.find((o) => o.outOptions);
    expect(inOpen!.inOptions.deviceId).toBe(8);
    expect(outOpen!.outOptions.deviceId).toBe(3); // 关键：输出不再套用输入 id 8
  });

  it('未设 outputDeviceId 时输出缺省 -1（系统默认扬声器）', async () => {
    const { mod, opens } = makeSpyModule();
    const dev = new NodeAudioDevice({ nativeModule: 'x', deviceId: 8 } as any);
    await (dev as any).initWithModule(mod);
    dev.play({ samples: new Int16Array([1]), sampleRate: 24000, channels: 1 });
    expect(opens.find((o) => o.outOptions)!.outOptions.deviceId).toBe(-1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/client/test/node-audio-device.test.ts`
Expected: FAIL（`outputDeviceId` 未支持 / `initWithModule` 不存在 / 输出仍用 8）

- [ ] **Step 3: 实现改动**（在 `packages/client/src/audio/node-audio-device.ts`）

3a. 顶部 import 增加（替换原 `resampleLinearTo` 用法）：
```typescript
import { resampleSinc, RESAMPLE_HALF_TAPS } from './resample';
```

3b. `NodeAudioDeviceOptions` 增加字段（紧跟 `deviceId?` 之后）：
```typescript
  /** 输出设备号（PortAudio deviceId；-1 = 默认扬声器）。**与输入分离**：不设则用 -1，绝不套用输入 deviceId（修 bug1）。 */
  readonly outputDeviceId?: number;
```

3c. 类字段：在 `readonly #deviceId: number;` 后加
```typescript
  readonly #outputDeviceId: number;
  /** 跨帧重采样 carry：上一帧尾部输入样本，拼到下一帧前以消除帧边界不连续。 */
  #resampleTail: Int16Array = new Int16Array(0);
```

3d. 构造函数内 `this.#deviceId = opts.deviceId ?? -1;` 后加：
```typescript
    this.#outputDeviceId = opts.outputDeviceId ?? -1; // 缺省默认扬声器，绝不套用输入 id
```

3e. 新增**测试专用注入入口**（紧跟 `init()` 之后；真实路径仍走 `init()`）：
```typescript
  /** 测试注入入口：跳过动态 import，直接喂已加载的原生模块（仅供单测，等价 init 的后半段）。 */
  async initWithModule(mod: unknown): Promise<void> {
    const factory = pickAudioIoFactory(mod);
    if (factory === null) throw new Error('注入模块未找到 AudioIO 工厂');
    this.#factory = factory;
  }
```

3f. `#openOutput` 内把 `deviceId: this.#deviceId` 改为：
```typescript
        deviceId: this.#outputDeviceId,
```

3g. `#onCaptureBytes` 内把重采样调用从 `resampleLinearTo(inSamples, SAMPLES_PER_FRAME)` 改为带 carry 的抗混叠重采样。将原
```typescript
      const samples =
        inFrameSamples === SAMPLES_PER_FRAME ? inSamples : resampleLinearTo(inSamples, SAMPLES_PER_FRAME);
```
替换为：
```typescript
      let samples: Int16Array;
      if (this.#deviceCaptureRate === this.#captureRate) {
        samples = inSamples; // 设备率=目标率：不重采样（逐字现状）
      } else {
        // 跨帧 carry：拼上一帧尾部 → 抗混叠重采样 → 取末尾 SAMPLES_PER_FRAME（对应本帧），消帧边界毛刺。
        const withTail = this.#resampleTail.length
          ? concatInt16(this.#resampleTail, inSamples)
          : inSamples;
        const resampled = resampleSinc(withTail, this.#deviceCaptureRate, this.#captureRate);
        samples =
          resampled.length >= SAMPLES_PER_FRAME
            ? resampled.subarray(resampled.length - SAMPLES_PER_FRAME)
            : padToLen(resampled, SAMPLES_PER_FRAME);
        this.#resampleTail = inSamples.subarray(Math.max(0, inSamples.length - RESAMPLE_HALF_TAPS));
      }
```

3h. 文件底部（`pickAudioIoFactory` 旁）新增两个小工具 + 删除旧 `resampleLinearTo`：
```typescript
function concatInt16(a: Int16Array, b: Int16Array): Int16Array {
  const out = new Int16Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
function padToLen(x: Int16Array, len: number): Int16Array {
  if (x.length >= len) return x.subarray(0, len);
  const out = new Int16Array(len);
  out.set(x, 0);
  return out;
}
```
并**删除**原 `function resampleLinearTo(...) { ... }` 整段（已被 `resampleSinc` 取代）。

3i. `#stopCapture()` 内重置 carry（在 `this.#pending = Buffer.alloc(0);` 旁）：
```typescript
    this.#resampleTail = new Int16Array(0);
```

- [ ] **Step 4: 跑测试确认通过 + 不回归**

Run: `pnpm vitest run packages/client/test/node-audio-device.test.ts`
Expected: PASS
Run: `pnpm typecheck`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add packages/client/src/audio/node-audio-device.ts packages/client/test/node-audio-device.test.ts
git commit -m "fix(voice): 输入/输出deviceId分离(bug1)+采集改抗混叠重采样(带跨帧carry)"
```

---

### Task 5a: `OmniAudioPort` 声明输入采样率（runtime 类型解耦）

**Files:**
- Modify: `packages/runtime/src/voice-loop.ts`（`OmniAudioPort` 接口，约 79-85 行）

**Interfaces:**
- Produces: `OmniAudioPort` 新增 `readonly inputSampleRate?: number;`（可选；缺省由消费者回落 16000，不破坏既有结构匹配）。

- [ ] **Step 1: 写失败测试**

```typescript
// packages/runtime/test/omni-input-rate.test.ts
import { describe, it, expect } from 'vitest';
import type { OmniAudioPort } from '../src/voice-loop';

describe('OmniAudioPort.inputSampleRate', () => {
  it('端口可声明输入采样率（结构上可选）', () => {
    const port: OmniAudioPort = {
      inputSampleRate: 16000,
      async *respondToAudio() {
        yield { type: 'end' as const };
      },
    };
    expect(port.inputSampleRate).toBe(16000);
  });
  it('不声明也满足接口（向后兼容）', () => {
    const port: OmniAudioPort = {
      async *respondToAudio() {
        yield { type: 'end' as const };
      },
    };
    expect(port.inputSampleRate).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/runtime/test/omni-input-rate.test.ts`
Expected: FAIL（类型上 `inputSampleRate` 不存在，tsc 报错 / 测试编译失败）

- [ ] **Step 3: 实现**（在 `OmniAudioPort` 接口体内，`respondToAudio` 方法上方加字段）

```typescript
  /**
   * 该 omni 模型要求的输入音频采样率（Hz；Qwen-Omni realtime = 16000）。**可选、纯加法**：
   * 缺省（不声明）→ 消费者回落 16000（逐字现状）。装配层据此决定采集重采样目标率（与 STT 路 capabilities.sampleRate 同接缝）。
   */
  readonly inputSampleRate?: number;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/runtime/test/omni-input-rate.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/runtime/src/voice-loop.ts packages/runtime/test/omni-input-rate.test.ts
git commit -m "feat(voice): OmniAudioPort 增 inputSampleRate 声明(omni采样率解耦,可选纯加法)"
```

---

### Task 5b: `QwenOmniLlm` — inputSampleRate + semantic_vad + 发送格式配置化

**Files:**
- Modify: `packages/providers/src/qwen-omni-llm.ts`
- Test: `packages/providers/test/qwen-omni-llm.test.ts`（在既有文件追加用例）

**Interfaces:**
- Consumes: `OmniTurnDetection`（本文件定义，扩展为含 `'semantic_vad'`）。
- Produces:
  - `OmniTurnDetection = 'manual' | 'server_vad' | 'semantic_vad'`
  - `QwenOmniLlmOptions` 新增 `readonly inputSampleRate?: number;`（缺省 16000）
  - `QwenOmniLlm` 实例暴露 `readonly inputSampleRate: number;`（满足 `OmniAudioPort`）

- [ ] **Step 1: 写失败测试**（追加到 `packages/providers/test/qwen-omni-llm.test.ts`）

```typescript
import { QwenOmniLlm } from '../src/qwen-omni-llm';

describe('QwenOmniLlm 采样率/回合模式解耦', () => {
  const base = { id: 'qwen-omni', model: 'qwen3.5-omni-flash-realtime', apiKey: 'k', baseURL: 'wss://x' };
  it('默认 inputSampleRate=16000', () => {
    expect(new QwenOmniLlm(base).inputSampleRate).toBe(16000);
  });
  it('inputSampleRate 可经选项覆盖', () => {
    expect(new QwenOmniLlm({ ...base, inputSampleRate: 24000 }).inputSampleRate).toBe(24000);
  });
  it('turnDetection 接受 semantic_vad（类型层）', () => {
    const llm = new QwenOmniLlm({ ...base, turnDetection: 'semantic_vad' });
    expect(llm).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/providers/test/qwen-omni-llm.test.ts`
Expected: FAIL（`inputSampleRate` 不存在 / `'semantic_vad'` 不在联合类型）

- [ ] **Step 3: 实现**

3a. `OmniTurnDetection` 类型（约 62 行）改为：
```typescript
export type OmniTurnDetection = 'manual' | 'server_vad' | 'semantic_vad';
```
并在其上方 JSDoc 追加一行：
```typescript
 * - `semantic_vad`：服务端语义 VAD（qwen3.5-omni 官方推荐），按语义判端点；与 server_vad 一样不发手动 commit。
```

3b. `QwenOmniLlmOptions` 增加字段（紧跟 `turnDetection?` 之后）：
```typescript
  /** 模型要求的输入采样率（Hz）；缺省 16000（Qwen-Omni realtime 约定）。供装配层解耦采集率。 */
  readonly inputSampleRate?: number;
```

3c. 类内增加只读字段 + 构造赋值。找到类 `export class QwenOmniLlm` 体，在 `id`/`model` 等字段旁加：
```typescript
  readonly inputSampleRate: number;
```
构造函数体内（赋值现有字段处）加：
```typescript
    this.inputSampleRate = opts.inputSampleRate ?? 16000;
```

3d. 发送格式配置化 + semantic_vad 映射：在构造 `session.update` 的 `input_audio_format: 'pcm'` 处，确认其旁的 turn_detection 映射把 `'semantic_vad'`/`'server_vad'` 都作为「服务端自动端点（不发手动 commit）」处理。找到判断手动 vs 自动的分支（原按 `turnDetection === 'server_vad'`），改为：
```typescript
    const serverManaged = turnDetection === 'server_vad' || turnDetection === 'semantic_vad';
```
并在 `session.update` 的 `turn_detection` 字段用 `{ type: turnDetection }`（manual 时仍按既有逻辑设 null/不发 commit）。后续所有 `=== 'server_vad'` 的判断替换为 `serverManaged`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/providers/test/qwen-omni-llm.test.ts`
Expected: PASS（含既有用例不回归）

- [ ] **Step 5: 提交**

```bash
git add packages/providers/src/qwen-omni-llm.ts packages/providers/test/qwen-omni-llm.test.ts
git commit -m "feat(voice): QwenOmniLlm 解耦 inputSampleRate + semantic_vad 回合模式 + 发送格式配置化"
```

---

### Task 5c: `createOmniAudioPort` — 默认升 3.5 + 采样率/回合模式 env

**Files:**
- Modify: `packages/client/src/cli-voice.ts`（`DEFAULT_OMNI_MODEL` 约 66 行、`createOmniAudioPort` 约 113-134 行）
- Test: `packages/client/test/cli-voice-omni.test.ts`（新建）

**Interfaces:**
- Consumes: `QwenOmniLlmOptions.inputSampleRate` / `OmniTurnDetection`（Task 5b）。
- Produces: `DEFAULT_OMNI_MODEL = 'qwen3.5-omni-flash-realtime'`；`createOmniAudioPort` 读 `CHAT_A_OMNI_MODEL`/`CHAT_A_OMNI_SAMPLE_RATE`/`CHAT_A_OMNI_TURN_DETECTION`。

- [ ] **Step 1: 写失败测试**

```typescript
// packages/client/test/cli-voice-omni.test.ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_OMNI_MODEL, createOmniAudioPort } from '../src/cli-voice';

describe('createOmniAudioPort 默认与解耦', () => {
  it('默认 omni 模型为 qwen3.5-omni-flash-realtime', () => {
    expect(DEFAULT_OMNI_MODEL).toBe('qwen3.5-omni-flash-realtime');
  });
  it('有 key 时构造出端口并带 inputSampleRate', () => {
    const port = createOmniAudioPort({ CHAT_A_DASHSCOPE_API_KEY: 'k' } as any);
    expect(port).toBeDefined();
    expect((port as any).inputSampleRate).toBe(16000);
  });
  it('CHAT_A_OMNI_SAMPLE_RATE 覆盖输入率', () => {
    const port = createOmniAudioPort({ CHAT_A_DASHSCOPE_API_KEY: 'k', CHAT_A_OMNI_SAMPLE_RATE: '24000' } as any);
    expect((port as any).inputSampleRate).toBe(24000);
  });
  it('缺 key 回落（返回 undefined）', () => {
    expect(createOmniAudioPort({} as any)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/client/test/cli-voice-omni.test.ts`
Expected: FAIL（`DEFAULT_OMNI_MODEL` 仍是旧值 / 无 inputSampleRate 透传）

- [ ] **Step 3: 实现**

3a. 改默认 model（约 66 行）：
```typescript
export const DEFAULT_OMNI_MODEL = 'qwen3.5-omni-flash-realtime';
```

3b. `createOmniAudioPort` 内构造 `QwenOmniLlm` 处补字段（读 env，缺省安全）：
```typescript
    const rawRate = (env['CHAT_A_OMNI_SAMPLE_RATE'] ?? '').trim();
    const inputSampleRate = rawRate.length > 0 && Number.isFinite(Number(rawRate)) ? Number(rawRate) : undefined;
    const td = (env['CHAT_A_OMNI_TURN_DETECTION'] ?? '').trim().toLowerCase();
    const turnDetection =
      td === 'manual' || td === 'server_vad' || td === 'semantic_vad' ? (td as 'manual' | 'server_vad' | 'semantic_vad') : 'semantic_vad';
    return new QwenOmniLlm({
      id: 'qwen-omni',
      model: env['CHAT_A_OMNI_MODEL'] ?? DEFAULT_OMNI_MODEL,
      apiKey,
      baseURL: env['CHAT_A_OMNI_BASE_URL'] ?? QWEN_DASHSCOPE_REALTIME_URL,
      turnDetection,
      ...(inputSampleRate !== undefined ? { inputSampleRate } : {}),
    });
```
（替换原 `return new QwenOmniLlm({ id, model, apiKey, baseURL })` 整块；其余 try/catch 不变。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/client/test/cli-voice-omni.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client/src/cli-voice.ts packages/client/test/cli-voice-omni.test.ts
git commit -m "feat(voice): omni 默认升 qwen3.5-omni-flash-realtime + 默认 semantic_vad + 采样率env"
```

---

### Task 6: `createAudioDevice` — 按名解析 + 输出 id + 能力驱动采集率 + 校验

**Files:**
- Modify: `packages/client/src/cli-voice.ts`（`createAudioDevice` 约 299-333 行；`startVoiceMode` 调用处）
- Test: `packages/client/test/key-only-wiring.test.ts`（追加用例）

**Interfaces:**
- Consumes: `listInputDevices`/`listOutputDevices`/`resolveDeviceByName`（Task 2）；`NodeAudioDeviceOptions.outputDeviceId`（Task 3）；`stt.capabilities.sampleRate`（既有）/`omni.inputSampleRate`（Task 5a）。
- Produces:
  - `export function resolveRequiredInputRate(stt?: { capabilities: { sampleRate: number } }, omni?: { inputSampleRate?: number }, path?: 'stt' | 'omni'): number`
  - `createAudioDevice(env, deps?)` 支持注入 `deps.requiredInputRate?: number` 与 `deps.promptSelect?`（解析未命中时的选择回调，缺省 undefined=非交互回退默认）。

- [ ] **Step 1: 写失败测试**（追加）

```typescript
// 追加到 packages/client/test/key-only-wiring.test.ts
import { resolveRequiredInputRate } from '../src/cli-voice';

describe('resolveRequiredInputRate（能力驱动采集率）', () => {
  it('STT 路读 capabilities.sampleRate', () => {
    expect(resolveRequiredInputRate({ capabilities: { sampleRate: 16000 } }, undefined, 'stt')).toBe(16000);
  });
  it('omni 路读 inputSampleRate', () => {
    expect(resolveRequiredInputRate(undefined, { inputSampleRate: 24000 }, 'omni')).toBe(24000);
  });
  it('omni 未声明回落 16000', () => {
    expect(resolveRequiredInputRate(undefined, {}, 'omni')).toBe(16000);
  });
  it('全缺回落 16000（缺省安全）', () => {
    expect(resolveRequiredInputRate(undefined, undefined, 'stt')).toBe(16000);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/client/test/key-only-wiring.test.ts`
Expected: FAIL（`resolveRequiredInputRate` 未导出）

- [ ] **Step 3: 实现**

3a. 在 `cli-voice.ts` 顶部 import 增加：
```typescript
import { listInputDevices, listOutputDevices, resolveDeviceByName } from './audio/device-registry';
```

3b. 新增导出函数（放在 `createAudioDevice` 上方）：
```typescript
/**
 * 解析「当前路径所需输入采样率」（能力驱动解耦）：omni 路读端口 inputSampleRate，STT 路读 capabilities.sampleRate；
 * 缺省一律回落 16000（VAD/EOU 硬约束 + 既有现状）。
 */
export function resolveRequiredInputRate(
  stt?: { readonly capabilities: { readonly sampleRate: number } },
  omni?: { readonly inputSampleRate?: number },
  path: 'stt' | 'omni' = 'stt',
): number {
  if (path === 'omni') return omni?.inputSampleRate ?? 16000;
  return stt?.capabilities.sampleRate ?? 16000;
}
```

3c. 改 `createAudioDevice` 的 `node` 分支：在读 `CHAT_A_AUDIO_INPUT_DEVICE_ID` 之外，增加「按名解析」与「输出设备」。把原 `node` 分支体替换为（保留惰性 import 风格；枚举经新建临时设备的 `getEnumModule` 或直接 import naudiodon——此处用注入面，真实由 `NodeAudioDevice.init` 内枚举，装配层用 `loadNativeModule()` 取模块）：

```typescript
  if (mode === 'node' || mode === 'naudiodon' || mode === 'real') {
    const nativeModule = env['CHAT_A_AUDIO_MODULE'];
    const requiredRate = opts?.requiredInputRate ?? 16000;
    // 枚举设备（经 deps 注入，缺省动态 import naudiodon；失败→空，降级到 env/默认）。
    const mod = await (opts?.loadNativeModule?.() ?? loadNaudiodon(nativeModule));
    const inputs = listInputDevices(mod);
    const outputs = listOutputDevices(mod);

    // 输入：显式 id 覆盖 > 按名解析 > （无名/未命中）选择回调 > 系统默认 -1。
    let deviceId = parseIdEnv(env['CHAT_A_AUDIO_INPUT_DEVICE_ID']);
    let deviceCaptureRate = parseIdEnv(env['CHAT_A_AUDIO_CAPTURE_RATE']);
    if (deviceId === undefined) {
      const name = (env['CHAT_A_AUDIO_INPUT_DEVICE_NAME'] ?? '').trim();
      const host = (env['CHAT_A_AUDIO_INPUT_DEVICE_HOST'] ?? '').trim() || undefined;
      let chosen = name.length > 0 ? resolveDeviceByName(inputs, name, host) : null;
      if (chosen === null && opts?.promptSelect && inputs.length > 0) {
        chosen = await opts.promptSelect('input', inputs);
        if (chosen) opts.persistSelection?.('input', chosen);
      }
      if (chosen) {
        deviceId = chosen.id;
        if (deviceCaptureRate === undefined) deviceCaptureRate = chosen.defaultSampleRate;
      }
    }

    // 输出：显式 id 覆盖 > 按名解析 > 选择回调 > -1。
    let outputDeviceId = parseIdEnv(env['CHAT_A_AUDIO_OUTPUT_DEVICE_ID']);
    if (outputDeviceId === undefined) {
      const oname = (env['CHAT_A_AUDIO_OUTPUT_DEVICE_NAME'] ?? '').trim();
      const ohost = (env['CHAT_A_AUDIO_OUTPUT_DEVICE_HOST'] ?? '').trim() || undefined;
      let ochosen = oname.length > 0 ? resolveDeviceByName(outputs, oname, ohost) : null;
      if (ochosen === null && opts?.promptSelect && outputs.length > 0) {
        ochosen = await opts.promptSelect('output', outputs);
        if (ochosen) opts.persistSelection?.('output', ochosen);
      }
      if (ochosen) outputDeviceId = ochosen.id;
    }

    // 采样率校验（fail-fast）：目标率必须 > 0；采集率缺省取目标率（=不重采样）。
    if (!(requiredRate > 0)) {
      throw new Error(`无效的所需输入采样率：${requiredRate}`);
    }

    const device = new NodeAudioDevice({
      ...(nativeModule ? { nativeModule } : {}),
      ...(deviceId !== undefined ? { deviceId } : {}),
      ...(outputDeviceId !== undefined ? { outputDeviceId } : {}),
      captureSampleRate: requiredRate,
      ...(deviceCaptureRate !== undefined ? { deviceCaptureRate } : {}),
    });
    await device.init();
    return { device, real: true };
  }
```

3d. 在文件内补辅助 + 类型（`createAudioDevice` 签名加可选 `opts`）：
```typescript
/** 解析数字 env（空/非数字→undefined）。 */
function parseIdEnv(raw: string | undefined): number | undefined {
  const s = (raw ?? '').trim();
  return s.length > 0 && Number.isFinite(Number(s)) ? Number(s) : undefined;
}
/** 惰性加载 naudiodon（装配层枚举用；失败返回 {} 触发降级）。 */
async function loadNaudiodon(moduleName?: string): Promise<unknown> {
  try {
    return await import(/* @vite-ignore */ moduleName ?? 'naudiodon');
  } catch {
    return {};
  }
}

import type { AudioDeviceInfo } from './audio/device-registry';
export interface CreateAudioDeviceDeps {
  readonly requiredInputRate?: number;
  readonly loadNativeModule?: () => Promise<unknown>;
  /** 解析未命中时的选择回调（CLI/desktop 各自实现）；返回 null=用户取消→回退默认。 */
  readonly promptSelect?: (kind: 'input' | 'output', devices: readonly AudioDeviceInfo[]) => Promise<AudioDeviceInfo | null>;
  /** 选定后持久化（写 .env.local 设备名）。 */
  readonly persistSelection?: (kind: 'input' | 'output', dev: AudioDeviceInfo) => void;
}
```
并把 `export async function createAudioDevice(env: NodeJS.ProcessEnv): Promise<...>` 改为
`export async function createAudioDevice(env: NodeJS.ProcessEnv, opts?: CreateAudioDeviceDeps): Promise<...>`。

3e. `startVoiceMode` 内：在构造 stt/omni 后、调 `createAudioDevice` 前，计算所需率并透传：
```typescript
  const requiredInputRate = resolveRequiredInputRate(stt, omni, effectivePath);
```
把 `const made = await createAudioDevice(env);` 改为
`const made = await createAudioDevice(env, { requiredInputRate, ...(deps.audioSelect ?? {}) });`
（`deps.audioSelect?: CreateAudioDeviceDeps` 为可选注入；CLI 在 Task 7 传入 promptSelect/persistSelection。）在 `VoiceModeDeps` 接口加：
```typescript
  /** 设备选择/持久化注入（CLI 传文字菜单壳；desktop 用 IPC，不经此）。缺省=非交互回退默认。 */
  readonly audioSelect?: CreateAudioDeviceDeps;
```
注意：`effectivePath`/`stt`/`omni` 在该函数内已存在（见现有实现），直接复用。

- [ ] **Step 4: 跑测试 + 类型**

Run: `pnpm vitest run packages/client/test/key-only-wiring.test.ts`
Expected: PASS
Run: `pnpm typecheck`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add packages/client/src/cli-voice.ts packages/client/test/key-only-wiring.test.ts
git commit -m "feat(voice): createAudioDevice 按名解析设备+输出id+能力驱动采集率+fail-fast校验"
```

---

### Task 7: CLI 设备选择菜单壳

**Files:**
- Create: `packages/client/src/audio/cli-device-select.ts`
- Modify: `packages/client/src/cli.ts`（startVoiceMode 调用处注入 `audioSelect`）
- Test: `packages/client/test/cli-device-select.test.ts`

**Interfaces:**
- Consumes: `AudioDeviceInfo`（Task 2）；`upsertEnvLocal`（从 `@chat-a/desktop`? 否——见下，CLI 复用 `packages/client` 自有写回，避免反向依赖 desktop）。
- Produces:
  - `export function formatDeviceMenu(kind: 'input' | 'output', devices: readonly AudioDeviceInfo[]): string`
  - `export function makeCliAudioSelect(io: { question: (q: string) => Promise<string>; write: (s: string) => void; envPath: string }): CreateAudioDeviceDeps`

> 说明：CLI 不应依赖 desktop 包。`.env.local` 写回用 `packages/client/src/env-file.ts` 新增的 `upsertEnvLocal`（与 desktop 同语义；desktop 的同名函数保持不变）。

- [ ] **Step 1: 先给 `env-file.ts` 加 `upsertEnvLocal` 的失败测试**

```typescript
// packages/client/test/env-file.test.ts（追加）
import { upsertEnvLocal } from '../src/env-file';
describe('upsertEnvLocal', () => {
  it('新增键追加到末尾', () => {
    expect(upsertEnvLocal('A=1\n', 'B', '2')).toBe('A=1\nB=2\n');
  });
  it('同键覆盖、不重复', () => {
    expect(upsertEnvLocal('A=1\nB=2\n', 'B', '9')).toBe('A=1\nB=9\n');
  });
  it('空文本直接写一行', () => {
    expect(upsertEnvLocal('', 'A', '1')).toBe('A=1\n');
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm vitest run packages/client/test/env-file.test.ts`
Expected: FAIL（`upsertEnvLocal` 未导出）

- [ ] **Step 3: 实现 `upsertEnvLocal`（env-file.ts 末尾）**

```typescript
/** 在 .env.local 文本里 upsert 一个键（同键覆盖、否则末尾追加；保证结尾换行）。纯函数。 */
export function upsertEnvLocal(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const lines = text.split('\n');
  let found = false;
  const out = lines.map((l) => {
    const eq = l.indexOf('=');
    if (eq > 0 && l.slice(0, eq).trim() === key) {
      found = true;
      return line;
    }
    return l;
  });
  let result = out.join('\n');
  if (!found) {
    if (result.length > 0 && !result.endsWith('\n')) result += '\n';
    result += line;
  }
  if (!result.endsWith('\n')) result += '\n';
  return result;
}
```

- [ ] **Step 4: 跑确认通过**

Run: `pnpm vitest run packages/client/test/env-file.test.ts`
Expected: PASS

- [ ] **Step 5: 写菜单壳失败测试**

```typescript
// packages/client/test/cli-device-select.test.ts
import { describe, it, expect } from 'vitest';
import { formatDeviceMenu, makeCliAudioSelect } from '../src/audio/cli-device-select';
import type { AudioDeviceInfo } from '../src/audio/device-registry';

const devs: AudioDeviceInfo[] = [
  { id: 8, name: '麦克风阵列 (Intel)', hostApi: 'WASAPI', maxInputChannels: 4, maxOutputChannels: 0, defaultSampleRate: 48000 },
  { id: 0, name: '麦克风 (Realtek)', hostApi: 'MME', maxInputChannels: 2, maxOutputChannels: 0, defaultSampleRate: 44100 },
];

describe('CLI 设备选择壳', () => {
  it('formatDeviceMenu 列出带序号/名/host/率', () => {
    const s = formatDeviceMenu('input', devs);
    expect(s).toContain('[0] 麦克风阵列 (Intel)');
    expect(s).toContain('WASAPI');
    expect(s).toContain('48000');
    expect(s).toContain('[1] 麦克风 (Realtek)');
  });

  it('promptSelect 按用户输入的序号返回对应设备', async () => {
    const sel = makeCliAudioSelect({ question: async () => '1', write: () => {}, envPath: '/tmp/x.env' });
    const chosen = await sel.promptSelect!('input', devs);
    expect(chosen!.id).toBe(0);
  });

  it('promptSelect 非法序号返回 null（回退默认）', async () => {
    const sel = makeCliAudioSelect({ question: async () => 'zzz', write: () => {}, envPath: '/tmp/x.env' });
    expect(await sel.promptSelect!('input', devs)).toBeNull();
  });
});
```

- [ ] **Step 6: 跑确认失败**

Run: `pnpm vitest run packages/client/test/cli-device-select.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 7: 实现菜单壳**

```typescript
// packages/client/src/audio/cli-device-select.ts
/**
 * CLI 设备选择壳（注入 readline question/write，可单测）：列设备 → 读序号 → 返回设备；
 * 选定后把设备名 upsert 进 .env.local。非法/取消 → 返回 null（装配层回退系统默认，§3.2）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { AudioDeviceInfo } from './device-registry';
import type { CreateAudioDeviceDeps } from '../cli-voice';
import { upsertEnvLocal } from '../env-file';

export function formatDeviceMenu(kind: 'input' | 'output', devices: readonly AudioDeviceInfo[]): string {
  const title = kind === 'input' ? '请选择麦克风（输入设备）：' : '请选择扬声器（输出设备）：';
  const lines = devices.map(
    (d, i) => `  [${i}] ${d.name}  (${d.hostApi}, ${d.defaultSampleRate}Hz)`,
  );
  return `${title}\n${lines.join('\n')}\n请输入序号 › `;
}

export function makeCliAudioSelect(io: {
  question: (q: string) => Promise<string>;
  write: (s: string) => void;
  envPath: string;
}): CreateAudioDeviceDeps {
  return {
    promptSelect: async (kind, devices) => {
      const ans = (await io.question(formatDeviceMenu(kind, devices))).trim();
      const idx = Number(ans);
      if (!Number.isInteger(idx) || idx < 0 || idx >= devices.length) {
        io.write('（输入无效，已回退系统默认设备）\n');
        return null;
      }
      return devices[idx]!;
    },
    persistSelection: (kind, dev) => {
      try {
        let text = '';
        try {
          text = readFileSync(io.envPath, 'utf8');
        } catch {
          text = '';
        }
        const nameKey = kind === 'input' ? 'CHAT_A_AUDIO_INPUT_DEVICE_NAME' : 'CHAT_A_AUDIO_OUTPUT_DEVICE_NAME';
        const hostKey = kind === 'input' ? 'CHAT_A_AUDIO_INPUT_DEVICE_HOST' : 'CHAT_A_AUDIO_OUTPUT_DEVICE_HOST';
        text = upsertEnvLocal(text, nameKey, dev.name);
        text = upsertEnvLocal(text, hostKey, dev.hostApi);
        writeFileSync(io.envPath, text, 'utf8');
        io.write(`（已记住${kind === 'input' ? '麦克风' : '扬声器'}：${dev.name}）\n`);
      } catch {
        /* 持久化失败不致命：本次仍用所选设备（§3.2） */
      }
    },
  };
}
```

- [ ] **Step 8: 跑确认通过**

Run: `pnpm vitest run packages/client/test/cli-device-select.test.ts`
Expected: PASS

- [ ] **Step 9: 接进 `cli.ts`**（startVoiceMode 调用处注入 audioSelect）

在 `cli.ts` 顶部 import：
```typescript
import { makeCliAudioSelect } from './audio/cli-device-select';
import { createInterface as createRl } from 'node:readline/promises';
```
在 `startVoiceMode({...})` 的入参对象里加（紧邻 `env,`）：
```typescript
        audioSelect: makeCliAudioSelect({
          question: async (q) => {
            const rl = createRl({ input: stdin, output: stdout });
            try {
              return await rl.question(q);
            } finally {
              rl.close();
            }
          },
          write: (s) => stdout.write(s),
          envPath: '.env.local',
        }),
```
（`stdin`/`stdout` 已在 cli.ts 顶部从 `node:process` 引入；若仅引入了 stdout，补 `stdin`。）

- [ ] **Step 10: 类型 + 全量测试 + 提交**

Run: `pnpm typecheck && pnpm vitest run packages/client`
Expected: 全绿
```bash
git add packages/client/src/audio/cli-device-select.ts packages/client/src/cli.ts packages/client/src/env-file.ts packages/client/test/cli-device-select.test.ts packages/client/test/env-file.test.ts
git commit -m "feat(voice): CLI 设备选择文字菜单壳(注入readline,选定写回.env.local设备名)"
```

---

### Task 8: desktop IPC 纯逻辑 + channel（设备列举/选择）

**Files:**
- Modify: `packages/desktop/src/ipc-contract.ts`（IPC 常量 + 类型 + 纯 helper）
- Test: `packages/desktop/test/ipc-contract.test.ts`（追加）

**Interfaces:**
- Produces:
  - `IPC.audioListDevices = 'audio:list-devices'`，`IPC.audioSelectDevice = 'audio:select-device'`
  - `interface AudioDeviceOption { id: number; name: string; hostApi: string; sampleRate: number; }`
  - `interface AudioDeviceLists { inputs: AudioDeviceOption[]; outputs: AudioDeviceOption[]; current: { inputName: string; outputName: string }; }`
  - `interface AudioSelectInput { kind: 'input' | 'output'; name: string; hostApi: string; }`
  - `function persistAudioSelectionText(text: string, sel: AudioSelectInput): string`（纯，复用 `upsertEnvLocal`）

- [ ] **Step 1: 写失败测试（追加到 ipc-contract.test.ts）**

```typescript
import { IPC, persistAudioSelectionText } from '../src/ipc-contract';

describe('audio 设备选择 IPC 纯逻辑', () => {
  it('channel 常量就位', () => {
    expect(IPC.audioListDevices).toBe('audio:list-devices');
    expect(IPC.audioSelectDevice).toBe('audio:select-device');
  });
  it('persistAudioSelectionText 写输入设备名+host', () => {
    const t = persistAudioSelectionText('', { kind: 'input', name: '麦克风(Intel)', hostApi: 'WASAPI' });
    expect(t).toContain('CHAT_A_AUDIO_INPUT_DEVICE_NAME=麦克风(Intel)');
    expect(t).toContain('CHAT_A_AUDIO_INPUT_DEVICE_HOST=WASAPI');
  });
  it('persistAudioSelectionText 写输出设备名+host', () => {
    const t = persistAudioSelectionText('', { kind: 'output', name: '扬声器', hostApi: 'MME' });
    expect(t).toContain('CHAT_A_AUDIO_OUTPUT_DEVICE_NAME=扬声器');
    expect(t).toContain('CHAT_A_AUDIO_OUTPUT_DEVICE_HOST=MME');
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm vitest run packages/desktop/test/ipc-contract.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

3a. `IPC` 常量对象内加（渲染→主一组）：
```typescript
  /** 渲染→主：枚举可用输入/输出音频设备（设置面板下拉框初值）。 */
  audioListDevices: 'audio:list-devices',
  /** 渲染→主：提交设备选择（写回 .env.local 设备名 + host）。 */
  audioSelectDevice: 'audio:select-device',
```

3b. 文件类型区加：
```typescript
/** 设备下拉选项（渲染层展示）。 */
export interface AudioDeviceOption {
  readonly id: number;
  readonly name: string;
  readonly hostApi: string;
  readonly sampleRate: number;
}
/** 设备清单 + 当前已选名（设置面板回填）。 */
export interface AudioDeviceLists {
  readonly inputs: readonly AudioDeviceOption[];
  readonly outputs: readonly AudioDeviceOption[];
  readonly current: { readonly inputName: string; readonly outputName: string };
}
/** 渲染→主：一次设备选择提交。 */
export interface AudioSelectInput {
  readonly kind: 'input' | 'output';
  readonly name: string;
  readonly hostApi: string;
}
```

3c. 纯 helper（放在 `upsertEnvLocal` 附近，复用它）：
```typescript
/** 把一次设备选择 upsert 进 .env.local 文本（纯函数）。 */
export function persistAudioSelectionText(text: string, sel: AudioSelectInput): string {
  const nameKey = sel.kind === 'input' ? 'CHAT_A_AUDIO_INPUT_DEVICE_NAME' : 'CHAT_A_AUDIO_OUTPUT_DEVICE_NAME';
  const hostKey = sel.kind === 'input' ? 'CHAT_A_AUDIO_INPUT_DEVICE_HOST' : 'CHAT_A_AUDIO_OUTPUT_DEVICE_HOST';
  let t = upsertEnvLocal(text, nameKey, sel.name);
  t = upsertEnvLocal(t, hostKey, sel.hostApi);
  return t;
}
```

- [ ] **Step 4: 跑确认通过**

Run: `pnpm vitest run packages/desktop/test/ipc-contract.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/ipc-contract.ts packages/desktop/test/ipc-contract.test.ts
git commit -m "feat(desktop): 音频设备列举/选择 IPC 契约 + 持久化纯逻辑"
```

---

### Task 9: desktop main/preload 接 IPC handler

**Files:**
- Modify: `packages/desktop/src/main.ts`（注册 `ipcMain.handle`）
- Modify: `packages/desktop/src/preload.ts`（暴露 invoke）

**Interfaces:**
- Consumes: `IPC.audioListDevices`/`audioSelectDevice`、`AudioDeviceLists`、`persistAudioSelectionText`（Task 8）；`listInputDevices`/`listOutputDevices`（Task 2，跨包从 `@chat-a/client` 导出——若未导出，在 client 包 index 补 `export * from './audio/device-registry'`）。

- [ ] **Step 1: 确认 device-registry 已从 client 包导出**

检查 `packages/client/src/index.ts` 是否含 `export * from './audio/device-registry';`，没有则加上。
Run: `pnpm typecheck`
Expected: 通过（导出可用）

- [ ] **Step 2: main.ts 注册 handler**（仿照既有 `ipcMain.handle(IPC.settingsSetOutputLang, ...)` 模式，放在同区域）

```typescript
  // —— 音频设备列举/选择（设置面板下拉框） ——
  ipcMain.handle(IPC.audioListDevices, async (): Promise<AudioDeviceLists> => {
    let mod: unknown = {};
    try {
      mod = await import('naudiodon');
    } catch {
      mod = {};
    }
    const toOpt = (d: { id: number; name: string; hostApi: string; defaultSampleRate: number }) => ({
      id: d.id, name: d.name, hostApi: d.hostApi, sampleRate: d.defaultSampleRate,
    });
    return {
      inputs: listInputDevices(mod).map(toOpt),
      outputs: listOutputDevices(mod).map(toOpt),
      current: {
        inputName: handle.env['CHAT_A_AUDIO_INPUT_DEVICE_NAME'] ?? '',
        outputName: handle.env['CHAT_A_AUDIO_OUTPUT_DEVICE_NAME'] ?? '',
      },
    };
  });

  ipcMain.handle(IPC.audioSelectDevice, (_e, sel: AudioSelectInput): { ok: boolean } => {
    try {
      const path = resolveEnvLocalPath(); // 既有：定位仓库根 .env.local（复用 persistOutputLang 的同一定位逻辑）
      let text = '';
      try { text = readFileSync(path, 'utf8'); } catch { text = ''; }
      writeFileSync(path, persistAudioSelectionText(text, sel), 'utf8');
      // 运行时即时生效：同步进程内 env（下次 voiceStart 解析时用）。
      const nameKey = sel.kind === 'input' ? 'CHAT_A_AUDIO_INPUT_DEVICE_NAME' : 'CHAT_A_AUDIO_OUTPUT_DEVICE_NAME';
      const hostKey = sel.kind === 'input' ? 'CHAT_A_AUDIO_INPUT_DEVICE_HOST' : 'CHAT_A_AUDIO_OUTPUT_DEVICE_HOST';
      handle.env[nameKey] = sel.name;
      handle.env[hostKey] = sel.hostApi;
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });
```
并在 main.ts 顶部 import 处补：
```typescript
import { listInputDevices, listOutputDevices } from '@chat-a/client';
import { persistAudioSelectionText, type AudioDeviceLists, type AudioSelectInput } from './ipc-contract';
```
> 注：`resolveEnvLocalPath()` 用现有 `persistOutputLang`/复刻区定位 `.env.local` 的同一函数；若现为内联，提取成一个小函数复用。`readFileSync`/`writeFileSync` 从 `node:fs`（main.ts 已用）。

- [ ] **Step 3: preload.ts 暴露**（仿现有 invoke 暴露法）

```typescript
  audioListDevices: () => ipcRenderer.invoke(IPC.audioListDevices),
  audioSelectDevice: (sel: AudioSelectInput) => ipcRenderer.invoke(IPC.audioSelectDevice, sel),
```
并确保 preload 的 API 类型声明（若有 `declare global` 的 `window.chatA` 接口）同步加这两个方法签名。

- [ ] **Step 4: 类型 + 构建校验**

Run: `pnpm typecheck`
Expected: 无错误
Run: `pnpm --filter @chat-a/desktop run build:bundle`
Expected: 构建成功（preload/main 打包通过）

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/main.ts packages/desktop/src/preload.ts packages/client/src/index.ts
git commit -m "feat(desktop): main/preload 接音频设备列举+选择 IPC(写回.env.local+即时同步env)"
```

---

### Task 10: desktop 渲染层设备下拉框

**Files:**
- Modify: `packages/desktop/src/renderer/renderer.ts`（设置面板加输入/输出两个下拉框）
- Modify: 对应渲染层 HTML/模板（设置面板区域，跟随既有"语种面板/复刻区"同样位置）

**Interfaces:**
- Consumes: `window.chatA.audioListDevices()` / `audioSelectDevice(sel)`（Task 9）。

- [ ] **Step 1: 渲染层加载时拉设备清单并填充下拉框**

在设置面板初始化处（仿"语言面板初值 langGet"），加：
```typescript
async function initAudioDevicePanel(): Promise<void> {
  const lists = await window.chatA.audioListDevices();
  const inSel = document.getElementById('audio-input-select') as HTMLSelectElement | null;
  const outSel = document.getElementById('audio-output-select') as HTMLSelectElement | null;
  const fill = (el: HTMLSelectElement | null, opts: typeof lists.inputs, currentName: string) => {
    if (!el) return;
    el.innerHTML = '';
    for (const o of opts) {
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ name: o.name, hostApi: o.hostApi });
      opt.textContent = `${o.name} (${o.hostApi}, ${o.sampleRate}Hz)`;
      if (o.name === currentName) opt.selected = true;
      el.appendChild(opt);
    }
  };
  fill(inSel, lists.inputs, lists.current.inputName);
  fill(outSel, lists.outputs, lists.current.outputName);
}
```

- [ ] **Step 2: 选择变更即提交**

```typescript
function wireAudioDeviceSelect(): void {
  const onChange = (kind: 'input' | 'output') => async (e: Event) => {
    const { name, hostApi } = JSON.parse((e.target as HTMLSelectElement).value);
    await window.chatA.audioSelectDevice({ kind, name, hostApi });
  };
  document.getElementById('audio-input-select')?.addEventListener('change', onChange('input'));
  document.getElementById('audio-output-select')?.addEventListener('change', onChange('output'));
}
```
在渲染层启动序列里调用 `void initAudioDevicePanel(); wireAudioDeviceSelect();`（紧随既有面板初始化）。

- [ ] **Step 3: HTML 模板加两个 `<select>`**（设置面板内，跟随既有语种下拉同结构）

```html
<div class="setting-row">
  <label for="audio-input-select">麦克风</label>
  <select id="audio-input-select"></select>
</div>
<div class="setting-row">
  <label for="audio-output-select">扬声器</label>
  <select id="audio-output-select"></select>
</div>
```

- [ ] **Step 4: 构建校验（渲染层无独立单测，靠构建 + 类型）**

Run: `pnpm typecheck`
Expected: 无错误
Run: `pnpm --filter @chat-a/desktop run build:bundle`
Expected: 构建成功

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/renderer
git commit -m "feat(desktop): 设置面板输入/输出设备下拉框(变更即写回)"
```

---

### Task 11: 清理 `36302b6` 遗留诊断日志 spam

**Files:**
- Modify: `packages/runtime/src/voice-loop.ts`（`[mic] rms` 每 50 帧日志 + `#diagN` 字段）
- Modify: `packages/desktop/src/main.ts`（`[voiceStart] 收到点击` / `[trace] undefined`(onAny) / `[timing]`）
- Modify: `packages/client/src/audio/node-audio-device.ts`（`init()` 内设备枚举临时块改为门控或删除——枚举能力已由 device-registry 正式承载）
- Modify: `packages/desktop/src/ipc-contract.ts`（`probeVoice` 内临时 `console.error('[probeVoice] ...')`）

**Interfaces:** 无新接口；纯删除/门控诊断输出，行为不变。

- [ ] **Step 1: 跑全量测试建立绿色基线**

Run: `pnpm vitest run`
Expected: 全绿（记录通过数）

- [ ] **Step 2: 删除/门控诊断日志**

- `voice-loop.ts`：删 `[mic] rms` 的每 50 帧 `console.log` 与仅供它用的 `#diagN` 计数字段（若 `#diagN` 无其它引用）。
- `main.ts`：删 `[voiceStart] 收到点击`、`onAny(... [trace] ...)` 整段订阅（`e.type` 取不到=undefined，无用）、`[timing]` 日志。
- `node-audio-device.ts`：删 `init()` 内 `[audio-devices] 选用 deviceId=...` 的临时枚举打印块（保留 `init()` 的加载/报错逻辑）。
- `ipc-contract.ts`：删 `probeVoice` 内 `console.error('[probeVoice] naudiodon init 失败真因:', err)` 这一临时行（保留 catch 返回降级）。

- [ ] **Step 3: 跑全量测试确认不回归**

Run: `pnpm vitest run`
Expected: 与 Step 1 同样全绿（数量不减）
Run: `pnpm typecheck`
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "chore(voice): 清理真机bring-up遗留诊断日志spam(mic rms/voiceStart/trace/timing/枚举打印)"
```

---

## Self-Review（作者自查记录）

**Spec coverage：**
- §1 设备内核 → Task 2 ✓；§2 持久化（存名/.env.local）→ Task 7（CLI 写回）+ Task 8/9（desktop 写回）✓；§3 启动解析 + CLI 壳 + desktop 壳 → Task 6 + Task 7 + Task 9/10 ✓；bug1 输出 id 分离 → Task 3 ✓；§4.1 抗混叠 → Task 1+3 ✓；§4.2 能力驱动率 → Task 6（resolveRequiredInputRate）✓；§4.3 VAD 恒 16k → 由 Task 3「设备率=目标率不重采样」+ STT 路目标率=16k 保证（VAD 永远拿采集输出的 16k 帧，逐字现状）✓；§4.4 fail-fast → Task 6（requiredRate>0 校验）✓；§4.6 omni 解耦 + 3.5 + semantic_vad → Task 5a/5b/5c ✓；清理诊断 → Task 11 ✓。
- 非目标（播放率动态/模型注册表/双流分叉/TTS_AUDIO_FORMAT 常量化）→ 计划内无对应任务，符合范围。
- §9 全双工未来方向 → 不实现，无任务，符合。

**Placeholder scan：** 无 TBD/TODO/“适当处理”；每个代码步给了完整代码。

**Type consistency：** `AudioDeviceInfo`（registry）贯穿 Task 2/3/6/7；`CreateAudioDeviceDeps`（Task 6 定义）被 Task 7 消费；`resolveRequiredInputRate` 签名 Task 6 定义、Task 6 Step 3e 调用一致；`OmniAudioPort.inputSampleRate`（5a）↔ `QwenOmniLlm.inputSampleRate`（5b）↔ `resolveRequiredInputRate` omni 分支（6）一致；`persistAudioSelectionText`/`AudioSelectInput`（8）被 Task 9 消费一致；`IPC.audioListDevices`/`audioSelectDevice` 命名 8/9/10 一致。

**已知裕量/执行期需确认（非阻塞）：**
- Task 3 测试用 `initWithModule` 注入入口为生产代码新增的测试缝（已在实现步显式加入）。
- Task 9 的 `resolveEnvLocalPath()` 复用 main.ts 既有 `.env.local` 定位逻辑；若现为内联需先提取（执行者在该 Task 内顺手提取，属该任务交付物）。
- Task 10 渲染层 HTML 具体落点跟随既有设置面板结构（执行者按现有 DOM 就近放置）。
