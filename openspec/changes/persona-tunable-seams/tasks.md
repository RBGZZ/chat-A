## 1. 阈值/冷启动进 PersonaConfig

- [ ] 1.1 `types.ts` 的 `PersonaConfig` 加情绪阈值字段(pleasure/arousal 阈值;coldStartTurns/reboundFactor 已有);`defaults.ts` 的 `DEFAULT_PERSONA_CONFIG` 填默认(0.35/0.25/5/2,=现值)。
- [ ] 1.2 `numeric.ts` `padToEmotion(pad, thresholds?)` 加可选阈值参,缺省回落 0.35/0.25(无参调用行为不变)。

## 2. 透传到**全部 4 个**调用点(单一权威;审查坐实清单)

- [ ] 2.1 `engine.ts` `tone()`(实际 `:130` 附近)调 `padToEmotion(pad, config.emotion)`;engine 持有 config。
- [ ] 2.2 `padToVoiceInstruction`(pad-voice-instruction.ts)用同阈值(它内部调 padToEmotion)。
- [ ] 2.3 ⚠️ **`tone.ts:57` `renderToneFragment` 也调 padToEmotion(审查发现的漏点)**——它产"【当前情绪】"系统提示文案,经 engine.tone 调用;**必须也接阈值透传**,否则显示 emotion 用新阈值、喂 LLM 的情绪文案仍用旧 0.35,不一致(违反 spec Scenario 4)。
- [ ] 2.4 grep 全部 `padToEmotion` 调用点复核(上述 4 处:engine.tone / padToVoiceInstruction / renderToneFragment / 其内部),都用配置阈值,无残留硬编码。
- [ ] 2.5 ⚠️ **`posture.ts:22` `ceilHigh=-0.35` 与 padToEmotion 负阈值耦合**(注释自承"一致"):本 change **明确取舍**——要么文档标注"posture 阈值独立、不随情绪阈值动"(默认),要么一并参数化。design 须记此决定。

## 3. config 装配链(审查坐实:比"config-loader 加 env"大)

- [ ] 3.1 现状核实:`config-loader.ts` `loadPersonaFromEnv` **只产 seed/dials、不产 PersonaConfig**;`PersonaEngine` 三个构造点(`app.ts:200`、`app.ts:280` applyPersona 重建、`conversation.ts:298`)**都不传 config**(回落 DEFAULT)。`stepPad` 已从 config 读 coldStart(无需改 stepPad)。
- [ ] 3.2 新增 `loadPersonaConfigFromEnv`(或扩 loadPersonaFromEnv 返回 config):解析 `CHAT_A_COLD_START_TURNS`/`CHAT_A_COLD_START_REBOUND`/`CHAT_A_EMOTION_PLEASURE_THRESHOLD`/`CHAT_A_EMOTION_AROUSAL_THRESHOLD`(非法/缺省回落现值)→ PersonaConfig。
- [ ] 3.3 **透传 config 到全部三个 PersonaEngine 构造点**:`app.ts:200`(显示引擎)、`app.ts:280`(applyPersona 重建)、`conversation.ts:298`(内部引擎)——**`Conversation` 构造需新增 config 入参**(TurnDeps 加 personaConfig),makeConvo 透传。否则 env 解析了但引擎仍用默认值=形同虚设。

## 4. 测试与收口

- [ ] 4.1 回归:默认参数下现有 padToEmotion/stepPad/tone golden **逐字通过**。
- [ ] 4.2 新增:阈值降到 0.25 → 基线 0.34 判 content;coldStartTurns=0 → 首轮不施冷启动压制;阈值透传一致性(tone 与 padToVoiceInstruction 同分类)。
- [ ] 4.3 全量 `pnpm -r typecheck` + persona 测试绿;`openspec validate persona-tunable-seams --strict`。
- [ ] 4.4 README/记忆补新 env 说明(情绪调优旋钮)。
