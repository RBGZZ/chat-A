## 1. 配置:baseURL 可覆盖(行为即配置先行,§3.2)

- [x] 1.1 在 `packages/providers/src/config.ts` 的 `LlmConfig` 增**纯加法可选** `baseURL?: string`(OpenAI 兼容端点根覆盖;缺省时各厂商用各自默认,行为不变)
- [x] 1.2 在 `loadLlmConfig` 读 `CHAT_A_LLM_BASE_URL`,非空时填入 `LlmConfig.baseURL`(用条件展开适配 exactOptionalPropertyTypes);缺省不带该字段

## 2. Provider:OpenAiCompatLlm 暴露只读 baseURL(可测性 + trace)

- [x] 2.1 在 `packages/providers/src/openai-compat-llm.ts` 给 `OpenAiCompatLlm` 增只读 `get baseURL(): string`(返回已规整、去尾斜杠的 `#baseURL`);与公开的 `id`/`model` 对称,仅供 trace/测试,fetch 行为不变

## 3. 注册:qwen 纯文本工厂(接缝复用,§3.1/§3.3)

- [x] 3.1 在 `packages/providers/src/registry.ts` 加具名常量 `QWEN_DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'`(无 magic number,可导出供测试断言)
- [x] 3.2 `registerLlm('qwen', cfg => ...)`:镜像 deepseek 分支——`apiKey` 缺失/空抛清晰中文错误(提示设 `CHAT_A_LLM_API_KEY`/`DASHSCOPE_API_KEY`);构造 `OpenAiCompatLlm({ id:'qwen', model: cfg.model, apiKey, baseURL: cfg.baseURL ?? QWEN_DASHSCOPE_BASE_URL, maxTokens? })`
- [x] 3.3 复核 deepseek/anthropic 分支也透传 `cfg.baseURL`(若提供)以一致支持覆盖;缺省时行为完全不变(deepseek 仍默认 `api.deepseek.com`)

## 4. 测试:构造/配置(确定性、不触网,TDD 先行)

- [x] 4.1 `createLlm({ provider:'qwen', model:'qwen-plus', apiKey:'sk-x' })` 返回 `OpenAiCompatLlm`、`id==='qwen'`、`baseURL===QWEN_DASHSCOPE_BASE_URL`
- [x] 4.2 qwen apiKey 缺失/空 → `createLlm` 抛清晰错误(断言错误信息含 key 提示);`listLlmProviders()` 含 `'qwen'`
- [x] 4.3 baseURL 覆盖:`createLlm({ provider:'qwen', model, apiKey, baseURL:'https://x.example/v1/' })` 的实例 `baseURL` 为去尾斜杠的覆盖值
- [x] 4.4 config:`loadLlmConfig({ CHAT_A_LLM_PROVIDER:'qwen', CHAT_A_LLM_MODEL:'qwen-plus', CHAT_A_LLM_API_KEY:'sk-x' })` → provider/model/apiKey 正确;带 `CHAT_A_LLM_BASE_URL` 时 `config.baseURL` 命中,不带时无该字段
- [x] 4.5 回归:deepseek/anthropic/fake 既有用例仍通过(缺省 baseURL 行为不变)

## 5. 收尾与验证

- [x] 5.1 worktree 根 `pnpm -r typecheck` 全绿(纯加法字段不级联改其它包)
- [x] 5.2 worktree 根 `npx vitest run` 全绿(qwen 构造/配置 + 回归)
- [x] 5.3 自检与 canonical 一致:§3.1 接缝(只在 registry 登记)、§3.3 OpenAI 兼容复用、§3.2 行为即配置(baseURL 外置无 magic);确认未越界做多模态 audio-in,且只改 `packages/providers/**`
