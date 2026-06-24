## 1. 依赖:ws 客户端(项目当前无 WS)

- [x] 1.1 `packages/providers/package.json` 加 `ws` 依赖与 `@types/ws` devDependency;`pnpm install`(pnpm workspace)
- [x] 1.2 确认 tsconfig `types:["node"]` 与 ws 类型可解析(typecheck 验证)

## 2. Provider:QwenOmniLlm(WS 多模态,audio-in → 文本流)

- [x] 2.1 新建 `packages/providers/src/qwen-omni-llm.ts`:定义最小可注入 WS 接口 `OmniWsLike`(on/send/close/readyState)与默认 `ws` 工厂
- [x] 2.2 实现 `QwenOmniLlm implements LlmProvider`:`id`/`model`/`supportsTools=false`;构造选项 `{ id, model, apiKey, baseURL, instructions?, wsFactory? }`,构造期不连(惰性)
- [x] 2.3 文本兼容面 `stream(req, signal?)`:建连→session.created→session.update(modalities:["text"])→conversation.item.create(input_text)+response.create→聚合 `response.text.delta` yield→`response.done` 收尾关 WS
- [x] 2.4 文本兼容面 `complete(req, signal?)`:复用 stream 聚合为整串
- [x] 2.5 真多模态面 `respondToAudio(audio, opts?, signal?): AsyncIterable<OmniEvent>`:流式 `input_audio_buffer.append`(PcmChunk→base64),收 `input_audio_transcription.completed`(transcript)+ `response.text.delta`/`response.audio_transcript.delta`(text)→ yield 判别联合 `{transcript|text|end}`
- [x] 2.6 AbortSignal 真取消:已 abort 即 fail-fast;流式中 abort → 关 WS、终止生成器;清理幂等不抛(§3.2)
- [x] 2.7 错误处理:`error` 事件 / WS error / 非正常 close → 抛清晰中文错误(供上层降级);鉴权字段不打印

## 3. 注册 + 导出(接缝,§3.1)

- [x] 3.1 `registry.ts` 加具名常量 `QWEN_DASHSCOPE_REALTIME_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'`(无 magic,可导出供测试)
- [x] 3.2 `registerLlm('qwen-omni', cfg => ...)`:apiKey 缺失/空抛清晰中文错误(提示 CHAT_A_LLM_API_KEY/DASHSCOPE);构造 `QwenOmniLlm({ id:'qwen-omni', model, apiKey, baseURL: cfg.baseURL ?? QWEN_DASHSCOPE_REALTIME_URL })`;与现有 `qwen`(纯文本)区分
- [x] 3.3 `index.ts` 导出 `qwen-omni-llm`(QwenOmniLlm / OmniEvent / 常量)

## 4. 测试:mock WS,不触网(TDD)

- [x] 4.1 `test/qwen-omni-llm.test.ts`:FakeWs(同步驱动 open/message/close);文本面 `stream` 正常流式 → 收 text.delta 拼出回复、收 done 收尾;请求体含 session.update modalities:["text"] + 文本内容项
- [x] 4.2 真多模态面 `respondToAudio`:喂 PcmChunk → 断言发了 input_audio_buffer.append(base64);收 transcript.completed + text.delta → yield {transcript} + {text} + {end}
- [x] 4.3 打断取消:stream 进行中 abort signal → 关 WS、生成器终止(不再 yield)
- [x] 4.4 错误降级:WS 发 `error` 事件 / 非正常 close → stream 抛清晰错误(可被上层 catch 降级)
- [x] 4.5 registry 装配:`createLlm({provider:'qwen-omni', model, apiKey})` 返回 QwenOmniLlm、id='qwen-omni';缺 apiKey 抛清晰错误;`listLlmProviders()` 含 'qwen-omni';baseURL 可覆盖
- [x] 4.6 回归:既有 qwen/deepseek/anthropic/fake 用例仍通过

## 5. 收尾与验证

- [x] 5.1 worktree 根 `pnpm -r typecheck` 全绿
- [x] 5.2 worktree 根 `npx vitest run`(或 pnpm test)全绿(新增 + 回归)
- [x] 5.3 自检与 canonical/v3 一致:§3.1 接缝、§3.3 能力驱动、§3.2 行为即配置+优雅降级+真打断;确认未碰 TTS / VoiceLoop,只改 `packages/providers/**`
- [x] 5.4 git add + commit 到当前 worktree 分支(中文提交信息);不 push、不动 main/master
