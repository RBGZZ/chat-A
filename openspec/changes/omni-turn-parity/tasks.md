## 1. Conversation 收尾入口 finalizeExternalTurn(TDD 先测)

- [ ] 1.1 在 `packages/runtime/src/conversation.ts` 新增方法 `finalizeExternalTurn(userText, reply, opts?: { prosodyEmotion?: SttEmotionLike }): Promise<void>`:开自有 `turn` span + correlationId(emit `turn:start`/`turn:end`,**不**开 llm span)、读 `closeness`/`mood = persona.tone(closeness)`、`detectStance(deps, userText)`、关键词召回 `deps.memory.recall(userText)`(失败降级空)、用内部 `#turnSeq` 取回合序号,组装 system/messages 的合成值(`composeOmniInstructions` system + `[{role:'user',content:userText},{role:'assistant',content:reply}]`),调既有 `finalizeTurn(deps, {...})`(透传 prosodyEmotion 若有)。整体 try/catch 记 warn 不上抛(§3.2)。
- [ ] 1.2 先写测 `packages/runtime/test/conversation-finalize-external.test.ts`(后让 1.1 转绿):①调用后记忆有一条 user(=userText)+ 一条 assistant(=reply);②传 prosodyEmotion → persona PAD 被推进且经一次 advance(以 fake persona 断言 advance 调用入参含 prosodyEmotion);③**不**触发 LLM(注入会抛错/计数的 fake llm,断言其 stream 零调用)、不开 llm span;④收尾某步抛错(fake memory.addMemory 抛)→ 方法不上抛、其余步骤仍尽力完成;⑤closeness 抬升 / 立场 advance / traceSink.record 被调用。
- [ ] 1.3 核实 `finalizeTurn` 是否需把 `system`/`messages` 入参可选化:若合成值满足 trace 即保持不改;若需要,做最小重构(`turn-shared.ts` 把这两个入参标可选 + trace 缺省占位),并补/改对应测试。

## 2. VoiceLoop omni 收尾改走新接缝(TDD 先测)

- [ ] 2.1 `VoiceLoopDeps` + `VoiceLoop` 构造:新增**可选** `finalizeTurn?: (userText, reply, opts?: { prosodyEmotion?: SttEmotionLike }) => void | Promise<void>`(exactOptional 风格,中文注释:缺省不注入→不新增收尾副作用,零回归)。
- [ ] 2.2 改 `#startThinkingOmni`:在回合**自然结束**收尾处(`end`/流结束、句出尽、`#finishTurn` 前),以 `userText`=本轮首条 transcript、`reply`=`#replyAccum`(已剥标签的干净文本)、`prosodyEmotion`=`lastEmotion`(若有)调一次注入的 `finalizeTurn` 接缝(`void` 化 + try/catch 吞错,§3.2);gen 失配则不调(协作放弃)。**移除** `transcript` 事件里手动 `appendMessage(role:'user')`(消息落库收口到收尾)。
- [ ] 2.3 prosody 收口:omni 收尾**不再**调 `advanceProsody`(其语义被收尾接缝覆盖)。按 design D3 / Open Questions 决定 `advanceProsody` 钩子去留——移除则同步删 P1 接线与相关断言;保留兼容空位则标注 deprecated 且 omni 路不调用它。
- [ ] 2.4 扩 `packages/runtime/test/voice-loop-omni.test.ts`(或新文件):①注入 `finalizeTurn` 接缝 + 完整 omni 回合 → 接缝被调一次、入参 userText=transcript / reply=剥标签后干净文本 / prosodyEmotion 正确;②收尾接缝抛错 → 回合照常收尾回 listening 不崩;③未注入接缝 → 接缝零调用、transcript 事件不再手动写 user 消息(无重复)、回合干净收尾;④被打断回合 → 收尾接缝**不**被调用、半句仍经 `#interrupt` 写回(路径不变);⑤reply/半句写回均不含 `[user_emotion:...]` 标签(剥离保留)。先测后改实现转绿。

## 3. 装配层接线

- [ ] 3.1 `packages/client/src/cli-voice.ts`:`VoiceModeDeps` 加可选 `finalizeTurn?`;`startVoiceMode` 仅在 omni 路且提供时透传进 `loopDeps`(镜像现有 `composeOmniInstructions`/`advanceProsody` 接线,exactOptional)。同步处理 `advanceProsody` 去留(按 2.3 决定)。
- [ ] 3.2 `packages/client/src/assembly/app.ts`:导出 `finalizeTurn: (u, r, o) => convo.finalizeExternalTurn(u, r, o)`(供 cli/desktop 注入);若 2.3 决定移除 `advanceProsody`,同步删除其导出与接线。核实 `packages/desktop/src/main.ts` 是否复用同套 omni 装配,若是则一并接线。

## 4. 收口与校验

- [ ] 4.1 `npx openspec validate omni-turn-parity --strict` 通过。
- [ ] 4.2 `pnpm -r typecheck` 全绿。
- [ ] 4.3 相关包测试绿:`@chat-a/runtime`、`@chat-a/persona`、`@chat-a/memory`、`@chat-a/client`(`npx vitest run <路径>`);最好全量 `npx vitest run` 绿(确认零回归,尤其 STT 路 / 文字路 / P1 omni-prosody 归档场景)。
- [ ] 4.4 在 worktree 分支 `git commit`(中文 message,`feat(voice):` 风格);不 push、不碰 master(除 propose 提交另议)。
