# 语音管线可追溯性 设计（Design v1.0）

- 日期：2026-06-26
- 状态：待评审（brainstorming → 转 writing-plans）
- 依据：canonical §8.1（可追溯性/可观测性=开发期硬要求）；§11「OTel→SQLite」已大体由 `SqliteSpanSink`/`SqliteSpanProcessor` 落地，本 spec 补**语音管线侧**盲区。
- 起因：语音真机调试时**抓不到管线内部信息**（麦电平、送 STT 的内容、VAD/EOU/EchoGuard/speech-gate/backchannel 判定、状态迁移、TTFA），只能临时写捕获脚本 + 加删诊断日志 → 大量多余工作。

## 1. 背景与缺口

现有可观测性已覆盖**文字回合**（`decision_traces`：user_text→reply + 召回/emotion/PAD/延迟）、**OTel span**（`otel_spans`）、**autonomy 决策**、总线 `onAny` 钩子 + correlationId(ALS)。**但语音管线的运行时信号/决策无任何 trace**（且诊断日志已在清理中删除）。本 spec 把语音侧纳入可追溯，且**实时结构日志 + 可查 SQLite 双呈现**（brainstorm 拍板）。

## 2. 范围

- 捕获语音管线信号/决策（采样麦 RMS + 6 类决策 + 3 类回合，见 §4）。
- 两个呈现：① 实时结构日志（`CHAT_A_VOICE_TRACE=1`）；② SQLite `voice_trace_events`（`CHAT_A_VOICE_TRACE_DB`，缺省复用决策 trace 库）。
- 默认全关、零开销（不注入 observer / 不开 env → VoiceLoop 逐字现状）。

### 非目标
- 不重做已有 decision_traces / otel_spans / autonomy trace（已存在，仅按 correlationId 缝合）。
- 不做图形化 trace 查看器（沿用 `bin/trace.ts` CLI / 直接 SQL）。
- 不做生产采样策略（v1 开启即全量；与现有 decision-trace 一致）。

## 3. 架构与接缝（复用现有模式）

**VoiceLoop 在各决策/回合边界 emit `VoiceTraceEvent`，经可选注入的 `voiceObserver?` 抛出；装配层 fan-out 到两个 sink。** 纯加法、不注入零开销（对齐已有 `echoGuardObserver` 范式）。

```
VoiceLoop ──VoiceTraceEvent──► deps.voiceObserver?(ev)   ←装配层提供
                                   │ fan-out(cli-voice)
              ┌────────────────────┴────────────────────┐
   实时日志(gated CHAT_A_VOICE_TRACE)            SqliteVoiceTraceSink(gated CHAT_A_VOICE_TRACE_DB)
   console.log(formatVoiceTrace(ev))            observability 包,node:sqlite,自吞降级
```

- **`VoiceTraceEvent`**（判别联合）放 `packages/protocol`（runtime emit、observability/client 消费，统一依赖 protocol，方向干净）。
- **`formatVoiceTrace(ev): string`**（纯函数，单行紧凑格式，可单测）放 `packages/observability`。
- **`SqliteVoiceTraceSink`** 放 `packages/observability`，照 `SqliteSpanSink` 模式（schema 版本化 + 顺序迁移 + `':memory:'` 测试 + 失败自吞）。
- VoiceLoop 只 emit、不感知 sink；observer 抛错被吞，**绝不打断回合**（§3.2）。
- 缝合：事件带 `correlationId`/`sessionId`/`turnId`（与 decision_traces/otel_spans 同键）。

## 4. 捕获集（`VoiceTraceEvent` 判别联合）

公共字段：`{ atMs: number; correlationId?: string; sessionId?: string; turnId?: string }` + `kind`。

| kind | 额外字段 | emit 点 |
|---|---|---|
| `mic-sample` | `rmsNorm`（归一 RMS） | `#onAudio` 每 ~50 帧(500ms)采样一次 |
| `vad` | `event: 'speech_start'\|'speech_end'` | VAD 边沿 |
| `endpoint` | `silenceMs` | `#shouldEndpoint` 触发断句 |
| `echo-guard` | `tier, rmsNorm, run, passed` | `#handleSpeakingBargeIn`/EchoGuard 决策 |
| `speech-gate` | `passed, totalMs, voicedMs` | `#startThinking` 段级门判定 |
| `backchannel` | `fired, clipText?` | `#maybeBackchannel` |
| `state` | `from, to` | 每次 `#go` 状态迁移成功 |
| `stt-input` | `path('stt'\|'stt-stream'\|'omni'), durationMs, rmsNorm` | 送 STT/omni 前（批式=buf 汇总；流式=每段提交） |
| `stt-result` | `text, emotion?, lang?, isFinal` | STT/onFinal 拿到结果 |
| `turn` | `ttfaMs?, outcome('replied'\|'gated'\|'barge_in'\|'empty'\|'error')` | 回合收尾 |

> 「为什么转写成嗯」一眼可查：`stt-input dur=300ms rms=0.001 → stt-result text="嗯"`。

## 5. SQLite schema（observability，`voice_trace_events` 表）

