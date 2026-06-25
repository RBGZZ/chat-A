## Context

小雪有 PAD 情绪内核(persona §6):`engine.tone()` 返回 `ToneView{emotion, toneFragment, pad, posture}`,`pad` 是 `{pleasure, arousal, dominance}`。desktop 已用 `toMoodSummary(handle.persona.tone())` 发 mood:change。CosyVoice 合成支持 `parameters.instruction`(自然语言情绪指令,≤100 字符,真机已验生效,commit f44b5b6 静态版),且每次 synthesize 是独立 run-task → 指令可逐句不同。

当前缺口:朗读情绪是**静态**的(`CHAT_A_TTS_INSTRUCTION` 启动注一次)。本变更把 PAD→指令打通,让朗读"带当前心情"。涉及 §6(PAD)、§4.1(TTS 情感)、§3.1(确定性内核/行为即配置/优雅降级)。

## Goals / Non-Goals

**Goals:**
- PAD→语音指令的**确定性纯映射**(golden 可测),不靠 LLM。
- per-call instruction 基础设施(`TtsOptions.instruction`),让运行时逐回合改情绪。
- desktop 文字朗读路按当前心情注入;开关门控、默认 off、零回归。
- persona→providers **不引入反向依赖**(映射纯函数产出字符串,编排层搬运)。

**Non-Goals:**
- 不做语音模式(voice-loop #speak)逐回合情绪——同机制(TtsOptions.instruction)的后续扩展点,本次只埋接缝不接。
- 不用 LLM 生成指令、不做 SSML 情感。
- 不动 PAD 的演化/appraisal 逻辑、不改记忆/帧管线。
- 不把语速塞进指令(语速归 `CHAT_A_TTS_RATE`)。

## Decisions

### D1:PAD→指令是 persona 内确定性纯函数,产出字符串
新增 `padToVoiceInstruction(pad, dials?)`(`packages/persona/src/`,可新文件或并入 tone.ts)。按 PAD 三维分档拼自然语言情绪词(情绪 + 语气维度,**不含语速**),≤100 字符截断。
- **为何在 persona**:PAD 是 persona 的内部表示;映射是"情绪态→表达"的同类逻辑(已有 padToEmotion/renderToneFragment 先例)。产出**纯字符串**,不 import providers → 无反向依赖(镜像 prosodyToPadPull 用结构类型解耦)。
- **为何确定性而非 LLM**:§3.1"能用代码算的不交给 LLM";golden 可测、零延迟、可追溯。
- **备选**:在 providers 侧做映射——否决(providers 不该懂 PAD);LLM 生成指令——否决(不确定、加延迟、难测)。

### D2:`ToneView.voiceInstruction` 纯加法字段
`tone()` 计算 ToneView 时一并算 `voiceInstruction = padToVoiceInstruction(pad, dials)`。
- **为何**:编排层(desktop)已在调 `tone()` 发 mood,直接多取一个字段最省;集中在一处算,避免编排层各自重算/漂移(§3.1 单一权威)。既有字段值不变 → 纯加法、零回归。

### D3:`TtsOptions.instruction` 通用 per-call steer
TtsOptions 加可选 `instruction`;CosyVoiceTts.synthesize 用 `opts.instruction ?? this.#instruction`。
- **为何通用而非 cosyvoice 专有**:这是"本次合成的说话风格"语义,未来 qwen-tts instruct 版也能消费(`session.instructions`)。不支持的 provider 忽略(纯加法)。
- 静态用法(构造期 #instruction)保留不变 → A 不回归。

### D4:desktop 编排按开关注入(接线点是 speakReply,非 makeSynthesize)
🔴 接线落在 `speakReply`(它持有 `handle`),**不是** `makeSynthesize(tts, env)`——后者签名无 handle、拿不到 persona。`speakReply` 在 `CHAT_A_TTS_EMOTION_FROM_MOOD` 启用时读一次 `handle.persona.tone().voiceInstruction`(try/catch 失败回落 undefined,§3.2),传入 `makeSynthesize`(加 `instruction?` 入参),synth 条件展开进 opts。
- **为何每条回复读一次**:朗读是**整段一次合成**(`splitReplySentences` 返回单元素),不在生成器内逐句重读;且朗读发生在回合 reply 产出之后,PAD 已是本回合 advance 后最新 → 朗读即带"刚这轮的情绪"。

### D6:实际生效以"消费 per-call instruction 的引擎"为前提
🔴 desktop **默认引擎是 qwen**(cloneEngine 缺省 'qwen'、ttsKind 默认 'qwen-tts'),而 `QwenTtsRealtime` 只读构造期静态 `#instructions`(复数键)、**忽略 opts.instruction**。故本能力实际改变听感**仅在 cosyvoice 引擎下**(用户当前 .env.local 即 cosyvoice)。qwen 路开开关=opts.instruction 被静默忽略、不报错(纯加法安全),但无情绪变化。
- **本次决定**:不给 qwen-tts 接 per-call instruction(vc 复刻模型未必支持 instruct,需另验)——在 spec/proposal/README 明确 scope,避免"默认路看着没坏但不工作"的误解。qwen instruct 版 per-call = 后续。

### D5:语速解耦
映射输出**剔除语速维度**,语速统一由 `CHAT_A_TTS_RATE`(rate 参数)控制。避免"指令说快 + rate 说慢"互相打架(承用户实测:语速过快致音色漂移,已用 rate=0.8 压住)。

## Risks / Trade-offs

- **映射档位拍脑袋、不够自然** → 映射隔离在纯函数 + golden test,易迭代;先覆盖主要情绪象限(愉悦/低落/平静/紧张),细腻度后续调。
- **PAD 与"听感情绪"不完全对应** → 本次只求"方向对"(开心→上扬、低落→低沉);精调留迭代。
- **每回合心情突变致语气跳变** → 可接受(伴侣情绪本就会变);若需平滑,后续可加滞后,不在本次。
- **instruction 与 rate 维度重叠** → D5 已剔除语速维度规避。
- **voice-loop 语音模式暂不接** → design 明确为后续;TtsOptions.instruction 接缝已就位,届时 #speak 每回合读 tone 即可,爆炸半径小。

## Migration Plan

- 纯增量 + 默认 off:不设 `CHAT_A_TTS_EMOTION_FROM_MOOD` 时,朗读/合成行为逐字不变(静态指令路径)。
- 无 schema/数据迁移。回滚 = 关开关或 revert。

## Open Questions

1. 映射档位与措辞的"听感自然度"——需真机听感迭代(纯函数易调)。
2. 是否给愉悦/低落之外的象限(如高 dominance 的"笃定")也配指令——先做主象限,余下迭代。
3. 语音模式(voice-loop)逐回合情绪何时接——独立后续切片。
