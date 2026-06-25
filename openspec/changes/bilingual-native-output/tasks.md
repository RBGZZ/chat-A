## 1. prompt:门控双语输出指令贡献者

- [ ] 1.1 在 `packages/cognition/src/prompt/` 新增 dual-output contributor:入参含"是否双语态 + 显示语种 + 合成语种";生效时注入"先显示语种正文 → 哨兵 `⟦SPOKEN:<lang>⟧` → 合成语种**原生**口语版(同义不直译、保人设语气、纯口语不带括号)"指令;否则返 null(零注入)。同步纯函数。
- [ ] 1.2 定义哨兵常量(稳定抗冲突,单一真相源,desktop 复用同一常量)。
- [ ] 1.3 单测:生效时含双输出指令 + 哨兵;未生效 null;确定性。
- [ ] 1.4 接进 composeSystem 的 contributor 列表(门控:仅双语态注入;同语种/off 时等价不加)。**核对该贡献者经 desktop 走的 composeSystem 生效**(参照 StyleDisciplineContributor 在 conversation.ts 的注册)。

## 2. desktop:流式拆分(显示截流 + spoken 提取)

- [ ] 2.1 先读 `packages/desktop/src/main.ts` 的文字回合 send/onToken 编排 + speakReply,**核定真实接线点**(勿臆断签名)。
- [ ] 2.2 实现哨兵流式检测器(纯函数/小类,带跨 token 边界小缓冲):喂 token 流 → 区分"哨兵前(显示)/哨兵后(spoken)";哨兵可被任意切分仍识别。单测覆盖跨 token 切分、哨兵不出现、哨兵在块首/块尾。
- [ ] 2.3 双语态回合:哨兵前 token 照常 `emit(chat:token)`;命中后不推显示、累积 spokenText。回合结束:displayText=哨兵前(进气泡/记忆原样)、spokenText=哨兵后。
- [ ] 2.4 门控:`CHAT_A_TTS_DUAL_OUTPUT`(默认 off)+ 仅显示≠合成语种(复用 resolveSpokenPlan 判定)时进双语路;否则现状。回归断言:off/同语种时 onToken 与朗读逐字不变。

## 3. desktop:原生 spoken 喂 TTS + 降级

- [ ] 3.1 双语态:用提取的原生 spokenText 走 `runSpeakReply`/合成,**取代**本回合 translateForSpeech。
- [ ] 3.2 降级(§3.2):无哨兵/哨兵后空/提取失败 → 回落现有 translateForSpeech(再不行 displayText 直接合成);**translateForSpeech 保留不删**;不崩、不中断朗读。单测覆盖降级分支。

## 4. 收口与校验

- [ ] 4.1 全量 `pnpm -r typecheck` + 相关包测试绿(cognition/desktop);新增哨兵检测器 + 贡献者 + 降级 golden。
- [ ] 4.2 desktop typecheck + bundle 构建通过。
- [ ] 4.3 `openspec validate bilingual-native-output --strict` 通过。
- [ ] 4.4 README/记忆补开关说明(`CHAT_A_TTS_DUAL_OUTPUT`,与 CHAT_A_DISPLAY_LANG/CHAT_A_TTS_LANG 关系)+ design Open Questions(哨兵形态、voice-loop 后续)。
- [ ] 4.5(真机,可选)显示中文+合成日语开双语:对比原生口语版 vs 旧翻译版的自然度 + 首音延迟。
