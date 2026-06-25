## 1. CosyVoiceTts 同会话流式接口

- [ ] 1.1 `cosyvoice-tts.ts` 加流式接口(如 `synthesizeStream(opts?)` 返回 `{ push(text), finish(), chunks: AsyncIterable<PcmChunk> }`):一条 WS run-task,等 task-started 后冲刷缓冲的 push;push→continue-task、finish→finish-task;二进制帧→PcmChunk(复用 ByteFrameQueue/s16le 进位);注入 wsFactory+taskId。
- [ ] 1.2 task-started 前 push 的文本缓冲、started 后按序冲刷(防竞态)。**厘清两条收尾路径**:`finish()`=发 finish-task 正常收尾(等服务端合完剩余);**`abort`(打断)=直接 close 丢弃在途音频,不走 finish-task**(现 synthesize 的 onAbort 是先 finish-task 再 close,流式打断不要这样)。task-failed 错误透出。
- [ ] 1.3 单测(注入 mock WS + 固定 taskId):多次 push 进同一 task、首句先出、finish 收尾、缓冲冲刷、取消、task-failed;断言一次性 `synthesize` 不变。

## 2. 类型/能力位(可选接口)

- [ ] 2.1 在 `tts.ts` 定义可选 `StreamingTtsProvider`(或在 TtsCapabilities 加 `streamingFeed` 位),CosyVoiceTts 实现;其它 provider 不实现(上层据此回落整段)。
- [ ] 2.2 providers index 导出新类型。

## 3. desktop 朗读路流式 + 门控 + 降级

- [ ] 3.1 先读 `main.ts` 的 send/onToken/speakReply/makeSynthesize 与 ipc-contract 的 runSpeakReply,**核定接线点**(勿臆断)。
- [ ] 3.2 门控 `CHAT_A_TTS_STREAM_READOUT`(默认 off)。**第一步**:流式模式下,speakReply 拿到 spokenText 后,**句切 + 同 session 逐句喂**(用流式接口)取代整段一次合成;每块经 IPC.ttsAudio 推渲染层。打断 abort 流式会话 + ttsAudioStop。⚠️ **句切必须用 runtime `SentenceSplitter`(desktop 已依赖 @chat-a/runtime),不是现 `splitReplySentences`**(后者故意返整段、保留给降级路)。
- [ ] 3.3 **第二步(本 change 必做,才真解 R7)**:⚠️ 仅第一步(整段后句切流式喂)**首音 ≈ 整段生成时间,R7 基本没动**——因 speakReply 在 `convo.send` 返回整段后才跑。真正解 R7 需把朗读**挂到回合 token 流**:同语种(无翻译)时 onToken 经 SentenceSplitter 边生成边喂同 session,首句到齐即出声。异语种仍翻译后流式喂(翻译延迟根治走 bilingual)。**若本次时间所限只落第一步,须在 README/记忆显式标注"R7 首音未解,待第二步"**,别让人误以为已解。
- [ ] 3.4 降级:流式抛错 → try/catch 回落整段一次合成(或跳过该次),不崩;非 cosyvoice 引擎门控开了也回落整段。

## 4. 收口与校验

- [ ] 4.1 全量 `pnpm -r typecheck` + 相关包测试绿(providers/desktop);新增流式接口 golden。
- [ ] 4.2 desktop typecheck + bundle 构建通过。
- [ ] 4.3 `openspec validate streaming-tts-readout --strict` 通过。
- [ ] 4.4 README/记忆补 `CHAT_A_TTS_STREAM_READOUT` 说明 + 与 bilingual(后续复用本流式 API)的关系。⚠️ **跨 change 去重**:本 change 的 tts-engine ADDED「CosyVoiceTts 同会话流式喂文本」archive 后进主 spec;**bilingual-native-output(parked)那份 tts-engine ADDED 是近义重复**,bilingual 复活时须把它**删除或改 MODIFIED**(复用本 change 已落地的需求),避免主 spec 出现两条讲同一件事的 Requirement。在 bilingual 的 design「审查发现」区也记一笔。
- [ ] 4.5(真机)开 `CHAT_A_TTS_STREAM_READOUT` 重启:听首音是否更快 + 音色与整段一致(同语种场景对比 R7)。
