## 1. 纯函数:标签解析 + 流式安全剥离(TDD 先测)

- [x] 1.1 在 runtime 新增 `user-emotion-tag.ts`:导出常量 `OMNI_USER_EMOTION_DIRECTIVE`(中文标签门控指令文案,单一真相源)、7 类标签集合、纯函数 `stripUserEmotionTag(text) → { cleanText, emotion?: SttEmotionLike }`(尾部解析、多标签取最后、label 非 7 类/intensity 非法 → emotion 缺席、剥除所有标签)、纯函数 `splitSafeTextForTag(pending) → { emit, hold }`(hold-back:末尾可能是半截标签前缀 `[user_emotion…` 时留住不 emit)。
- [x] 1.2 先写 golden 测 `test/user-emotion-tag.test.ts`:尾部标签解析、无标签(cleanText 原样、emotion 缺席)、畸形(label 非法/intensity 越界)、多标签取最后、intensity→confidence(`/10` clamp)、`splitSafeTextForTag` 半截前缀 hold-back / 完整标签可 emit。再让 1.1 实现转绿。

## 2. VoiceLoop:剥标签 + 喂 PAD 钩子(TDD 先测)

- [x] 2.1 `VoiceLoopDeps` + `VoiceLoop` 构造:新增可选 `advanceProsody?: (emotion: SttEmotionLike) => void | Promise<void>`(exactOptional 风格,镜像 `composeOmniInstructions?`;中文注释:缺省不注入→零回归)。
- [x] 2.2 改 `#startThinkingOmni`:`text` 增量改走 `pendingText` 累积 + `splitSafeTextForTag` 喂 splitter(hold-back);`#replyAccum` 累积**剥标签后**干净文本;`end`/流结束时对 `pendingText` 调 `stripUserEmotionTag`,把剩余 cleanText 喂 splitter+flush,据 emotion 调 `advanceProsody`(void 化 + try/catch 吞错,§3.2)。仅 omni 路改,STT 路不动。
- [x] 2.3 扩 `test/voice-loop-omni.test.ts`(或新文件):①注入钩子+尾部标签→钩子以正确 `SttEmotionLike` 被调一次、TTS/`#replyAccum` 不含标签;②缺省不注入→钩子零调用、标签仍被剥(不进 TTS);③无标签→钩子不调、正文照常;④多标签取最后;⑤钩子抛错→回合照常收尾不崩;⑥半句写回(打断)内容不含标签。先写测后改实现转绿。

## 3. Conversation:omni 指令注入 + advanceProsody 方法(TDD 先测)

- [x] 3.1 `composeOmniInstructions` 末尾追加 `OMNI_USER_EMOTION_DIRECTIVE`(omni-only);新增 `advanceProsody(emotion: SttEmotionLike)` 方法,内部 `this.#deps.persona.advance('', { prosodyEmotion: emotion })`(同一 persona 实例)。
- [x] 3.2 扩 `test/conversation.test.ts`:①`composeOmniInstructions()` 输出含标签指令且含 7 类标签名;②`send` 走的系统提示(`composeSystem`)**不含**该指令(omni-only 隔离);③`advanceProsody(emotion)` 调用后 persona PAD 被 prosody 拉力推进(以 fake/真 persona 断言 PAD 变化或 advance 被调）。先测后实现。

## 4. 装配层接线

- [x] 4.1 `packages/client/src/cli-voice.ts`:`VoiceModeDeps` 加可选 `advanceProsody?`;`startVoiceMode` 仅在 omni 路且提供时透传进 `loopDeps`(镜像 `composeOmniInstructions` 接线,exactOptional)。
- [x] 4.2 `packages/client/src/assembly/app.ts`:`composeOmniInstructions` 同处导出 `advanceProsody: (e) => convo.advanceProsody(e)`(供 cli/desktop 注入);核实 `packages/desktop/src/main.ts` 是否复用同套 omni 装配,若是则一并接线。

## 5. 收口与校验

- [x] 5.1 `npx openspec validate omni-prosody-to-pad --strict` 通过。
- [x] 5.2 `pnpm -r typecheck` 全绿。
- [x] 5.3 相关包测试绿:`@chat-a/runtime`、`@chat-a/persona`、`@chat-a/client`、`@chat-a/cognition`(`npx vitest run <路径>`);最好全量 `npx vitest run` 绿(确认零回归)。
- [x] 5.4 在 worktree 分支 `git commit`(中文 message,`feat(voice):` 风格);不 push、不碰 master。