照 `SqliteSpanSink` 范式（node:sqlite + schema_version 元表 + 顺序迁移 + WAL + 自吞）：
```sql
CREATE TABLE voice_trace_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms REAL NOT NULL,
  kind TEXT NOT NULL,
  correlation_id TEXT, session_id TEXT, turn_id TEXT,
  data_json TEXT NOT NULL   -- kind 专属字段的 JSON(扁平存,查时解)
);
CREATE INDEX idx_vte_corr ON voice_trace_events(correlation_id);
CREATE INDEX idx_vte_kind ON voice_trace_events(kind);
CREATE INDEX idx_vte_at ON voice_trace_events(at_ms);
```
- 扁平「kind + JSON」表：捕获集字段差异大，JSON 存灵活、加 kind 不改 schema；常用过滤键(corr/kind/at)单列索引。
- `record(ev)` 失败自吞（§3.2）；`getByCorrelation(id)` / `getByKind(kind)` 只读还原供 CLI/测试。
- 缺省库路径复用 `CHAT_A_DECISION_TRACE_DB`（与决策 trace 同库，便于同 correlationId join）；`CHAT_A_VOICE_TRACE_DB` 可单独指定。

## 6. 实时日志格式（`formatVoiceTrace`，纯函数）

单行紧凑、对齐既有 `[xxx]` 前缀风格，便于真机滚动看：
```
[vtrace] mic rms=0.0001
[vtrace] vad speech_start
[vtrace] echo-guard tier=speaking rms=0.001 run=0 passed=false
[vtrace] speech-gate passed=false total=300ms voiced=40ms
[vtrace] stt-input path=stt-stream dur=1200ms rms=0.030
[vtrace] stt-result final text="你好世界" emotion=happy lang=zh
[vtrace] turn outcome=replied ttfa=620ms
```
- 纯函数 `formatVoiceTrace(ev): string`，golden test 覆盖每种 kind。
- 装配层：`CHAT_A_VOICE_TRACE=1` 时 `voiceObserver` 含一个 `(ev)=>stdout.write(formatVoiceTrace(ev)+'\n')`。

## 7. 数据流 / 装配

- `VoiceLoopDeps` 增可选 `voiceObserver?: (ev: VoiceTraceEvent) => void`。VoiceLoop 各 emit 点：`this.#emitTrace({ kind:..., ... })`（内部 try/catch 吞错 + 自动补 correlationId/session/turn/atMs）。
- `cli-voice startVoiceMode`：`loadVoiceTrace(env)` → 组合 observer：
  - `CHAT_A_VOICE_TRACE=1` → 加实时日志 sink；
  - `CHAT_A_VOICE_TRACE_DB`（或复用决策库且 `CHAT_A_DECISION_TRACE` 开）→ 加 `SqliteVoiceTraceSink`；
  - 两者皆无 → 不注入 `voiceObserver`（零开销）。
  - 收尾 stop 时关 SQLite sink。

## 8. 错误处理与降级（§3.2）

- observer 抛错、SQLite record 失败 → 吞掉，绝不打断回合/采集。
- 未开 env → observer 不注入 → emit 点 `this.#voiceObserver?.()` 为 no-op，零开销。
- `mic-sample` 采样（每 ~50 帧）避免逐帧刷屏/写库。

## 9. 测试

- **`formatVoiceTrace`** golden（observability）：每种 kind → 断言单行格式。
- **`SqliteVoiceTraceSink`**（observability，`':memory:'`）：record 各 kind → getByCorrelation/getByKind 还原；schema 迁移；关闭后降级。
- **VoiceLoop emit**（runtime）：注入 fake `voiceObserver` 收集事件 → 驱动各路径断言 emit：speech-gate drop → `speech-gate passed=false` + `turn outcome=gated`；stt-stream onFinal → `stt-result` + `turn replied`；backchannel fire → `backchannel fired`；state 迁移 → `state from→to`；mic 采样节流（~50 帧一次）。不注入 → 无 emit（零回归）。
- **装配**（client）：`loadVoiceTrace`：off→无 observer；CHAT_A_VOICE_TRACE=1→含日志；DB 配置→含 SQLite sink。

## 10. 主要改动文件

- 新增：`packages/protocol/src/voice-trace.ts`（`VoiceTraceEvent` 判别联合 + 公共字段）
- 新增：`packages/observability/src/voice-trace-format.ts`（`formatVoiceTrace`）、`packages/observability/src/sqlite-voice-trace.ts`（`SqliteVoiceTraceSink`）
- 改：`packages/runtime/src/voice-loop.ts`（`voiceObserver?` dep + `#emitTrace` + 各决策/回合/采样 emit 点）
- 改：`packages/client/src/cli-voice.ts`（`loadVoiceTrace` + observer fan-out 装配 + stop 收尾）
- 改：各 `index.ts` 导出
- 测试：protocol（类型可选）、observability（format/sink）、runtime（emit）、client（装配）
- 可选：`bin/trace.ts` 加 voice 查询子命令（v1 可不做，直接 SQL）

## 11. 开放项

- mic-sample 采样间隔（~500ms 占位，真机标定）。
- 是否把语音事件也并入总线 `onAny` 事件层（v1 走独立 observer 更聚焦；后续可统一）。
- 与 decision_traces 的 turnId 对齐口径（确保语音回合与文字决策同 turnId 可 join）。
