# 设计:端到端语音回合骨架 VoiceLoop v1（2026-06-23）

> 设计依据:`docs/voice-loop-findings-2026-06-23.md`(5 路调研汇总,高度收敛)。本 spec 只覆盖 **v1 闭环骨架**(InProcess + Fake,CI 可测);真引擎/真音频 I/O / v2 打断打磨 / autonomy 接入各自后续。

## 0. 目标与非目标
**目标**:用现有积木(AudioTransport+InProcess、帧管线 B层+InterruptionFrame、voice-detect VAD/EOU、FakeStt/FakeTts、`Conversation.send`)把"**听 → 想(Conversation.send)→ 说**"串成一个**半双工、事件驱动、一轮=可取消任务**的 `VoiceLoop`,含核心打断 + 被打断半句写回记忆。**纯 PC、CI 确定性可测、零真引擎、零真音频 I/O。**

**非目标(明确不做,留后续)**:
- ❌ 真 STT/TTS 引擎、真麦克风/扬声器 I/O(B/C 档,独立切片)。
- ❌ 先 pause 后定夺 + backchannel 抑制 + AudioTransport 的 pause/resume/wait_for_playout(v2)。
- ❌ 预测性生成。
- ❌ autonomy 主动 turn 接入 + 完整 SpeechHandle/优先级队列(autonomy 接线时)。
- ❌ WebSocketTransport(§8)。
- ❌ 改 `Conversation.send` 签名(零改焦点;见 §4 限制)。

## 1. 架构与文件
- **定位**:`VoiceLoop` 是 `runtime` 包内**薄外壳**,**不碰 `conversation.ts`/`turn-shared.ts` 主体**(承 Q3 零改 Conversation),只在外侧消费其 `send(text, onToken)`。
- **新文件(仅新增,runtime)**:
  - `packages/runtime/src/voice-turn-state.ts` — `VoiceState` 枚举 + 合法迁移表 + 迁移→BusEvent 映射。
  - `packages/runtime/src/sentence-splitter.ts` — 句级切分(搬 voice-core:CJK 友好、缩写表、`maxChars` 上限防 TTS 溢出、标点 fallback)。
  - `packages/runtime/src/voice-loop.ts` — `VoiceLoop` 编排器(状态机 + 听→想→说 + 打断)。
  - 测试:`packages/runtime/test/voice-loop.test.ts`、`sentence-splitter.test.ts`、`voice-turn-state.test.ts`。
  - `index.ts` 仅追加导出。
- **依赖注入**(VoiceLoop 构造参数,全经接口/接缝):`{ transport: AudioTransport, vad: VadDetector, turnDetector: TurnDetector, stt: SttProvider, tts: TtsProvider, send: (text, onToken)=>Promise<string>, memory: Pick<MemoryStore,'appendMessage'>, bus: LightVoiceBus, sessionId, clock?: ()=>number }`。`send` 由调用方传 `conversation.send.bind(conversation)`(VoiceLoop 不直接依赖 Conversation 类)。

## 2. 状态机(单一四态 + 瞬态)
`VoiceState = 'listening' | 'endpointing' | 'thinking' | 'speaking' | 'barge_in_pending'`

| 迁移 | 触发 | 发 BusEvent(§4.2.1) | 动作 |
|---|---|---|---|
| listening → endpointing | VAD `speech_start` | `vad:speech_start` | 开始累积音频帧 |
| endpointing → listening | 长时静音/无语音放弃 | `vad:speech_end` | 丢弃累积 |
| endpointing → thinking | EOU 判"说完"(turnDetector 动态 endpointing) | `stt:final` | STT 转写 → 触发 send |
| thinking → speaking | 首句 TTS 音频就绪 | `tts:first_audio` | 状态置 speaking |
| speaking → listening | 播放排空(send 完成且 TTS 出尽) | `turn:end` | 回合结束 |
| speaking → barge_in_pending | SPEAKING 中 VAD `speech_start` | `vad:speech_start` | 进入打断判定 |
| barge_in_pending → listening | **v1 即时判真** | `turn:interrupt` | 执行打断(§4) |

- 迁移集中在一个 `#transition(to, event)` 方法:校验合法迁移、emit BusEvent、设状态。非法迁移记 warn 不抛(§3.2)。
- **v1 `barge_in_pending` 进入即解析为真打断**(同 tick);命名态保留,**v2 在此插入 `false_interruption_timeout` 2s timer + backchannel 判定不需重构**。
- 状态迁移即 §4.2.1 BusEvent → 天然可追溯(承可追溯性原则);帧级 token/chunk 不上总线(留 B 层)。

