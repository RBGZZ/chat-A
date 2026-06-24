## Why

TTS 是嵌入式部署的**真瓶颈**(见 [[embedded-lightweight-strategy]]:TTS 而非 LLM 决定首音延迟)。现有 TTS 接缝里只有 `openai-compat`(HTTP REST 整段流式)与本地 `kokoro`(需运行时端口),云端**低首音延迟**的流式 TTS 还是空白。

阿里 DashScope 的 **qwen3-tts-flash-realtime**(WebSocket 全双工流式 TTS)正好补这块:**边送文本边收音频**、首音延迟低、OpenAI-Realtime 风格协议、默认输出 24kHz/16bit/mono PCM——与项目 `PcmChunk` 约定(`TTS_SAMPLE_RATE_HZ=24000`、Int16 mono)天然对齐。key 已在 `.env.local`(`CHAT_A_DASHSCOPE_API_KEY`),协议已调研(见 [[qwen-dashscope-api-params]])。

本 change:在 TTS 接缝里新增 `qwen-tts` 实现 `TtsProvider`,产出 `AsyncIterable<PcmChunk>`,**真流式、低首音延迟、AbortSignal 真取消、能力门 fail-fast、连接/鉴权失败优雅降级**;在 `tts-registry` 注册。WebSocket 经**注入式工厂端口**(镜像 kokoro 的 R1 注入接缝),单测用 mock WS、**不触真网络**。

## What Changes

- **新增 `QwenTtsRealtime`**(`packages/providers/src/qwen-tts-realtime.ts`):实现 `TtsProvider`。
  - 连 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`(可配置;海外区端点可覆盖),`Authorization: Bearer <key>` 头鉴权。
  - 握手:`session.update`(配 `voice` / `response_format=PCM_24000HZ_MONO_16BIT` / `mode`)→ `input_text_buffer.append`(送文本)→ `input_text_buffer.commit` → `session.finish`;音频经 `response.audio.delta`(base64 文本帧)流式回传,解 base64 → s16le → `PcmChunk` **逐帧 yield**(低首音延迟)。
  - **AbortSignal 真取消**:signal 一来即 `input_text_buffer.clear` + 关 WS + 结束迭代器(不再后台烧远端额度;契合 barge-in「TTS 流可丢弃」设计)。
  - **能力门 fail-fast**:`assertTtsLanguage` / `assertTtsCloning`(qwen-tts 为内置音色,`voiceCloning=false`)。
  - **优雅降级**:连接/鉴权/协议 `error` 事件 → 抛带上下文的清晰中文错误(**不打印 key**),由上层按既有降级策略处理。
- **WebSocket 可注入**(R1 注入接缝,镜像 `KokoroSession`):构造吃可选 `wsFactory`(端口),缺省时**懒加载** `ws` 包建真连接;测试注入 mock WS → 全程不触网。
- **配置**(`tts-config.ts`):新增判别联合分支 `QwenTtsRealtimeConfig`(`kind:'qwen-tts'`),`loadTtsConfig` 支持 `CHAT_A_TTS_KIND=qwen-tts` + 相关 env(model/voice/apiKey/endpoint/responseFormat/mode/instructions…);apiKey 缺省回落 `CHAT_A_DASHSCOPE_API_KEY`。
- **注册**(`tts-registry.ts`):登记 `'qwen-tts'` 工厂,透传 `wsFactory` 端口(经 `TtsPorts.qwenWsFactory`,纯加法)。
- **导出**(`index.ts`):导出新 provider 与类型。
- **依赖**:`packages/providers/package.json` 加 `ws` + `@types/ws`。

## 范围与 Non-goals

- **只做 TTS 这一侧**。不碰 LLM/omni 相关文件(`registry.ts`/`qwen-omni-llm.ts` 由另一 agent 并行做)。
- **不发真网络请求**:单测全用 mock WS(注入式),覆盖正常流式产出 / AbortSignal 中途取消 / 错误降级 / 能力门拒绝。真音频手测留给主控(需 key + 真网络)。
- **不做音色复刻**:qwen-tts-realtime 为内置音色,`voiceCloning=false`(传 refAudio → fail-fast)。voice-clone/voice-design 是后续独立能力。
- **严格只改 `packages/providers/**`** + 本 change 文档。

## Capabilities

### Modified Capabilities
- `provider-tooling`: 在既有 TTS Provider 接缝能力上,补一条 **DashScope qwen-tts-realtime 流式 TTS Provider** 要求:`qwen-tts` 经注册表映射到 `QwenTtsRealtime`,WebSocket 流式产出 24kHz mono Int16 `PcmChunk`、低首音延迟、AbortSignal 真取消、能力门 fail-fast、连接/鉴权失败优雅降级、WebSocket 可注入以保证可测性(不触网)。

## Impact

- **影响 canonical 章节**:§4(流式优先)、§4.1/§4.3(能力路由 + 能力门 + 可换性)、§3.2(行为即配置)、§3.3(协议复用)、§8.1(id 仅供 trace)。与权威设计一致。
- **代码**:仅 `packages/providers`——`qwen-tts-realtime.ts`(新增)、`tts-config.ts`(加分支 + env)、`tts-registry.ts`(注册 + 注入端口)、`index.ts`(导出)、`package.json`(ws 依赖)。
- **测试**:`packages/providers/test/qwen-tts-realtime.test.ts` 新增——mock WS 覆盖流式产出 / 取消 / 降级 / 能力门;`tts.test.ts` 回归(kinds 列表 + config 解析)。不触网。
- **延迟预算**:目标低首音延迟(边收边 yield,不等整段);AbortSignal 真停,barge-in 不烧额度。
- **不涉及**:LLM/omni、stt、runtime/client/memory/persona;现有 fake/openai-compat/kokoro/edge/gpt-sovits 路径行为不变。
