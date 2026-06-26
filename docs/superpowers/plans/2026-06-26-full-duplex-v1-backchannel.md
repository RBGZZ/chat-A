# 全双工 v1：backchannel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 stt-stream 连续流式路上加 backchannel——用户持续说话且出现短停顿时，小雪适时插一句「嗯/对」附和（不占回合、不打断转写），让陪伴更像真人。

**Architecture:** 新增 `BackchannelController` 纯决策核（runtime，确定性、可 golden test）；VoiceLoop 仅 stt-stream 路集成（在 onSpeechStarted/onPartial/onFinal 推进外置状态，在 #onAudio 每帧 consult 控制器→命中则播缓存 clip + 按时刻门控上行防回声，绝不进状态机/不调 LLM）；cli-voice 装配按 attention_mode 注入，opt-in。

**Tech Stack:** TypeScript（pnpm workspace），vitest。

## Global Constraints

- 测试 `pnpm vitest run <file>`；类型 `pnpm typecheck`。中文注释。
- §3.2：backchannel 失败静默跳过，绝不拖累主对话；上行门控按**时刻**自动解除（不依赖播放回调，绝不卡死推流）。
- 纯加法可选注入：不注入 `backchannel` / 非 stt-stream 路 → 逐字现状（零回归）。
- exactOptionalPropertyTypes：可选字段缺席不写键。
- **runtime 禁随机**（不用 Math.random）：触发完全确定性；密度由 `cooldownMs` 控、开关由是否注入决定。
- backchannel **绝不占回合**：不调 `#send`、不进 thinking/speaking 状态机。
- 复用现有：VoiceLoop `#tts`/`#toTtsFrame`/`#transport.sendAudio`/`#clock`（注入时钟,缺省 Date.now）/`#ttsOptions`；stt-stream 路（已落地）的 `#openStream` handlers 与 `#onAudio` 连续分支。

## 任务依赖
- Task 1（BackchannelController 纯核）→ 独立。
- Task 2（VoiceLoop 集成）→ 依赖 Task 1 + 已有 stt-stream 路。
- Task 3（cli-voice 装配）→ 依赖 Task 1 + 2。
（线性,无可并行项;Task 1 标准、Task 2 最重。）

---

### Task 1: `BackchannelController` 纯决策核

**Files:**
- Create: `packages/runtime/src/backchannel-controller.ts`
- Modify: `packages/runtime/src/index.ts`（导出）
- Test: `packages/runtime/test/backchannel-controller.test.ts`

**Interfaces:**
- Produces:
  - `BackchannelConfig { pauseMs; minSpeechMs; cooldownMs; clipTexts }`、`DEFAULT_BACKCHANNEL_CONFIG`
  - `BackchannelState { speechStartedAtMs; lastPartialAtMs; lastBackchannelAtMs; clipIndex }`、`INITIAL_BACKCHANNEL_STATE`
  - `onSpeechStartedState(s, now): BackchannelState`
  - `onPartialState(s, now): BackchannelState`
  - `onTurnDoneState(s): BackchannelState`
  - `decideBackchannel(s, now, cfg): { fire: boolean; clipText?: string; state: BackchannelState }`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/runtime/test/backchannel-controller.test.ts
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BACKCHANNEL_CONFIG, INITIAL_BACKCHANNEL_STATE,
  onSpeechStartedState, onPartialState, onTurnDoneState, decideBackchannel,
} from '../src/backchannel-controller';

const CFG = DEFAULT_BACKCHANNEL_CONFIG; // pause700 minSpeech3000 cooldown5000

