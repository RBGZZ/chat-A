> **实施转向(2026-06-25)**:原计划「主 LLM 一次产『显示正文 + 哨兵 + 合成语种口语版』,desktop 按哨兵流式拆分」。
> 真机实测 **qwen-plus 不稳定遵从该双段+哨兵格式**(经常只出一段/漏哨兵),拆分路不可靠。
> 故活路径改为 **音频优先(audio-first)**:**回复本身直接用合成语种**(`outputLang=合成语种`),desktop 逐句**直接**流式喂 TTS
> (首音最快、无翻译阻塞);显示语种由 desktop 在音频之后翻译**覆盖**气泡(文字次要)。**音频路彻底免翻译往返**——
> 比原方案更直接地达成「原生口语 + 省第二次翻译」目标。
>
> 哨兵那套(`DualOutputContributor` / `DualOutputSplitter` / `makeDualOutputReadout` / `dualOutput` 形参 / `extractDisplaySegment`)
> **已完整实现并单测覆盖,但默认门控关闭、无调用方接线 → 零注入、不影响现状**,保留为**休眠的未来扩展点**(更强、能稳定遵从格式的模型可直接启用)。
> 详见 design.md「实施转向」与 Open Questions。

## 1. prompt:门控双语输出指令贡献者(已实现;休眠,留作未来扩展点)

- [x] 1.1 在 `packages/cognition/src/prompt/` 新增 `DualOutputContributor`:`ctx.dualOutput` 非空时注入「先口语段→哨兵→显示段」格式指令;否则返 null(零注入)。同步纯函数。
- [x] 1.2 定义哨兵常量 `DUAL_OUTPUT_SENTINEL='⟦SPOKEN⟧'`(罕见数学括号,抗误撞;不与 stripStageDirections 剥离的括号冲突;单一真相源,desktop 复用)。
- [x] 1.3 单测(`dual-output.test.ts`):生效含格式指令+哨兵;缺省/空语种 null;priority 最末;`extractDisplaySegment` golden。
- [x] 1.4 接进 composeSystem 的 contributor 列表(conversation.ts 注册;门控:仅 `dualOutput` 非空才注入)。**注:活路径走 audio-first、不填 `dualOutput` → 该贡献者恒 null(休眠)**。

## 2. desktop:流式拆分(显示截流 + spoken 提取)(已实现;休眠)

- [x] 2.1 核定 main.ts 文字回合 send/onToken 编排 + speakReply 真实接线点。
- [x] 2.2 哨兵流式分流器 `DualOutputSplitter`(纯/带跨 token 边界尾缓冲);单测覆盖跨 token 切分、哨兵不出现、块首/块尾。
- [x] 2.3 `makeDualOutputReadout`:口语段(哨兵前)逐句流式喂 TTS、显示段(哨兵后)推气泡;done 返回显示文本。单测覆盖。
- [x] 2.4 门控判定 `resolveDualSpokenLang`(开关+朗读+可用+引擎支持流式+显示≠合成语种)。**注:活路径未调用 `makeDualOutputReadout`(改用 audio-first 的 `makeTokenStreamReadout`)**。

## 3. desktop:audio-first 活路径(回复直出合成语种 + 流式喂 TTS + 翻译显示 + 降级)

- [x] 3.1 `app.ts`:`CHAT_A_TTS_DUAL_OUTPUT=on` + 显示≠合成语种 → `audioFirst`,`outputLang=合成语种`(回复直接是合成语种文本)。
- [x] 3.2 `main.ts`:audio-first 回合用 `makeTokenStreamReadout` 把回复逐 token **直接**流式喂 TTS + 同步推气泡;音频流式失败 → 整段 `speakReply` 兜底(§3.2)。
- [x] 3.3 文字次要:回合后把合成语种回复翻成显示语种作 send 返回值 → `runSendTurn` 定型覆盖气泡;翻译失败 → 保留合成语种原文(有字尽力)。
- [x] 3.4 `stripStageDirections` 确定性去括号旁白兜底(显示定型 + 喂 TTS 前都过一道);`runSendTurn` 定型用 `extractDisplaySegment`+`stripStageDirections`。单测覆盖。

## 4. 收口与校验

- [x] 4.1 全量 `pnpm -r typecheck` + `vitest run` 绿(149 文件 / 1540 测试;含哨兵分流器/贡献者/stripStageDirections/降级 golden)。
- [x] 4.2 desktop typecheck + `build:bundle` 通过。
- [x] 4.3 `openspec validate bilingual-native-output --strict` 通过。
- [x] 4.4 README + 记忆补开关说明(`CHAT_A_TTS_DUAL_OUTPUT`,与 `CHAT_A_DISPLAY_LANG`/`CHAT_A_TTS_LANG` 关系、audio-first 语义)+ design「实施转向」与 Open Questions(哨兵休眠、voice-loop 后续)。
- [ ] 4.5(真机,可选)显示中文+合成日语开 `CHAT_A_TTS_DUAL_OUTPUT=on`:看 `[timing]` 首音延迟 + 原生口语自然度 + 翻译覆盖时序。
