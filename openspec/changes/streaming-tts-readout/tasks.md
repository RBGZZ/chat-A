## 1. CosyVoiceTts 同会话流式接口

- [x] 1.1 `cosyvoice-tts.ts` 加流式接口(如 `synthesizeStream(opts?)` 返回 `{ push(text), finish(), chunks: AsyncIterable<PcmChunk> }`):一条 WS run-task,等 task-started 后冲刷缓冲的 push;push→continue-task、finish→finish-task;二进制帧→PcmChunk(复用 ByteFrameQueue/s16le 进位);注入 wsFactory+taskId。
- [x] 1.2 task-started 前 push 的文本缓冲、started 后按序冲刷(防竞态)。**厘清两条收尾路径**:`finish()`=发 finish-task 正常收尾(等服务端合完剩余);**`abort`(打断)=直接 close 丢弃在途音频,不走 finish-task**(现 synthesize 的 onAbort 是先 finish-task 再 close,流式打断不要这样)。task-failed 错误透出。
- [x] 1.3 单测(注入 mock WS + 固定 taskId):多次 push 进同一 task、首句先出、finish 收尾、缓冲冲刷、取消、task-failed;断言一次性 `synthesize` 不变。

## 2. 类型/能力位(可选接口)

- [x] 2.1 在 `tts.ts` 定义可选 `StreamingTtsProvider`(或在 TtsCapabilities 加 `streamingFeed` 位),CosyVoiceTts 实现;其它 provider 不实现(上层据此回落整段)。— 加 `StreamingTtsProvider`/`TtsStreamSession` 接口 + `supportsStreamingFeed(provider)` 运行时判定;CosyVoiceTts implements。
- [x] 2.2 providers index 导出新类型。— `tts.ts` 经 `index.ts` 的 `export * from './tts'` 自动导出。

## 3. desktop 朗读路流式 + 门控 + 降级

- [x] 3.1 先读 `main.ts` 的 send/onToken/speakReply/makeSynthesize 与 ipc-contract 的 runSpeakReply,**核定接线点**(勿臆断)。— 已核定:`send` handler 内 `handle.convo.send(t, onToken)`、`speakReply(handle, reply, signal)` 后台跑、`makeSynthesize` 逐句端口、`runSpeakReply` 编排。
- [x] 3.2 门控 `CHAT_A_TTS_STREAM_READOUT`(默认 off)。**第一步**:流式模式下,speakReply 拿到 spokenText 后,**句切 + 同 session 逐句喂**(用流式接口)取代整段一次合成;每块经 IPC.ttsAudio 推渲染层。打断 abort 流式会话 + ttsAudioStop。— 新增 `runStreamSpeakReply`(pure)+ `makeStreamSession`/`makeSentenceFeed`(runtime `SentenceSplitter`,**非** `splitReplySentences`)。
- [x] 3.3 **第二步(本 change 必做,才真解 R7)**:把朗读**挂到回合 token 流**:同语种(无翻译)时 onToken 经 SentenceSplitter 边生成边喂同 session,首句到齐即出声。异语种仍翻译后流式喂。— 新增 `makeTokenStreamReadout`(pure)+ `speakReplyFromTokens`;`send` handler 把 `onToken` tee 进句切流式会话,回合后 `done()` 收尾;consumed reject → 降级整段。
- [x] 3.4 降级:流式抛错 → try/catch 回落整段一次合成(或跳过该次),不崩;非 cosyvoice 引擎门控开了也回落整段。— speakReply 流式 catch → 整段路;`supportsStreamingFeed` 守门;step-two consumed.catch → speakReply 整段。

## 4. 收口与校验

- [x] 4.1 全量 `pnpm -r typecheck` + 相关包测试绿(providers/desktop);新增流式接口 golden。— providers 335 绿(含 7 新流式单测)、desktop ipc-contract 57 绿(含 8 新编排单测)、`pnpm -r typecheck` 全绿。
- [x] 4.2 desktop typecheck + bundle 构建通过。— `pnpm --filter @chat-a/desktop run build:bundle` 通过(dist/main.mjs)。
- [x] 4.3 `openspec validate streaming-tts-readout --strict` 通过。
- [x] 4.4 README/记忆补 `CHAT_A_TTS_STREAM_READOUT` 说明 + 与 bilingual(后续复用本流式 API)的关系。— README「流式朗读」节已补(含两步说明、降级、复用关系)。⚠️ **跨 change 去重**待 bilingual 复活时按本任务注记处理(本 change 不动 parked 文件)。
- [ ] 4.5(真机)开 `CHAT_A_TTS_STREAM_READOUT` 重启:听首音是否更快 + 音色与整段一致(同语种场景对比 R7)。— **未做(需真机/真 DashScope 网络与音频设备)**。