## 3. 数据流(听→想→说)
1. `transport.onAudio(frame)` → 喂 `vad`;VAD 出 `speech_start` → `listening→endpointing`,累积音频帧。
2. `turnDetector` 据 VAD/EOU(已有动态 endpointing,§5b)判"说完" → `endpointing→thinking`。
3. **STT**:`stt.transcribe(累积音频)` → 文本(FakeStt 按脚本/注入返回)。空文本/失败 → 回 `listening`(降级,§3.2)。
4. **想**:`send(text, onToken)`。`onToken` 累积进 `#replyAccum`,并喂 `SentenceSplitter`;每凑成一句 → `tts.synthesize(句)` → 音频块 → **gen 自检通过**后 `transport.sendAudio`(经帧管线配速,B层);首句到达 → `thinking→speaking`。
5. `send` resolve(完整回复)且 TTS 出尽 → `speaking→listening`,`#replyAccum` 清空。

## 4. 打断 + generation + 半句写回
- VoiceLoop 持 `#currentGen: number`(单调 +1/回合)与 `#replyAccum: string`。
- **回合令牌(v1 最小)**:无完整 SpeechHandle;每回合一个 `generationId`。**作废采用生产端自检**:VoiceLoop 在每次 `transport.sendAudio` / 喂 TTS 前自检 `gen === #currentGen`,不等则不发(VoiceLoop 是单消费者单生产者,自检即足)。**不改 protocol 帧类型**;P-1 帧管线的下游 generation 过滤作为可选双保险/后续,非 v1 依赖。
- **打断流程**(`barge_in_pending→listening`):
  1. `#currentGen++`(在途旧 TTS 帧立即作废)。
  2. `transport.clearBuffer()`(排空已下发未播的输出音频)。
  3. **半句写回**:`memory.appendMessage({ role:'assistant', content: #replyAccum + '[被用户打断]', ... })`(承 OLV:小雪记得被打断在哪)。仅当 `#replyAccum` 非空。
  4. 停止消费当前 `send`(见限制)、状态回 `listening`、清 `#replyAccum`。
- **⚠️ v1 限制(诚实标注)**:`Conversation.send` 不可取消(零改签名,Q3)。故 v1 打断 = **协作式放弃**——`onToken` 在 `#currentGen` 变更后变 no-op(不再喂 TTS),在途 `send`/LLM 在后台跑完但输出被忽略(FakeLlm 即时,无浪费;真 LLM 会浪费尾部 token)。**后续优化**:给 `Conversation.send` 加可选 `AbortSignal`(单独切片),实现真取消。
- 半句写回走 `memory.appendMessage`(非完整 finalizeTurn:v1 不在打断点跑情绪/closeness/trace 收尾)——v1 简化,记为后续可补。

## 5. 测试(CI 确定性:Fake/InProcess + 注入时钟/概率)
- `sentence-splitter.test.ts`:CJK/拉丁切句、缩写不误切、maxChars 上限、fallback、残余 flush。
- `voice-turn-state.test.ts`:合法迁移通过 + 发对 BusEvent;非法迁移 warn 不抛。
- `voice-loop.test.ts`(注入 FakeStt 脚本文本、FakeTts、合成 VAD 概率序列、注入时钟、recording bus + fake memory):
  1. **正常闭环**:喂"语音→静音"→ 走完 listening→endpointing→thinking→speaking→listening,BusEvent 顺序正确,FakeTts 音频帧经 transport 下行送出,句级切分正确。
  2. **打断**:SPEAKING 中再来 speech_start → `turn:interrupt`、`#currentGen++`、`transport.clearBuffer()` 被调、陈旧帧被丢弃、半句 `[被用户打断]` 经 `memory.appendMessage` 写回、回 listening。
  3. **降级**:STT 空/抛错 → 回 listening 不崩;非法迁移不崩。
  4. **generation 作废**:旧 generation 的 TTS 帧在打断后不再下行。

## 6. 改动清单
- **新增**:`voice-loop.ts` / `voice-turn-state.ts` / `sentence-splitter.ts` + 3 测试(均 runtime 包)。
- **微改**:`runtime/src/index.ts` 追加导出;**给 `AudioTransport` 加 `clearBuffer()`**(protocol 接口 + InProcessAudioTransport 实现,承 Q5——唯一被 v1 打断用到的;pause/resume/wait_for_playout 留 v2)。
- **不改**:conversation.ts/turn-shared.ts/tool-calling-strategy.ts 主体;providers/memory/persona/cognition。

## 7. 风险与缓解
- **send 不可取消致尾部浪费**(真 LLM)→ v1 用 Fake 无碍;记为"加 AbortSignal"后续切片。
- **半句写回绕过 finalizeTurn**(无情绪/closeness/trace)→ v1 可接受(打断是少数路径);后续可让打断点跑精简 finalize。
- **状态机/打断竞态**→ 单消费者(VoiceLoop 单 asyncio 上下文)+ generationId 双保险;迁移集中单方法 + 测试覆盖打断时序。
- **clear_buffer 语义**(InProcess)→ 明确为"输出端丢弃已入队未投递音频帧",Fake 播放端据此丢弃,测试断言被调 + 陈旧帧不达。
