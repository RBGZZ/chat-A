# design — voice-api-calibration(据官方文档校准 TTS/声音复刻)

核实基线:三份阿里云 Model Studio 官方文档——
- *qwen-tts-realtime*(`help.aliyun.com/zh/model-studio/qwen-tts-realtime`)
- *qwen-tts API*(`help.aliyun.com/zh/model-studio/qwen-tts-api`)
- *千问声音复刻 / voice-enrollment*(同 model-studio)

## 1. 🔴 language_type:输出语种真正下发到 qwen-tts-realtime

### 1.1 缺口
`voice-io-decoupling` 已把 `VoiceProfile.outputLang → TtsOptions.language → synthesize(opts.language)` 串通,但 `qwen-tts-realtime.ts` 的 `session.update.session` 只发了 `voice/response_format/sample_rate/mode/instructions`,**漏发 `language_type`** → 服务端永远走默认 `Auto`。语种解耦在 qwen TTS 侧断了一截。

### 1.2 官方契约(核实结论)
- qwen-tts realtime 的 `session` 支持可选 **`language_type`**,合法取值(**首字母大写英文名,不是 `zh`/`en` code**):
  `Auto / Chinese / English / German / Italian / Portuguese / Spanish / Japanese / Korean / French / Russian`。
- `voice` **不自带语种**(同一音色可读多语);`Auto` 由服务端自动判定、处理混读。
- 故:项目内部统一用 ISO 码(`zh/en/...`,与 STT/VoiceProfile 一致),到 qwen 边界**映射**成 Qwen 名。

### 1.3 映射 helper(放 `tts.ts`,providers 内,具名常量无 magic)
```
ISO_TO_QWEN_LANGUAGE = {
  zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean', de: 'German',
  it: 'Italian', pt: 'Portuguese', es: 'Spanish', fr: 'French', ru: 'Russian',
}
toQwenLanguageType(language?):
  - undefined / 空            → undefined  (=不发 language_type = 服务端 Auto = 逐字回归)
  - 命中 ISO 表(大小写不敏感)→ 对应 Qwen 名
  - 已是合法 Qwen 名(大小写不敏感,含 Auto)→ 归一到官方写法原样返回(兼容用户直传)
  - 其它未知                 → undefined  (=不发 = Auto;不抛,优雅)
```

### 1.4 发送逻辑(回归硬线)
`synthesize` 里:
```
const languageType = toQwenLanguageType(opts?.language);
session: {
  voice, response_format, sample_rate, mode,
  ...(instructions !== undefined ? { instructions } : {}),
  ...(languageType !== undefined ? { language_type: languageType } : {}),  // 有值才发
}
```
**无 language → 不含该键 → 与现状逐字一致**(既有「握手次序」测试不动即绿)。

## 2. 🟡 复刻管理加固(qwen-voice-clone.ts)

核实结论:创建链路(端点 `/api/v1/services/audio/tts/customization`、`buildCreateBody`、base64 data URI、同步返回、`output.voice`)**全对,不动**;list/delete 用**裸动词** `list`/`delete` + `voice` 字段**也对**——CosyVoice 才是 `list_voice`/`delete_voice` + `voice_id`,是**另一套契约**。

加固两点(防边角):
- `buildManageBody('list')` 加分页 `page_index:0` + `page_size`(默认常量 100;否则服务端只返第一页,音色多了漏)。query/delete 不带分页。
- `parseVoiceList` 元素 id:`item.voice` 取不到时回退 `item.voice_id`(防元素复用 CosyVoice 风格字段名)。

注释由「按 CosyVoice 同族推断/待校准」→「已据官方核实(2026-06-24)」,并写明 CosyVoice 是另一套契约。

## 3. 🟡 target_model ↔ 合成 model 一致性(纪律)

官方硬约束:复刻时的 `target_model`(如 `qwen3-tts-vc-realtime`,含日期快照时**整串**)必须与后续合成时用的 model **逐字一致**——音色绑单模型,不一致则合成失败。

代码侧**已支持**:`createVoice` 吃 `opts.targetModel`、合成 `synthesize` 吃 `opts.voiceId`;`desktop/src/main.ts` 已据 `CHAT_A_TTS_MODEL`(含 `vc`)推 `targetModel`、复刻后把 voiceId 写回 `.env.local`。本 change **不改协议代码**,只:
- 在 `qwen-voice-clone.ts` / `qwen-tts-realtime.ts` 复刻分支 + `desktop/main.ts` 复刻处加注释钉死这条一致性。
- design / canonical 记一笔。

## 4. CosyVoice 备注(不实现,留给将来 Factory)
CosyVoice 复刻语种机制与 qwen **相反**:
- 注册期(声纹注册)给 `language_hints` 声明音色语种;
- 合成期**无**语种参数;
- 语种**焊死在音色**上。
故 Factory 将来接 CosyVoice 复刻时,**别套用** qwen 的「合成期发 `language_type`」思路——两套契约不可混。已在 `docs/chat-a-canonical-design.md` 记一笔。

## 5. 边界与爆炸半径
只改 `packages/providers/src/{tts.ts, qwen-tts-realtime.ts, qwen-voice-clone.ts}` + desktop/docs 注释。映射表、分页大小全为具名常量;真机若证实某语种名/分页字段不符,改集中一处即可。
