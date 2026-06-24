## Why

「语音 I/O 解耦」(voice-io-decoupling)已把**输出语种**经 `VoiceProfile.outputLang → TtsOptions.language` 串到了 TTS 接缝,但落到 **qwen-tts-realtime** 这一侧时漏接了:`session.update.session` 只发了 `voice/response_format/sample_rate/mode/instructions`,**没发 `language_type`**——于是 `opts.language` 拿到也白拿,服务端永远走默认 `Auto`。已合并的语种解耦在 qwen TTS 侧等于断了一截(真缺口,必修)。

同时,据三份 DashScope 官方文档(qwen-tts-realtime / qwen-tts-api / 千问声音复刻)逐条核实,顺手把两处复刻/合成的小隐患加固并把注释从「按 CosyVoice 同族推断/待校准」改成「已据官方核实(2026-06-24)」,避免后人误以为这些还是猜的:

- **复刻列表分页**:`buildManageBody('list')` 不带分页 → 服务端默认只返前一页(漏音色)。
- **list 元素 id 兼容**:`parseVoiceList` 元素只取 `item.voice`,对个别返 `voice_id` 的形态会漏。
- **target_model ↔ 合成 model 一致性**:官方硬约束——复刻时的 `target_model` 必须与合成时的 model **逐字一致**(含日期快照),否则合成失败;音色绑单模型。代码侧已支持覆盖,补注释/文档钉死这条纪律。

## What Changes

- **🔴 必修:qwen-tts-realtime 补发 `language_type`**(`packages/providers/src/qwen-tts-realtime.ts` + `tts.ts`)
  - 在 `tts.ts` 加具名映射 helper `toQwenLanguageType(language?)`:把 ISO 码(`zh/en/ja/ko/de/it/pt/es/fr/ru`)映成 Qwen 语种名(首字母大写英文名 `Chinese/English/Japanese/...`);**未知码 / 未给 → 返回 undefined**(=不发该字段=服务端 `Auto`);**已是合法 Qwen 名则原样**(兼容用户直传)。
  - `synthesize` 把 `opts?.language` 经 `toQwenLanguageType` 映射,**有值才**写进 `session.update.session.language_type`;**无值 → 不发(逐字回归)**。
- **🟡 复刻管理加固**(`packages/providers/src/qwen-voice-clone.ts`)
  - `buildManageBody('list')` 加分页字段 `page_index:0` + `page_size`(可配,默认常量 100)。
  - `parseVoiceList` 元素 id 取 `item.voice` 失败时**回退 `item.voice_id`**。
  - 注释从「按 CosyVoice 同族推断/待校准」改为「已据官方核实(2026-06-24)」,并注明 **CosyVoice 是另一套契约**(`list_voice`/`delete_voice` + `voice_id`,语种走注册期 `language_hints`)。
- **🟡 target_model 一致性纪律**(注释/文档)
  - `qwen-voice-clone.ts` / `qwen-tts-realtime.ts` 复刻分支加注释强调:复刻 `target_model` 必须与合成 model 逐字同串。
  - `packages/desktop/src/main.ts`(已实现该一致性逻辑)补一行强调注释,无功能改动。
  - `docs/chat-a-canonical-design.md` 记一笔 vc 路径一致性 + **CosyVoice 复刻语种机制相反**(注册期 `language_hints`、合成期无语种参数、语种焊音色),Factory 将来接 CosyVoice **别套用** qwen 的 `language_type` 思路。

## 范围与 Non-goals

- **硬约束(回归硬线)**:**不配置语种 / 不复刻时,行为逐字不变**——既有测试全绿。`language_type` 只在 `opts.language` 映得出值时才发。
- **只改 providers 主战场** + desktop/docs 的最小注释。不重写无关模块,不碰 STT/LLM/runtime。
- **不实现 CosyVoice 复刻**:仅在 design.md 留备注,提醒其语种契约与 qwen 相反。
- **不发真网络请求**:单测全用既有 mock WS / mock fetch 注入。真机验证(真发 language_type、真分页列表)留主控。

## Capabilities

### Modified Capabilities
- `provider-tooling`: 在既有 TTS Provider / 声音复刻能力上,补/校准三条要求——(1) qwen-tts-realtime MUST 把请求输出语种映成 Qwen `language_type` 下发(未给/未知 → 不发 = Auto,逐字回归);(2) 复刻列表 MUST 带分页且解析 MUST 兼容 `voice`/`voice_id` 元素;(3) 复刻 `target_model` MUST 与合成 model 逐字一致(纪律要求)。

## Impact

- **影响 canonical 章节**:§4.1(语音 I/O 语种解绑 + 音色复刻)、§4.3(可换性/能力门)、§3.2(行为即配置)、§8.1(id 仅供 trace)。与权威设计一致。
- **代码**:`packages/providers/src/{tts.ts, qwen-tts-realtime.ts, qwen-voice-clone.ts}`;`packages/desktop/src/main.ts`(注释);`docs/chat-a-canonical-design.md`(备注)。
- **测试**:`qwen-tts-realtime.test.ts`(language_type 映射 + 未给/未知不发,回归)、`qwen-voice-clone.test.ts`(list 分页 + voice/voice_id 兼容)、`tts.test.ts`(helper 单测)。全程不触网。
- **延迟预算**:无新增延迟(只多一个会被忽略或写入的 session 字段)。
- **不涉及**:STT/LLM/omni、runtime/client/memory/persona 链路行为不变;现有 fake/openai-compat/kokoro/gpt-sovits 路径逐字不变。