describe('BackchannelController 决策核', () => {
  it('未开口 → 不触发', () => {
    expect(decideBackchannel(INITIAL_BACKCHANNEL_STATE, 10000, CFG).fire).toBe(false);
  });

  it('说够 minSpeech + 停顿≥pause + 冷却足 → 触发并给 clip、更新状态', () => {
    let s = onSpeechStartedState(INITIAL_BACKCHANNEL_STATE, 0); // 开口@0
    s = onPartialState(s, 100); // 最近 partial@100
    // now=100+... 让 spoken=now-0≥3000 且 sincePartial=now-100≥700 → now≥3100
    const r = decideBackchannel(s, 3200, CFG);
    expect(r.fire).toBe(true);
    expect(r.clipText).toBe('嗯'); // clipIndex 0
    expect(r.state.lastBackchannelAtMs).toBe(3200);
    expect(r.state.clipIndex).toBe(1);
  });

  it('未说够 minSpeech → 不触发', () => {
    let s = onSpeechStartedState(INITIAL_BACKCHANNEL_STATE, 0);
    s = onPartialState(s, 100);
    expect(decideBackchannel(s, 1000, CFG).fire).toBe(false); // spoken=1000<3000
  });

  it('partial 刚来(无停顿) → 不触发', () => {
    let s = onSpeechStartedState(INITIAL_BACKCHANNEL_STATE, 0);
    s = onPartialState(s, 3000); // 最近 partial@3000
    expect(decideBackchannel(s, 3100, CFG).fire).toBe(false); // sincePartial=100<700
  });

  it('冷却内不重复触发', () => {
    let s = onSpeechStartedState(INITIAL_BACKCHANNEL_STATE, 0);
    s = onPartialState(s, 100);
    const r1 = decideBackchannel(s, 3200, CFG); // 触发,lastBc=3200
    expect(r1.fire).toBe(true);
    // 再次:now=3900,spoken够、停顿够,但 sinceBc=700<5000 → 不触发
    expect(decideBackchannel(r1.state, 3900, CFG).fire).toBe(false);
  });

  it('clip 轮换', () => {
    let s = onSpeechStartedState(INITIAL_BACKCHANNEL_STATE, 0);
    s = onPartialState(s, 100);
    const r1 = decideBackchannel(s, 3200, CFG); // 嗯 (idx0→1)
    // 过冷却再触发:now=3200+5000+1=8201,需 sincePartial≥700→lastPartial 仍100,ok
    const r2 = decideBackchannel(r1.state, 8201, CFG);
    expect(r1.clipText).toBe('嗯');
    expect(r2.clipText).toBe('嗯嗯'); // idx1
  });

  it('onTurnDone 清开口态(下句前不附和)', () => {
    let s = onSpeechStartedState(INITIAL_BACKCHANNEL_STATE, 0);
    s = onPartialState(s, 100);
    s = onTurnDoneState(s);
    expect(decideBackchannel(s, 3200, CFG).fire).toBe(false); // speechStartedAtMs=null
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm vitest run packages/runtime/test/backchannel-controller.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// packages/runtime/src/backchannel-controller.ts
/**
 * backchannel(附和)纯决策核(全双工 v1):用户持续说话+短停顿时,判是否插一句「嗯/对」附和。
 * 确定性、外置状态(由 VoiceLoop 持有)、可 golden test;**runtime 禁随机**——触发全确定,密度靠 cooldownMs。
 * 仅 stt-stream 路用(连续 partial 流才有「说话中停顿」可判)。附和不占回合。
 */
export interface BackchannelConfig {
  /** partial 停止更新达此时长(ms)判「短停顿」=候选附和点。 */
  readonly pauseMs: number;
  /** 用户须已连续说够此时长(ms)才考虑附和(不对开头附和)。 */
  readonly minSpeechMs: number;
  /** 两次附和最小间隔(ms),防刷屏(密度旋钮)。 */
  readonly cooldownMs: number;
  /** 附和短句集(克隆音色懒合成+缓存;轮换)。 */
  readonly clipTexts: readonly string[];
}
export const DEFAULT_BACKCHANNEL_CONFIG: BackchannelConfig = {
  pauseMs: 700, minSpeechMs: 3000, cooldownMs: 5000, clipTexts: ['嗯', '嗯嗯', '对', '我在听'],
};

export interface BackchannelState {
  /** 本轮用户开口时刻(onSpeechStarted);null=当前无进行中用户话。 */
  readonly speechStartedAtMs: number | null;
  /** 最近一次 partial 时刻(判停顿用)。 */
  readonly lastPartialAtMs: number | null;
  /** 上次附和时刻(冷却用)。 */
  readonly lastBackchannelAtMs: number | null;
  /** 下一句 clip 索引(轮换)。 */
  readonly clipIndex: number;
}
export const INITIAL_BACKCHANNEL_STATE: BackchannelState = {
  speechStartedAtMs: null, lastPartialAtMs: null, lastBackchannelAtMs: null, clipIndex: 0,
};

/** 用户开口:记开口时刻 + 初始化 partial 时刻。 */
export function onSpeechStartedState(s: BackchannelState, nowMs: number): BackchannelState {
  return { ...s, speechStartedAtMs: nowMs, lastPartialAtMs: nowMs };
}
/** 收到 partial:刷新 partial 时刻(若未记开口,补记)。 */
export function onPartialState(s: BackchannelState, nowMs: number): BackchannelState {
  return { ...s, speechStartedAtMs: s.speechStartedAtMs ?? nowMs, lastPartialAtMs: nowMs };
}
/** 回合结束(final/打断):清开口态(下句前不附和);保留冷却与 clip 索引。 */
export function onTurnDoneState(s: BackchannelState): BackchannelState {
  return { ...s, speechStartedAtMs: null, lastPartialAtMs: null };
}

/**
 * 纯决策:满足「已说够 minSpeechMs 且 距上次 partial≥pauseMs(停顿) 且 距上次附和≥cooldownMs 且 有 clip」
 * → fire=true,给轮换 clipText,更新 lastBackchannelAtMs/clipIndex。否则 fire=false、状态不变。
 */
export function decideBackchannel(
  s: BackchannelState, nowMs: number, cfg: BackchannelConfig,
): { fire: boolean; clipText?: string; state: BackchannelState } {
  if (s.speechStartedAtMs === null || s.lastPartialAtMs === null) return { fire: false, state: s };
  if (cfg.clipTexts.length === 0) return { fire: false, state: s };
  const spoken = nowMs - s.speechStartedAtMs;
  const sincePartial = nowMs - s.lastPartialAtMs;
  const sinceBc = s.lastBackchannelAtMs === null ? Number.POSITIVE_INFINITY : nowMs - s.lastBackchannelAtMs;
  if (spoken >= cfg.minSpeechMs && sincePartial >= cfg.pauseMs && sinceBc >= cfg.cooldownMs) {
    const clipText = cfg.clipTexts[s.clipIndex % cfg.clipTexts.length]!;
    return { fire: true, clipText, state: { ...s, lastBackchannelAtMs: nowMs, clipIndex: s.clipIndex + 1 } };
  }
  return { fire: false, state: s };
}
```

- [ ] **Step 4: 跑确认通过 + 类型**

Run: `pnpm vitest run packages/runtime/test/backchannel-controller.test.ts`
Expected: PASS（7 用例）
Run: `pnpm --filter @chat-a/runtime typecheck`

- [ ] **Step 5: 导出 + 提交**

`packages/runtime/src/index.ts` 确认 `export * from './backchannel-controller'`（若按名导出则补）。
```bash
git add packages/runtime/src/backchannel-controller.ts packages/runtime/src/index.ts packages/runtime/test/backchannel-controller.test.ts
git commit -m "feat(voice): BackchannelController 附和决策纯核(确定性,cooldown控密度,clip轮换)"
```

---

### Task 2: VoiceLoop 集成（仅 stt-stream 路）

**Files:**
- Modify: `packages/runtime/src/voice-loop.ts`
- Test: `packages/runtime/test/voice-loop-backchannel.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `BackchannelConfig`/`BackchannelState`/`decideBackchannel`/`onSpeechStartedState`/`onPartialState`/`onTurnDoneState`/`INITIAL_BACKCHANNEL_STATE`；现有 `#tts`/`#toTtsFrame`/`#transport`/`#clock`(或 `#now()`)/`#ttsOptions`/stt-stream 的 `#openStream` handlers 与 `#onAudio` 连续分支。
- Produces: `VoiceLoopDeps.backchannel?: BackchannelConfig`；附和行为。

**实现要点（先 Read voice-loop.ts:`#openStream`(stt-stream handlers)、`#onAudio` 连续路分支、`#toTtsFrame`、`#clock`/时钟用法、`#ttsOptions`）：**

- [ ] **Step 1: 写失败测试**（注入 fake streaming + fake tts + 注入时钟，驱动「说话+停顿」）

```typescript
// packages/runtime/test/voice-loop-backchannel.test.ts
// 脚手架(fake vad/turnDetector/stt/tts/memory/bus/transport + 注入 clock)照
// packages/runtime/test/voice-loop-stt-stream.test.ts 复制(它已有 stt-stream + fake streaming port 的 setup)。
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_BACKCHANNEL_CONFIG } from '../src/backchannel-controller';

describe('VoiceLoop backchannel (stt-stream)', () => {
  it('说话中停顿 → 播附和 clip(经fake tts)、不占回合(不调send)、播放期门控上行', async () => {
    // 1) 构造:voicePath:'stt-stream', streamingStt: fakePort, backchannel: DEFAULT_BACKCHANNEL_CONFIG,
    //    tts: fakeTts(synthesize 记录调用文本、yield 一个 ~300ms 的 chunk), send: sendSpy, clock: 注入可控 now。
    // 2) loop.start() → fakePort.handlers 就位。
    // 3) handlers.onSpeechStarted()(clock=0);handlers.onPartial('我')(clock=100)。
    // 4) 驱动 #onAudio 喂 audio:input 帧并把注入 clock 推到 3200(spoken≥3000,sincePartial≥700,首次冷却∞)。
    // 5) 断言:fakeTts.synthesize 被以某 clipText('嗯'..)调用;下行 transport 收到 tts:chunk(附和音频);
    //    sendSpy 未被调用(不占回合);loop 仍 listening。
    // 6) 在门控窗口内(clock < gateUntil)再喂 audio:input → 断言 fakePort.pushAudio 未增(门控);
    //    clock 推过 gateUntil 后再喂 → pushAudio 恢复。
    expect(true).toBe(true); // 占位:执行时按 voice-loop-stt-stream.test.ts 脚手架写实(断言点见上)
  });
});
```
> **执行说明**：脚手架与注入方式**照 `voice-loop-stt-stream.test.ts` 现有写法**（它已有 fake streaming port + start + onFinal 驱动的范例）。新增：fakeTts 记录 synthesize 调用 + 注入可控 clock（VoiceLoop 已支持 `deps.clock`）。三大断言：①命中时 fakeTts 以 clipText 被调 + 下行有附和帧；②`deps.send` 未被调（不占回合）、state 仍 listening；③门控窗口内 pushAudio 不增、窗口后恢复。

- [ ] **Step 2: 跑确认失败**

Run: `pnpm vitest run packages/runtime/test/voice-loop-backchannel.test.ts`
Expected: FAIL（backchannel 未支持）

- [ ] **Step 3: 实现**（voice-loop.ts）

3a. import Task 1 符号：
```typescript
import {
  type BackchannelConfig, type BackchannelState, INITIAL_BACKCHANNEL_STATE,
  decideBackchannel, onSpeechStartedState, onPartialState, onTurnDoneState,
} from './backchannel-controller';
import type { PcmChunk } from '@chat-a/providers'; // 若已 import 则复用
```

3b. `VoiceLoopDeps` 加（紧邻 `streamingStt?` 字段）：
```typescript
  /**
   * backchannel 附和配置(全双工 v1,**可选、纯加法**)。仅 `voicePath==='stt-stream'` 且注入时生效:
   * 用户说话中停顿时插一句缓存 clip「嗯/对」附和——**不占回合、不调 LLM、不进状态机**;播放期按时刻门控上行防回声。
   * 不注入(缺省)→ 不附和,逐字现状。
   */
  readonly backchannel?: BackchannelConfig;
```

3c. 私有字段 + 构造赋值：
```typescript
  readonly #backchannel?: BackchannelConfig;
  #bcState: BackchannelState = INITIAL_BACKCHANNEL_STATE;
  #bcGateUntilMs = 0;                       // < now 即不门控;附和播放期内 > now 暂停上行推流
  readonly #bcClipCache = new Map<string, PcmChunk[]>();
```
构造：`this.#backchannel = deps.backchannel;`。getter：
```typescript
  get #useBackchannel(): boolean { return this.#useStream && this.#backchannel !== undefined; }
```
（`#now()`：若 voice-loop 已有时钟封装用之；否则 `this.#clock?.() ?? Date.now()`，与现有用法一致——Read 确认。）

3d. stt-stream handlers（`#openStream` 内）推进状态：
- `onSpeechStarted`：现有逻辑后加 `if (this.#useBackchannel) this.#bcState = onSpeechStartedState(this.#bcState, this.#now());`
- `onPartial`：加 `if (this.#useBackchannel) this.#bcState = onPartialState(this.#bcState, this.#now());`
- `onFinal`：在驱动回合前/后加 `if (this.#useBackchannel) this.#bcState = onTurnDoneState(this.#bcState);`

3e. `#onAudio` 连续路分支（pushAudio 那段）改为带门控 + 每帧 consult：
```typescript
      // 连续路:listening/thinking 推流;但附和播放期(门控窗内)暂停上行防回声。
      if (this.#state !== 'speaking') {
        const now = this.#now();
        if (now >= this.#bcGateUntilMs) {
          try { this.#streamSession?.pushAudio(this.#toPcmChunk(pcm)); } catch { /* 不崩 */ }
        }
        if (this.#useBackchannel) this.#maybeBackchannel(now);
      } else {
        this.#handleSpeakingBargeIn(pcm, result, evt);
      }
      return;
```
（**注意**:照现有 stt-stream 分支结构改,保留 speaking 走 `#handleSpeakingBargeIn`;别破坏 EchoGuard 所需的前置 `#vad.pushFrame`/`#lastFrameSamples` 更新。）

3f. 新增 `#maybeBackchannel` + `#playBackchannel`：
```typescript
  #maybeBackchannel(nowMs: number): void {
    if (this.#backchannel === undefined) return;
    let d: ReturnType<typeof decideBackchannel>;
    try { d = decideBackchannel(this.#bcState, nowMs, this.#backchannel); }
    catch { return; }
    this.#bcState = d.state;
    if (d.fire && d.clipText !== undefined) void this.#playBackchannel(d.clipText);
  }

  /** 播一句附和 clip(懒合成+缓存);**不占回合**;按 clip 时长设上行门控截止。失败静默跳过(§3.2)。 */
  async #playBackchannel(clipText: string): Promise<void> {
    try {
      let chunks = this.#bcClipCache.get(clipText);
      if (chunks === undefined) {
        chunks = [];
        for await (const c of this.#tts.synthesize(clipText, this.#ttsOptions)) chunks.push(c);
        this.#bcClipCache.set(clipText, chunks);
      }
      // 门控上行 = clip 时长 + 余量(按时刻自动解除,绝不卡死推流)。
      const durMs = chunks.reduce((a, c) => a + (c.samples.length / c.sampleRate) * 1000, 0);
      this.#bcGateUntilMs = this.#now() + durMs + 200;
      for (const c of chunks) this.#transport.sendAudio(this.#toTtsFrame(c)); // 下行播放,不改状态机
    } catch (err) {
      console.warn('[VoiceLoop] backchannel 跳过(不影响对话):', err);
    }
  }
```
（`this.#ttsOptions` 若可能 undefined,按现有 `#speak` 调 synthesize 的写法传参;`#toTtsFrame` 复用现有。）

3g. `stop()`：清缓存可选；`#bcGateUntilMs=0` 重置（幂等，非必须）。

- [ ] **Step 4: 跑确认通过 + runtime 全包不回归**

Run: `pnpm vitest run packages/runtime/test/voice-loop-backchannel.test.ts`
Expected: PASS
Run: `pnpm vitest run packages/runtime/test`
Expected: 全绿（含 voice-loop-stt-stream/echo-guard/omni/speech-gate 不回归）
Run: `pnpm --filter @chat-a/runtime typecheck`

- [ ] **Step 5: 提交**

```bash
git add packages/runtime/src/voice-loop.ts packages/runtime/test/voice-loop-backchannel.test.ts
git commit -m "feat(voice): VoiceLoop 集成 backchannel(stt-stream路,说话停顿插缓存clip附和,不占回合+时刻门控上行防回声)"
```

---

### Task 3: cli-voice 装配（依赖 Task 1+2）

**Files:**
- Modify: `packages/client/src/cli-voice.ts`
- Test: `packages/client/test/cli-voice-backchannel.test.ts`

**Interfaces:**
- Consumes: `BackchannelConfig`/`DEFAULT_BACKCHANNEL_CONFIG`（runtime，Task 1）；`VoiceLoopDeps.backchannel`（Task 2）；现有 `attention_mode` 读取（Read cli-voice 现有怎么读 interaction dials / attention_mode）。
- Produces: `loadBackchannelConfig(env)`；startVoiceMode 在 stt-stream 路注入。

- [ ] **Step 1: 写失败测试**

```typescript
// packages/client/test/cli-voice-backchannel.test.ts
import { describe, it, expect } from 'vitest';
import { loadBackchannelConfig } from '../src/cli-voice';

describe('loadBackchannelConfig', () => {
  it('CHAT_A_BACKCHANNEL=off → undefined(关)', () => {
    expect(loadBackchannelConfig({ CHAT_A_BACKCHANNEL: 'off' } as any)).toBeUndefined();
  });
  it('focus 档 → undefined(不附和)', () => {
    expect(loadBackchannelConfig({ CHAT_A_ATTENTION_MODE: 'focus' } as any)).toBeUndefined();
  });
  it('companion 档 → 配置且 cooldown 较短', () => {
    const c = loadBackchannelConfig({ CHAT_A_ATTENTION_MODE: 'companion' } as any);
    expect(c).toBeDefined();
    expect(c!.cooldownMs).toBe(4000);
  });
  it('balanced/缺省 → 配置且 cooldown 较长', () => {
    const c = loadBackchannelConfig({} as any);
    expect(c).toBeDefined();
    expect(c!.cooldownMs).toBe(7000);
  });
});
```
> 注：`attention_mode` 的实际 env 键以 cli-voice/项目现有为准（Read 确认；上面 `CHAT_A_ATTENTION_MODE` 为占位，**用真实键**）。

- [ ] **Step 2: 跑确认失败**

Run: `pnpm vitest run packages/client/test/cli-voice-backchannel.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**（cli-voice.ts；先 Read attention_mode 读取现状 + startVoiceMode 的 stt-stream 注入处）

3a. import：`DEFAULT_BACKCHANNEL_CONFIG`、type `BackchannelConfig`（from `@chat-a/runtime`）。

3b. 新增导出 `loadBackchannelConfig`：
```typescript
/**
 * backchannel 装配(全双工 v1):CHAT_A_BACKCHANNEL=off → 不附和;否则按 attention_mode 映射 cooldown
 * (companion 更频繁/focus 不附和)。clipTexts/pauseMs/minSpeechMs 用默认。
 */
export function loadBackchannelConfig(env: NodeJS.ProcessEnv): BackchannelConfig | undefined {
  if ((env['CHAT_A_BACKCHANNEL'] ?? '').trim().toLowerCase() === 'off') return undefined;
  const mode = (env['CHAT_A_ATTENTION_MODE'] ?? '').trim().toLowerCase(); // ← 用项目真实键
  if (mode === 'focus') return undefined;          // 专注:不附和
  const cooldownMs = mode === 'companion' ? 4000 : 7000; // companion 频繁;balanced/缺省较克制
  return { ...DEFAULT_BACKCHANNEL_CONFIG, cooldownMs };
}
```

3c. `startVoiceMode`：在注入 `streamingStt` 的同分支，加注入 backchannel（仅 stt-stream 生效路）：
```typescript
        ...(streamingStt !== undefined
          ? { streamingStt, voicePath: 'stt-stream' as const,
              ...(loadBackchannelConfig(env) ? { backchannel: loadBackchannelConfig(env)! } : {}) }
          : {}),
```
（按现有 loopDeps 注入风格 + exactOptionalPropertyTypes；`loadBackchannelConfig` 调一次存变量避免重复调。）

- [ ] **Step 4: 跑确认通过 + 全量 + typecheck**

Run: `pnpm vitest run packages/client/test/cli-voice-backchannel.test.ts`
Expected: PASS
Run: `pnpm vitest run`（全量,零回归）
Run: `pnpm typecheck`（全工作区）

- [ ] **Step 5: 重建 bundle + 提交**

```bash
pnpm --filter @chat-a/desktop run build:bundle
git add packages/client/src/cli-voice.ts packages/client/test/cli-voice-backchannel.test.ts
git commit -m "feat(voice): cli-voice 装配 backchannel(按attention_mode映射cooldown,stt-stream路注入,CHAT_A_BACKCHANNEL=off可关)"
```

---

## Self-Review（作者自查）

**Spec coverage**：spec §3.1 控制器→Task1;§3.2 VoiceLoop 集成(状态推进+#maybeBackchannel+门控+缓存)→Task2;§3.3 装配→Task3;§5 降级(失败跳过+时刻门控自解除)→Task2(3f try/catch + gateUntil 时刻)；§6 测试→各 Task TDD;§2 范围(仅stt-stream/不占回合/cooldown控密度/focus不注入)→Task2(#useBackchannel 守卫)+Task3(loadBackchannelConfig)。覆盖完整。

**Placeholder scan**：Task1/3 代码完整。Task2 深改 voice-loop.ts,给了 import/字段/handlers 推进/onAudio 门控分支/#maybeBackchannel/#playBackchannel 完整代码 + 「Read 现有 stt-stream 分支照锚点改」指令;其单测显式指明照 voice-loop-stt-stream.test.ts 脚手架写实。非 TODO 占位。

**Type consistency**：`decideBackchannel(s,now,cfg)→{fire,clipText?,state}`、`BackchannelState` 字段、`on*State` 签名 Task1 定义、Task2 消费一致；`BackchannelConfig{pauseMs,minSpeechMs,cooldownMs,clipTexts}` Task1/3 一致(无 frequency,符 spec)；`VoiceLoopDeps.backchannel` Task2 定义、Task3 注入一致。

**执行注意**：Task2 改 VoiceLoop 的 stt-stream 分支,务必 Read 流式 ASR 切片落地的 `#openStream`/`#onAudio` 连续分支真实代码,照锚点改、复用 `#now()`/`#toTtsFrame`/`#ttsOptions` 真实写法;`CHAT_A_ATTENTION_MODE` 用项目真实 env 键(Read 确认)。
