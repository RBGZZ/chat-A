## 1. 依赖

- [x] 1.1 `packages/providers/package.json` 加 `ws`(dependencies)与 `@types/ws`(devDependencies),pnpm 安装

## 2. Provider:QwenTtsRealtime(注入式 WS 端口,流式/取消/降级/能力门)

- [x] 2.1 定义注入端口 `QwenWsLike`(send/close/on)与 `QwenWsFactory`(url+headers → QwenWsLike);缺省工厂懒加载 `ws` 建真连接
- [x] 2.2 `QwenTtsRealtime implements TtsProvider`:构造吃 model/voice/apiKey/endpoint/responseFormat/mode/instructions/sampleRate/languages + 可选 wsFactory;apiKey 缺失/空 → 构造 fail-fast(提示设 `CHAT_A_DASHSCOPE_API_KEY`)
- [x] 2.3 能力声明:`languages:['*']` / `voiceId:[voice]` / `sampleRate:24000` / `streaming:true` / `voiceCloning:false`
- [x] 2.4 `synthesize`:能力门 `assertTtsLanguage`/`assertTtsCloning` 先行;连 WS → `session.update` → `input_text_buffer.append` →(commit 模式)`commit` → `session.finish`;`response.audio.delta` base64 → s16le → `PcmChunk` 逐帧 yield(carry 半样本进位)
- [x] 2.5 AbortSignal 真取消:进入即查 aborted;监听 abort → `input_text_buffer.clear` + close WS + 结束迭代;finally 清理 listener/关 WS
- [x] 2.6 优雅降级:WS error / 异常 close / 服务端 `error` 事件 → 抛带上下文中文 Error(含 provider/阶段/错误片段,**不含 key**)
- [x] 2.7 内部异步队列桥接「事件回调 → for-await」;done/error/close 推哨兵结束;`append` 消息体构造抽成可改的内部函数(协议歧义可控)

## 3. 配置与注册

- [x] 3.1 `tts-config.ts`:加判别联合分支 `QwenTtsRealtimeConfig`(`kind:'qwen-tts'`,字段贴合真实参数);`loadTtsConfig` 支持 `CHAT_A_TTS_KIND=qwen-tts` + env(model/voice/apiKey/endpoint/responseFormat/mode/instructions/sampleRate);apiKey 回落 `CHAT_A_DASHSCOPE_API_KEY`
- [x] 3.2 `tts-registry.ts`:`TtsPorts` 加可选 `qwenWsFactory`;登记 `'qwen-tts'` 工厂,透传配置 + wsFactory 端口
- [x] 3.3 `index.ts`:导出 `QwenTtsRealtime` 与相关类型

## 4. 测试(mock WS,不触网)

- [x] 4.1 正常流式:mock WS 脚本化 open→audio.delta×N→response.done → 产出对应 PcmChunk(24kHz/mono/Int16,base64 解码正确,逐帧 yield)
- [x] 4.2 AbortSignal 中途取消:取消后停止产出,且发了 `input_text_buffer.clear` 并 close WS
- [x] 4.3 错误降级:服务端 `error` 事件 / WS error → 抛清晰中文错误(不含 key)
- [x] 4.4 能力门:不支持复刻却传 refAudio → fail-fast;限定语种 + 外语种 → fail-fast
- [x] 4.5 构造:缺 apiKey → 构造 fail-fast(提示环境变量)
- [x] 4.6 工厂/配置:`createTts({kind:'qwen-tts',...}, {qwenWsFactory})` 建真实例;`loadTtsConfig` 解析 `qwen-tts` env;`listTtsKinds()` 含 `'qwen-tts'`

## 5. 验证

- [x] 5.1 worktree 根 `pnpm -r typecheck` 全绿(新依赖/新分支不级联破坏其它包)
- [x] 5.2 worktree 根 `npx vitest run`(或 `pnpm -r test`)全绿:新测试通过 + 既有 TTS 回归不破
- [x] 5.3 自检与 canonical 一致:§4 流式优先、§4.1/§4.3 能力门+可换性、§3.2 行为即配置;确认只改 `packages/providers/**`,未碰 LLM/omni
