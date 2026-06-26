# 全双工编排层 v1：backchannel + 丝滑打断 设计（Design v1.0）

- 日期：2026-06-26
- 状态：待评审（brainstorming → 转 writing-plans）
- 承接：`2026-06-26-full-duplex-orchestration-layer-PRELIMINARY.md`（初步草稿，本 spec 是其 v1 的正式化 + 与流式 ASR 地基对齐后的收敛）
- 关联：`voice-streaming-asr-continuous`（stt-stream 连续流式路）、`voice-architecture-options-survey`、canonical §4

## 1. 背景与地基对齐

全双工分 (A) 真模型级 / (B) 编排层行为；本项目走 (B)。PRELIMINARY 草稿的 v1 原是「FireRedChat 式**本地**编排（本地 EoT 动态让步 + 抢先生成）」。但其后已落地 **stt-stream 连续流式路**（qwen3-asr-flash-realtime + 云端 server-VAD）——**「持续听 + 自动分句 + 动态让步」云端已做**，原 v1 那部分被取代。

对齐后，剩余全双工缺口仅两块：①**边听边说（真重叠）**——需回声处理，最干净是 pVAD 目标说话人（重、推 v2）；②**backchannel**（用户说话中适时附和）。**brainstorm 拍板 v1 = A：backchannel + 丝滑打断，建在 stt-stream 上，不做真重叠、不需 pVAD/AEC。**

## 2. 范围决策（brainstorm 拍板）

1. **只在 stt-stream 路**启用 backchannel（连续 partial 流才谈得上「说话中附和」；批式 stt 路只有 final，无从插话）。
2. **丝滑打断复用现有**（EchoGuard + attention 闸）——v1 不新写打断，只确保 stt-stream 路 speaking 期本地 VAD 打断生效 + 绑 attention_mode。故 **v1 核心交付 = backchannel**。
3. backchannel **绝不占用回合**：listening 期轻量插入，不触发 LLM、不进 thinking/speaking 状态机。
4. 频率绑 `attention_mode`/人格档（companion/高 warmth 多附和；focus 少/不附和）。
5. 失败静默跳过，绝不拖累主对话（§3.2）。

### 非目标（推后）
- 真·边听边说（listen-while-speak / 真重叠）→ 需 pVAD/AEC，v2。
- pVAD 目标说话人 VAD（ONNX + 主人音色注册）→ v2。
- AEC 声学回声消除。
- 批式 stt 路 / omni 路的 backchannel。

## 3. 架构与接缝

### 3.1 `BackchannelController`（packages/runtime，纯决策核 + 外置状态，可注入）
对齐 speech-gate/echo-guard 的「可选注入、不注入=逐字现状」纯加法范式。
```ts
export interface BackchannelConfig {
  /** partial 停止更新达此时长(ms)判「短停顿」=候选附和点。 */
  readonly pauseMs: number;            // 默认 700
  /** 用户须已连续说够此时长(ms)才考虑附和(不对开头附和)。 */
  readonly minSpeechMs: number;        // 默认 3000
  /** 两次附和最小间隔(ms),防刷屏。 */
  readonly cooldownMs: number;         // 默认 5000
  /** 附和短句文本集(克隆音色懒合成+缓存)。 */
  readonly clipTexts: readonly string[]; // 默认 ['嗯','嗯嗯','对','我在听']
}
// 注:不设 frequency 字段(runtime 禁随机、保可测)。**密度由 cooldownMs 调**(companion 短/balanced 长);
//     **开关由「是否注入 backchannel」决定**(focus 档装配层不注入=不附和)。
/** 控制器外置状态(由 VoiceLoop 持有,纯函数推进)。 */
export interface BackchannelState {
  readonly speechStartedAtMs: number | null;  // 本轮用户开口时刻(onSpeechStarted)
  readonly lastPartialAtMs: number | null;    // 最近 partial 时刻
  readonly lastBackchannelAtMs: number | null;// 上次附和时刻(冷却)
  readonly clipIndex: number;                  // 轮换 clip 索引
}
export const INITIAL_BACKCHANNEL_STATE: BackchannelState;
/**
 * 纯决策:给定状态 + 当前时刻 + config,判是否该现在插一句附和,并给出 clip 文本与新状态。
 * 触发条件:有开口(speechStartedAtMs) 且 已说够 minSpeechMs 且 距上次 partial ≥ pauseMs(短停顿)
 *   且 距上次附和 ≥ cooldownMs 且 frequency>0(命中频率)。
 */
export function decideBackchannel(
  state: BackchannelState, nowMs: number, cfg: BackchannelConfig,
): { fire: boolean; clipText?: string; state: BackchannelState };
/** 事件推进纯函数(供 VoiceLoop 在 onSpeechStarted/onPartial/onFinal 调)。 */
export function onSpeechStartedState(s: BackchannelState, nowMs: number): BackchannelState;
export function onPartialState(s: BackchannelState, nowMs: number): BackchannelState;
export function onTurnDoneState(s: BackchannelState): BackchannelState; // final/打断后清开口态
```
> 触发完全确定性（满足全部条件即触发，**不用 Math.random**——runtime 禁随机且要可测）。附和**密度**由 `cooldownMs` 控（companion 短/balanced 长）；**开关**由装配层是否注入 backchannel 决定（focus 不注入=不附和）。

