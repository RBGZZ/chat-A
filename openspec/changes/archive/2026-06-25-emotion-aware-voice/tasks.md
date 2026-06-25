## 1. persona:PAD→语音情绪指令(确定性)

- [x] 1.1 新增 `padToVoiceInstruction(pad: Pad, dials?: PersonaDials): string`(`packages/persona/src/pad-voice-instruction.ts` 或并入 tone.ts):按 PAD 三维分档拼情绪/语气词(**不含语速**),≤100 字符(按 JS `.length` 截断;CosyVoice 汉字按 2 计、中文指令实占约 2×,故 100 已足够保守安全)截断;中性/基线→温和或空;纯函数、不 import providers。**dials 入参可选,本次映射只看 PAD、暂不消费 dials**(保证 golden 确定、签名为未来留口);如要用 dials 调强度,在 golden 里钉死。
- [x] 1.2 golden 单测:覆盖愉悦/低落/平静/紧张主象限 + 中性回落 + 长度截断 + 确定性(同输入同输出)。
- [x] 1.3 `ToneView` 加 `voiceInstruction` 字段;`engine.tone()` 计算时一并 `padToVoiceInstruction(pad, dials)`;断言既有 emotion/toneFragment/pad/posture 值不变(回归)。
- [x] 1.4 persona index 导出 `padToVoiceInstruction`。

## 2. providers:TtsOptions 按调用 instruction

- [x] 2.1 `tts.ts`:`TtsOptions` 加可选 `instruction?: string`(通用说话风格/情绪 steer;注释说明 per-call 优先静态、不支持的 provider 忽略)。
- [x] 2.2 `cosyvoice-tts.ts` synthesize:`const instruction = opts?.instruction ?? this.#instruction`,据此发 parameters.instruction(其余路径不变)。
- [x] 2.3 单测:opts.instruction 覆盖静态、未传回落静态、空字符串处理;断言其它 provider(如 fake/qwen)忽略不报错。

## 3. desktop:朗读按当前心情注入(门控)

- [x] 3.1 🔴 接线点是 `speakReply`(它有 `handle`),**不是** `makeSynthesize(tts, env)`(后者无 handle)。在 `speakReply` 里:`CHAT_A_TTS_EMOTION_FROM_MOOD` 启用时 `try { const instr = handle.persona.tone().voiceInstruction } catch {回落 undefined}`,**每条回复读一次**(朗读是整段一次合成,不在生成器内逐句重读);把 instr 传进 `makeSynthesize`(新增 `instruction?: string` 入参),`makeSynthesize` 的 synth 把它**条件展开**进 opts:`...(instruction ? { instruction } : {})`。
- [x] 3.2 开关解析(参照 isSpeakOn 的 env 解析惯例,默认 off);**回归断言**:开关 off 时 `opts` 仍只含 `language`/`voiceId`、**不出现 instruction 键**(exactOptional 条件展开,逐字回归)。
- [x] 3.3 ⚠️ **scope**:本能力实际生效以**支持 per-call instruction 的引擎**为前提(CosyVoice;用户当前 .env.local 即 cosyvoice)。默认 qwen 引擎 `QwenTtsRealtime` 忽略 opts.instruction(用静态复数 instructions)——开开关在 qwen 路**不生效也不报错**;在 README/注释点明"情感随心情仅对 cosyvoice 引擎生效"。
- [x] 3.4 desktop typecheck + bundle 构建通过。

## 4. 收口与校验

- [x] 4.1 全量 `pnpm -r typecheck` + 相关包测试绿(persona/providers/desktop);新增 golden + 回归断言覆盖。
- [x] 4.2 `openspec validate emotion-aware-voice --strict` 通过。
- [x] 4.3 README/记忆补开关说明(`CHAT_A_TTS_EMOTION_FROM_MOOD`)+ design Open Questions(听感迭代、voice-loop 后续)。
- [x] 4.4(真机,可选)`CHAT_A_TTS_EMOTION_FROM_MOOD=on` 重启 app:聊到不同情绪,听复刻音色是否随心情变。
