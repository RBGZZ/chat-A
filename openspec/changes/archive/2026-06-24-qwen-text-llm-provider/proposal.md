## Why

后续要接入 **qwen3.5-omni-flash**(阿里通义多模态),其多模态 audio-in 直路需要真 API key + 实测请求/响应形状,成本与不确定性都高。但 Qwen 系列的**纯文本**模型(qwen-plus / qwen3 等)走的是 **DashScope OpenAI 兼容端点**(`https://dashscope.aliyuncs.com/compatible-mode/v1`,鉴权 `Authorization: Bearer <DASHSCOPE_API_KEY>`),与现有 `OpenAiCompatLlm`(真 fetch + SSE,DeepSeek 已在用)完全同形。

本 change 是**铺路切片**:在 providers 注册表里把 `qwen` 注册为一个纯文本 LLM Provider,**复用** `OpenAiCompatLlm`,镜像现有 `deepseek` 分支。这样用户只需 `CHAT_A_LLM_PROVIDER=qwen` + key 即可用通义纯文本对话,且为后续 `QwenOmniLlm`(audio-in 直路)留好接缝——届时只是再注册一个走多模态的工厂,**registry/createLlm 核心与系统其余部分零改动**(承 §3.1 接缝、§3.3 OpenAI 兼容复用)。

## What Changes

- **注册 `qwen` 纯文本工厂**:在 `packages/providers/src/registry.ts` 镜像 `deepseek` 分支,加 `registerLlm('qwen', ...)`,构造 `OpenAiCompatLlm({ id:'qwen', model, apiKey, baseURL })`;`apiKey` 缺失时抛**清晰中文错误**(提示设 `CHAT_A_LLM_API_KEY` / `DASHSCOPE_API_KEY`)。
- **baseURL 可覆盖、无 magic number**:DashScope 兼容端点默认值集中为一个具名常量(如 `QWEN_DASHSCOPE_BASE_URL`),并支持 `CHAT_A_LLM_BASE_URL` 环境变量覆盖(行为即配置,§3.2)。base URL 覆盖经 `LlmConfig` 传入工厂,**纯加法、缺省时各厂商行为不变**(deepseek/anthropic 不受影响)。
- **provider 类型不变**:`LlmConfig.provider` 仍为开放字符串,env 走现有 `CHAT_A_LLM_PROVIDER=qwen` 即可,无需改类型枚举。
- **`OpenAiCompatLlm` 暴露只读 `baseURL`**:为可测性与 trace,把 `#baseURL` 暴露为只读 getter(与已公开的 `id`/`model` 对称,仅供 trace/测试断言,**不改 fetch 行为**)。

## 范围与 Non-goals(明确铺路边界)

- **本 change 只做纯文本路径**(复用 `OpenAiCompatLlm` 的 chat/completions + SSE),覆盖 qwen-plus / qwen3 等纯文本模型。
- **不做** 多模态 audio-in 直路(qwen3.5-omni-flash 的语音输入)——那是后续独立 change `QwenOmniLlm` 的事,需真 key + 实测 DashScope 多模态 API 的请求/响应形状,本切片不预测、不预埋多模态字段。
- **不发真网络请求**(无 key):测试只验证**工厂构造与配置解析**,不触网。
- **严格只改 `packages/providers/**`**:不碰 tts/stt registry、不碰 runtime/client/memory/persona 等其它包。

## Capabilities

### New Capabilities
<!-- 无新增能力(纯注册接缝复用) -->

### Modified Capabilities
- `provider-tooling`: 在既有 OpenAI 兼容 Provider 能力上,补一条 **LLM Provider 注册与 DashScope(Qwen)纯文本映射** 的要求:`qwen` 经注册表映射到 `OpenAiCompatLlm`,默认 DashScope 兼容端点、baseURL 可经配置覆盖、apiKey 缺失清晰报错;并给 `OpenAiCompatLlm` 增只读 `baseURL`(纯加法,供 trace/测试)。

## Impact

- **影响 canonical 章节**:§3.1(接缝:加厂商只在 registry 登记)、§3.3(OpenAI 兼容协议复用,系统对厂商无感)、§3.2(行为即配置:baseURL 外置可覆盖、无 magic number)。与权威设计一致,无冲突。
- **代码**:仅 `packages/providers`——`registry.ts`(注册 qwen 工厂 + DashScope 常量 + 透传 baseURL 覆盖)、`config.ts`(读 `CHAT_A_LLM_BASE_URL` 到 `LlmConfig.baseURL`,纯加法可选)、`openai-compat-llm.ts`(只读 `baseURL` getter,纯加法)。
- **测试**:`packages/providers/test` 新增/扩展 registry+config 用例(`createLlm({provider:'qwen', model, apiKey})` 返回 `OpenAiCompatLlm` 且 baseURL 为 DashScope 兼容端点;apiKey 缺失抛清晰错误;`CHAT_A_LLM_BASE_URL` 覆盖生效;env `CHAT_A_LLM_PROVIDER=qwen` 解析正确)。不触网。
- **延迟预算**:纯构造/配置接缝,无运行期网络/LLM 变化,延迟影响为零。
- **不涉及**:多模态 audio-in、tts/stt、runtime/client/memory/persona;现有 deepseek/anthropic/fake 路径行为不变。