### 3.2 VoiceLoop 集成（packages/runtime/src/voice-loop.ts，仅 stt-stream 路）
- `VoiceLoopDeps` 增可选 `backchannel?: BackchannelConfig`；私有 `#bcState`、`#bcConfig`、`#bcGateUntilMs`（门控上行的截止时刻）、`#bcClipCache: Map<string, PcmChunk[]>`。
- 仅当 `#useStream && #bcConfig` 时启用。
- 在 stt-stream handlers：`onSpeechStarted`→`#bcState = onSpeechStartedState(...)`；`onPartial`→`#bcState = onPartialState(...)` 后 `#maybeBackchannel(now)`；`onFinal`→`#bcState = onTurnDoneState(...)`。
- `#maybeBackchannel(now)`：`decideBackchannel` → fire 时：**不进状态机、不调 #send**；懒合成/取缓存 clip 的 PcmChunk（经 `#tts.synthesize(clipText, ttsOptions)` 收集一次，缓存）→ 经 transport 下行播放（复用 `#toTtsFrame`/sendAudio 路，但带「backchannel 标记」不计回合 seq 影响最小）→ 设 `#bcGateUntilMs = now + 估算clip时长 + 余量`。
- `#onAudio` 连续路推流分支：`if (now < #bcGateUntilMs) 跳过 pushAudio`（门控上行,防附和回声）；门控自动随时间解除（兜底:不依赖播放回调,用时刻截止,绝不卡死推流）。
- speaking 期打断：复用现有 `#handleSpeakingBargeIn`（v1 不改）。

### 3.3 装配（packages/client/src/cli-voice.ts）
- `loadBackchannelConfig(env)`：`CHAT_A_BACKCHANNEL=off`→ undefined（不注入=关）；否则按 `attention_mode`（现有 interaction dials）映射 `cooldownMs`：companion→4000、balanced→7000、focus→undefined(不注入=关)。clipTexts/pauseMs/minSpeechMs 用默认（可后续 env 覆盖，v1 不加专属旋钮，避免过度工程）。
- `startVoiceMode`：仅 stt-stream 生效路时注入 `backchannel`（与 streamingStt 同条件）。

## 4. 数据流

```
stt-stream listening: onSpeechStarted(记开口) → onPartial(刷新 partial 时刻) →
   每次 onPartial 后 #maybeBackchannel(now):
     若 已说够 minSpeechMs 且 距上次partial≥pauseMs(停顿) 且 距上次附和≥cooldownMs:
        → 播缓存 clip「嗯」(不占回合) + 门控上行 ~clip时长
   onFinal → 正常回合(LLM+TTS,清开口态)
speaking: 复用现有本地 VAD 打断
```

## 5. 错误处理与降级（§3.2）

- clip 懒合成失败 / 播放失败 → 当次跳过附和，主对话不受影响；`#bcGateUntilMs` 仍按时刻自动解除（即便没真播也不卡推流）。
- `decideBackchannel`/状态推进纯函数，理论不抛；VoiceLoop 调用处仍 try/catch 兜底。
- `CHAT_A_BACKCHANNEL=off` / 非 stt-stream / 未注入 → 完全不介入，逐字现状。

## 6. 测试（纯函数 + 注入，确定性）

- **`decideBackchannel` + 状态推进 golden test**（voice-detect 或 runtime 测试）：构造（开口时刻、partial 序列、now、cfg）→ 断言：未说够 minSpeechMs 不触发；停顿 ≥pauseMs 且说够 → 触发并给 clipText、更新 lastBackchannelAtMs；冷却内再调不触发（大 cooldownMs）；clip 索引轮换。
- **VoiceLoop 集成**（runtime，注入 fake streaming + fake tts + backchannel cfg）：模拟 onSpeechStarted→若干 onPartial→停顿 → 断言：① 播了 clip（fake tts 被以 clipText 调、下行有帧）② 播放期窗口内 `pushAudio` 被门控（pushed 不增）③ **没占回合**（`#send` 未被调、状态仍 listening）④ clip 缓存复用（第二次同 clip 不重复合成）。
- **装配**（client）：`loadBackchannelConfig`：off→undefined；companion/balanced/focus → 对应 cfg/undefined。

## 7. 主要改动文件

- 新增：`packages/runtime/src/backchannel-controller.ts`（纯核 + 类型 + 默认）
- 改：`packages/runtime/src/voice-loop.ts`（stt-stream 集成：状态推进 + #maybeBackchannel + 上行门控 + clip 缓存）
- 改：`packages/runtime/src/index.ts`（导出）
- 改：`packages/client/src/cli-voice.ts`（loadBackchannelConfig + 装配注入）
- 测试：`packages/runtime/test/backchannel-controller.test.ts`、`packages/runtime/test/voice-loop-backchannel.test.ts`、`packages/client/test/cli-voice-backchannel.test.ts`

## 8. 开放项 / 后续

- v2：pVAD 目标说话人 → 真·边听边说（speaking 期不门控、靠 pVAD 拒小雪自己的声）。
- backchannel clip 内容/音色后续可丰富（v1 固定 4 句默认）。
- frequency 概率化（若 0/非0 + cooldown 不够细）后续可加，但 v1 避随机（runtime 禁随机、保可测）。
