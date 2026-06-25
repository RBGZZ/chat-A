## 1. 阈值/冷启动进 PersonaConfig

- [x] 1.1 `types.ts` 的 `PersonaConfig` 加情绪阈值字段(pleasure/arousal 阈值;coldStartTurns/reboundFactor 已有);`defaults.ts` 的 `DEFAULT_PERSONA_CONFIG` 填默认(0.35/0.25/5/2,=现值)。
- [x] 1.2 `numeric.ts` `padToEmotion(pad, thresholds?)` 加可选阈值参,缺省回落 0.35/0.25(无参调用行为不变)。

## 2. 透传到**全部 4 个**调用点(单一权威;审查坐实清单)

- [x] 2.1 `engine.ts` `tone()`(实际 `:130` 附近)调 `padToEmotion(pad, config.emotion)`;engine 持有 config。
- [x] 2.2 `padToVoiceInstruction`(pad-voice-instruction.ts)用同阈值(它内部调 padToEmotion)。engine.tone 显式透传 config.emotion。
- [x] 2.3 ⚠️ **`tone.ts:57` `renderToneFragment` 也调 padToEmotion(审查发现的漏点)**——已加 thresholds 形参并由 engine.tone 透传 config.emotion;显示情绪与系统提示情绪文案现用同一阈值,一致(满足 spec Scenario 4)。
- [x] 2.4 grep 全部 `padToEmotion` 调用点复核(4 处:engine.tone / padToVoiceInstruction / renderToneFragment / 其内部),都用配置阈值,无残留硬编码 0.35/0.25(仅 defaults.ts 具名默认常量 + posture 独立 -0.35 注释)。
- [x] 2.5 ⚠️ **`posture.ts:22` `ceilHigh=-0.35` 与 padToEmotion 负阈值耦合**:本 change **取舍 = posture 阈值独立、不随情绪阈值动**(默认),已在 posture.ts:22 注释明确标注 D4 决定。

## 3. config 装配链(审查坐实:比"config-loader 加 env"大)

- [x] 3.1 现状核实:`config-loader.ts` `loadPersonaFromEnv` 只产 seed/dials、不产 PersonaConfig;三个 PersonaEngine 构造点(`app.ts:200`/`app.ts:280` applyPersona 重建/`conversation.ts:298`)都不传 config(回落 DEFAULT)。`stepPad` 已从 config 读 coldStart(未改 stepPad)。
- [x] 3.2 新增 `loadPersonaConfigFromEnv`:解析 `CHAT_A_COLD_START_TURNS`/`CHAT_A_COLD_START_REBOUND`/`CHAT_A_EMOTION_PLEASURE_THRESHOLD`/`CHAT_A_EMOTION_AROUSAL_THRESHOLD`(非法/缺省逐字段回落现值)→ PersonaConfig。
- [x] 3.3 **透传 config 到全部三个 PersonaEngine 构造点**:`app.ts` 显示引擎 + applyPersona 重建直传 `config: personaConfig`;`conversation.ts` 内部引擎经新增 `ConversationDeps.personaConfig` 入参透传,`makeConvo` 在 app.ts 透传 `personaConfig`。(注:`TurnDeps` 未单加裸 config 字段——config 由 `TurnDeps.persona`(PersonaEngine)封装,回合路径不在引擎外读 config,加裸字段为死状态;见交付说明的偏差项。)

## 4. 测试与收口

- [x] 4.1 回归:默认参数下现有 padToEmotion/stepPad/tone golden **逐字通过**(numeric/tone/engine 既有测全绿;新增"无参=默认阈值"对照断言)。
- [x] 4.2 新增:阈值降到 0.25 → 基线 0.34 判 content;coldStartTurns=0 → 首轮不施冷启动压制;阈值透传一致性(engine.tone 的 emotion/toneFragment/voiceInstruction 三处同分类);loadPersonaConfigFromEnv 解析 + 非法回落。
- [x] 4.3 全量 `pnpm -r typecheck` 全绿 + persona/runtime/client 测试绿(全量 vitest 1503 passed);`openspec validate persona-tunable-seams --strict` 通过。
- [x] 4.4 README 补新 env 说明(情绪调优旋钮:冷启动 + 情绪阈值,含 posture 独立取舍注)。
