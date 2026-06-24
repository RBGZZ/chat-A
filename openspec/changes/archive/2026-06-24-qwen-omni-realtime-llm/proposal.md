## Why

承 `qwen-text-llm-provider`(纯文本 DashScope 复用 `OpenAiCompatLlm`)铺路切片,本 change 落地 **Qwen Omni Realtime**(`qwen-omni`):接入阿里 DashScope 的 **WebSocket 实时多模态**端点(`wss://dashscope.aliyuncs.com/api-ws/v1/realtime`,OpenAI-Realtime 风格协议),实现 **audio-in → 文本流** 的 LLM Provider,作为现有「STT→文本LLM」路径的**可选替代**(承 `docs/chat-a-voice-v3-unified.md` §一:Omni 是网关里的一个 Provider,多模态优先、传统兜底)。

多模态直路的价值(v3 §五):模型从**原始音频**感知情绪/语气,而非从 STT 文本猜测——这是「长期伴侣」北极星的关键能力。但 omni 是 audio-in 直接出文本,会**绕过/替代** VoiceLoop 现有的 STT 步骤,因此必须做成「行为即配置」的**可选路径**,且**不破坏**现有 STT→文本LLM 链路;加载/鉴权/连接失败时**优雅降级**回现有路径(承 §3.2 优雅降级 + v3 §六故障切换链)。

为什么是 Realtime(WS)而非整段 chat/completions(memory `qwen-dashscope-api-params` 调研结论 + 官方文档已核实):整段路径硬伤——必须 `stream:true`、**不回传可靠输入 transcript**(记忆/召回拿不到用户话语)、不收裸 PCM(要 wav 整段);Realtime 路径收**裸 PCM 16k mono 流式输入**、**回传 transcript**(`conversation.item.input_audio_transcription.completed`)、带服务端 VAD,与项目「边说边喂 + 要转写」需求契合。

## What Changes

- **新增 ws 依赖**:`packages/providers/package.json` 加 `ws` + `@types/ws`(项目当前无 WS 客户端;用 pnpm workspace)。
- **新增 `QwenOmniLlm`**(`packages/providers/src/qwen-omni-llm.ts`):基于 DashScope realtime WS 的 Provider。
  - 实现 `LlmProvider` 接口的 `stream(req, signal?)` / `complete(req, signal?)`:把**文本** prompt 经 WS(`modalities:["text"]`、`input_text` 路径或 conversation.item)送出、聚合 `response.text.delta` 文本流回吐——使其可**直接装进 registry 当作一个 LLM 用**,VoiceLoop 现有 STT→LLM 路径零改即可替换。
  - 暴露**真多模态** API `respondToAudio(audio, signal?)`:吃 PCM 块流 → `input_audio_buffer.append`(base64),yield 判别联合事件(`transcript`=用户话语转写 / `text`=回复增量 / `end`),为后续 runtime 接入 audio-in 直路留接缝(本 change 不改 VoiceLoop)。
  - **AbortSignal 真取消**:signal abort 时关闭 WS、停止产出(承 §3.2 真打断)。
  - **能力门 fail-fast**:鉴权/连接/能力缺失时抛清晰中文错误,registry 装配处可据此降级。
  - **WS 连接可注入**(工厂模式):构造接收可选 `wsFactory`,默认用 `ws` 包;测试注入 mock WS,**不依赖真实网络**。
- **registry 注册 `qwen-omni`**(`packages/providers/src/registry.ts`):与现有 `qwen`(纯文本)区分;`apiKey` 缺失抛清晰中文错误;`baseURL` 缺省用具名常量 `QWEN_DASHSCOPE_REALTIME_URL`,支持 `LlmConfig.baseURL` 覆盖(行为即配置)。
- **导出**:`index.ts` 导出 `QwenOmniLlm` 与新常量。

## 范围与 Non-goals

- **本 change 只做 LLM/omni 这一侧**。不碰 TTS(`tts-registry.ts` 等)——另一 agent 并行做 Qwen TTS-realtime,合并由主控处理。
- **不改 VoiceLoop**(runtime):omni 的 audio-in 直路接进 VoiceLoop 需 runtime 改造(替换 STT 步骤),属后续独立 change;本 change 只提供 Provider + 设计文档说明接缝与降级方案。
- **不发真网络请求**:测试全程 mock WS,覆盖正常流式、打断取消、错误降级;真音频手测留给主控。
- **严格只改 `packages/providers/**`**(+ 该包 package.json 加 ws 依赖)。

## Capabilities

### Modified Capabilities
- `provider-tooling`:在既有 LLM Provider 注册能力上,补一条 **Qwen Omni Realtime(WebSocket 多模态)Provider 注册与 audio-in→文本流** 的要求:`qwen-omni` 经注册表映射到 `QwenOmniLlm`,默认 DashScope realtime WS 端点(具名常量、可配置覆盖),apiKey 缺失清晰报错;Provider 支持 AbortSignal 真取消、流式产出、能力门 fail-fast、连接失败优雅降级;WS 连接可注入以确定性测试。

## Impact

- **影响 canonical 章节**:§3.1(接缝:加厂商只在 registry 登记)、§3.3(能力驱动:omni 多一个 audio-in 能力标记)、§3.2(行为即配置 + 优雅降级 + 真打断)。与 `docs/chat-a-voice-v3-unified.md`(Omni 作网关 Provider、多模态优先传统兜底)一致。
- **代码**:仅 `packages/providers`——新增 `qwen-omni-llm.ts`、`registry.ts` 注册 + 常量、`index.ts` 导出、`package.json` 加 ws。
- **测试**:`packages/providers/test/qwen-omni-llm.test.ts` 新增(mock WS:文本流式、audio-in transcript+text、打断取消、鉴权/连接失败降级);registry 装配用例。不触网。
- **延迟预算**:新增可选路径;缺省不启用(provider 仍是开放字符串,用户显式选 `qwen-omni` 才走)。现有 deepseek/anthropic/qwen/fake 路径行为不变。
- **不涉及**:TTS、VoiceLoop/runtime/client/memory/persona;现有路径零改。
