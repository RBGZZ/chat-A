## Why

记忆与人格两根支柱已落地,但都留着**刻意的占位接缝**:情绪评估是确定性小词典(`DefaultAppraiser`),记忆来源是"把用户原话整条存下"(naive)。这两处让小雪"骨架可用但不够真":心情不随语义真正起伏、记忆是流水账而非要点。本次把它们升级为 **LLM 驱动**,把支柱补成"真实版"——改动小、仍在文字阶段。前提是 `LlmProvider` 目前只有流式 `stream()`,缺**非流式/结构化补全**,需先补上(厂商无感不变)。

## What Changes

- **Provider 接缝扩展**:`LlmProvider` 新增非流式 `complete(req): Promise<string>`(返回完整文本);anthropic / deepseek(OpenAI 兼容)/ fake 各实现。appraiser/extractor 用它发"要 JSON"的提示 + **容错解析**,不引入各家结构化输出 API 分歧(Provider 仍厂商无感,id/model 仅 trace)。
- **LLM Appraiser(OCC→PAD)**:一个用 `complete` 的 `Appraiser` 实现,把用户消息评估为 PAD pull;与确定性默认并存,**配置可切、默认仍走确定性**。
- **LLM 记忆抽取器(新接缝 `MemoryExtractor`)**:回合结束后从(用户输入 + 回复)抽取 0..N 条要点/偏好 → `addMemory`(复用已落地 ADD+去重);替换 naive 的"存原话";**配置可切、默认仍走原行为**。
- **延迟预算(§3.2)**:extraction 放回合后、不阻塞流式;appraisal 默认"回合后评估、影响**下一轮**心情"(零首字延迟),可配置改为回合前(影响当轮但加延迟)。
- **优雅降级**:LLM 失败/返回乱码 → appraiser 回退确定性、extractor 跳过本轮,绝不打断回合(§3.2)。

## Capabilities

### New Capabilities
- `llm-cognition`: LLM 驱动的认知升级——Provider 非流式 `complete`、LLM 情绪评估(OCC→PAD)、LLM 记忆抽取(`MemoryExtractor`),全部带配置开关、容错解析与降级。

### Modified Capabilities
<!-- 不改既有 spec 的需求:`persona-emotion` 的 "Appraiser 接缝" 已声明"默认确定性 + LLM 版可选",本次是**兑现**该可选实现;`persistent-memory` 的 ADD+去重不变,抽取只是新的写入来源。均为新增能力,不改既有 requirements。 -->

## Impact

- **canonical 章节/接缝**:§6.1(即时 OCC→PAD 单次 LLM)、§5.8(记忆写路径来源)、§3.3(Provider 能力)、§3.1(Appraiser/MemoryExtractor 接缝)、§3.2(LLM 走 schema+record-replay、行为即配置、优雅降级、延迟预算)、§8.1(可追溯:appraisal/extraction 入 trace)。本次是已声明可选实现的兑现,与权威设计无冲突。
- **代码**:
  - `packages/providers`:`LlmProvider` 加 `complete`;`AnthropicLlm`(按 claude-api 技能)、`OpenAiCompatLlm`、`FakeLlm` 实现。
  - `packages/persona`:新增 `LlmAppraiser`(用 `complete` + JSON + 容错;降级回退 `DefaultAppraiser`)。
  - `packages/memory` 或 `packages/persona`:`MemoryExtractor` 接缝 + `LlmMemoryExtractor` + `NoopMemoryExtractor`(默认)。
  - `packages/runtime`:`Conversation` 回合后调用 extractor(替换内联 naive addMemory),appraisal 时序按配置。
  - `packages/client`:开关/模型选择走配置。
- **依赖**:无新外部依赖(复用已装 SDK;DeepSeek 走已有 OpenAI 兼容 fetch)。
- **延迟预算(§3.2)**:默认配置零首字延迟(appraisal 滞后一轮、extraction 回合后);开启回合前 appraisal 时需显式承担一次额外调用延迟,文档说明、默认关。
- **测试**:record-replay——fake provider 喂罐装 JSON,验证解析正确/乱码降级/抽取去重/appraisal 映射;确定性内核与既有契约不破。

## Non-goals

- 流式结构化输出 / 各家原生 structured-output API(本次统一用 "complete + 要 JSON + 容错解析")。
- 把 appraisal 折叠进主回复的单调用复用(后续优化,先用独立 `complete`)。
- 每 20 轮二级 OCEAN 演化、自我一致性锚定、夜间沉淀(§6.1 后续)。
- 向量/语义召回与抽取记忆的语义去重(P2)。
- 多模态 / 工具调用(无关本次)。
