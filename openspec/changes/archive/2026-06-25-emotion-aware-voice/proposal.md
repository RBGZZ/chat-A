## Why

小雪是**长期伴侣**(北极星),有自己的情绪内核(§6 PAD)。但目前她"说话的情绪"是**静态**的——`CHAT_A_TTS_INSTRUCTION` 在启动时注入一句固定语气,无论她此刻开心还是低落,复刻音色都用同一种语气朗读。这与"有情绪、会因对话起伏"的伴侣感冲突。

CosyVoice 已被真机证实支持**自然语言 instruction 实时控制情感**(commit f44b5b6 落地静态版),且每次合成是独立 run-task → instruction 可逐句不同。把小雪的 **PAD 实时心情映射成 instruction**,就能让她的专属声音"带着当下的情绪说话"。这是上次"基础情感控制(A,静态)"的深度集成(B)。

## What Changes

- **新增 PAD→语音指令确定性映射**(persona):纯函数 `padToVoiceInstruction(pad, dials?)`——把 pleasure/arousal/dominance 三维映成一句 CosyVoice 风格自然语言情绪指令(≤100 字符,如低 pleasure+低 arousal→"声音低沉,语气有些低落";高 pleasure+高 arousal→"语气轻快上扬,带点雀跃")。可测(golden)。顺带在 `ToneView` 暴露 `voiceInstruction` 字段(与 emotion/toneFragment 同源,纯加法)。
- **TtsOptions 加按调用透传的 `instruction?`**(tts-engine):通用"说话风格/情绪"steer;`CosyVoiceTts.synthesize` 读 `opts.instruction ?? 静态 #instruction` 发 `parameters.instruction`。这是 A(静态)→ 实时 per-call 的桥;不破坏静态用法。
- **desktop 朗读按当前心情注入情绪**(desktop):每条回复合成前读 `handle.persona.tone().pad` → `padToVoiceInstruction` → 作 `opts.instruction` 逐句注入。开关 `CHAT_A_TTS_EMOTION_FROM_MOOD`(默认 **off** → 回落静态 `CHAT_A_TTS_INSTRUCTION`,**零回归**)。
- **语种/语速解耦纪律**:PAD→指令**只表达情绪/语气维度,不含语速**(语速归 `CHAT_A_TTS_RATE`,避免与之打架);超 100 字符截断保护。

## Capabilities

### New Capabilities
- `emotion-aware-voice`: 把 persona PAD 实时心情映射为语音情绪指令并按回合注入 TTS 的端到端能力(开关门控、默认 off、确定性映射)。

### Modified Capabilities
- `persona-emotion`: 新增 PAD→语音指令确定性映射 + `ToneView.voiceInstruction`(纯加法,不改既有 PAD/emotion/tone 行为)。
- `tts-engine`: `TtsOptions` 新增可选 per-call `instruction`;`CosyVoiceTts` 按调用 instruction 优先于静态。
- `desktop-electron-frontend`: 朗读路径按当前心情计算并注入情绪指令(门控、默认 off)。

## Impact

- **改动代码**:`packages/persona/src/`(新 `pad-voice-instruction.ts` 或并入 tone + ToneView 字段)、`packages/providers/src/tts.ts`(TtsOptions.instruction)+ `cosyvoice-tts.ts`(读 opts.instruction)、`packages/desktop/src/main.ts`(makeSynthesize 读 mood→instruction + 开关)。
- **canonical 接缝**:§6.x(PAD 情绪)、§4.1(TTS 音色/情感)、§3.1(确定性内核 golden、行为即配置、优雅降级)。不触 §5 记忆、不改帧管线。
- **延迟预算(§3.2)**:padToVoiceInstruction 是同步纯函数(微秒级),不引入阻塞;instruction 随 run-task 一并发送,无额外往返。
- **依赖**:无新增。persona→providers **不引入反向依赖**(映射是 persona 内纯函数,产出字符串;desktop 编排层把字符串塞进 TtsOptions)。
- **生效前提(重要)**:per-call instruction 只被**消费它的引擎**实际采用——当前即 **CosyVoice**(用户 .env.local 已是 cosyvoice)。desktop 默认 qwen 引擎的 `QwenTtsRealtime` 忽略 opts.instruction(仅用静态复数 instructions)→ qwen 路开开关不生效也不报错。故"随心情说话"实际以 cosyvoice 引擎为前提;qwen instruct per-call 留后续。
- **非目标**:本次只做 **desktop 文字朗读路**;语音模式(voice-loop #speak 逐回合情绪)用同一 TtsOptions.instruction 机制,作为后续扩展点(design 标注);**cli/cli-voice 不在本次**。不给 qwen-tts 接 per-call instruction。不做 SSML 情感、不做 LLM 生成指令(确定性映射优先,§3.1"能用代码算的不交给 LLM")。
