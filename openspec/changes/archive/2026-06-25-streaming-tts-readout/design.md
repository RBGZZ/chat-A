## Context

R7:朗读音频比文字慢几秒——文字逐 token 流式即显;音频在 `convo.send` 返回整段后才 speakReply,且 CosyVoice 整段一次合成(`splitReplySentences` 返回 [整段],main.ts)。整段合成本为防复刻音色逐句漂移([[qwen-tts-clone-model]] §5)。**2026-06-25 真机验证(探活 A 整段/B 同task逐句/C 每句独立task)**:**B 不飘 ≈ A,C 才漂** → 漂移源是"多连接/多 session",**不是逐句本身**;同 task 逐句喂既流式又不漂。承 canonical §3.2 新原则「首句即合成、绝不等整段」。

## Goals / Non-Goals

**Goals:**
- `CosyVoiceTts` 同 session 流式喂文本(真机验证的不漂移流式)。
- desktop 朗读句切 + 同 session 逐句喂 → 首句即出声。
- 门控默认 off、失败降级整段 → 零回归 + 鲁棒。

**Non-Goals:**
- 不做 dual-output / 砍翻译(parked bilingual;本 change 提供其复用的流式 API)。
- VoiceLoop 语音模式同 session 流式 = 后续切片(共用本 API;现 #speak 每句独立 synthesize 同样会漂,留独立件)。
- filler / quick-final / 预热 = canonical §3.2 其它子条款,另立。
- 不改 qwen-tts(本次只 CosyVoice 流式;qwen append 流式后续)。

## Decisions

### D1:CosyVoiceTts 加流式接口,不动一次性路径
新增形如 `synthesizeStream()`:返回 `{ push(text), finish(), [Symbol.asyncIterator]→PcmChunk }`(或 `openStream(): { push, finish, chunks }`)。内部:open 时建一条 WS run-task、等 task-started 后才放行 push;push→continue-task;finish→finish-task;音频帧→PcmChunk 流。复用现有 ByteFrameQueue / s16le 进位 / 注入 wsFactory+taskId。
- **为何独立接口而非改 synthesize**:`synthesize(text)` 是一次性语义(TtsProvider 契约),保持不变(回归);流式是新能力面,新增方法/可选接口 `StreamingTtsProvider`,只有支持的 provider 实现。
- task-started 前 push 的文本**缓冲**,started 后冲刷(避免竞态)。

### D2:desktop 朗读改"边生成边句切边喂"
现 speakReply 在整段 reply 后跑。流式模式下:
- **同语种(无翻译)**:把朗读挂到回合 token 流——onToken 经 SentenceSplitter,出一句喂一句进流式会话。首音 ≈ 首句生成+合成,远早于整段。
- **异语种(needsTranslation)**:翻译仍需整段(translateForSpeech 返回整段)→ 翻译后句切 + 同 session 逐句喂(合成流式,但起步受翻译延迟限——根治走 bilingual)。
- 打断:abort 流式会话(关 WS context)+ ttsAudioStop。
- ⚠️ **接线点真实形状 apply 前先读 main.ts 的 send/onToken/speakReply 核定**(承 emotion-aware-voice 审查教训:勿臆断签名)。

### D3:门控 + 降级
`CHAT_A_TTS_STREAM_READOUT`(默认 off)→ off 沿用整段一次合成(逐字回归)。流式合成抛错 → try/catch 降级整段合成(或跳过该次朗读),不崩。仅 cosyvoice 引擎有流式接口;其它引擎门控开了也回落整段。

## Risks / Trade-offs

- **同 session 多 continue-task 不漂移**:真机已验(B),低风险。
- **分块边界韵律/顿挫**(句间接缝):真机听感微调(句切粒度);CosyVoice 同 task 连续合成接缝平滑度待观察。
- **翻译场景首音改善有限**:本 change 只流式化合成段,翻译延迟仍在;明确根治走 bilingual(parked)。
- **挂 onToken 朗读的复杂度**:同语种流式要把朗读接进 token 流(非整段后),需谨慎核定接线点(D2 注)。可分两步:先把 CosyVoiceTts 流式 API + "整段后句切流式喂"(改善合成段),再做"挂 onToken 边生成边喂"(改善等整段段)。

## Migration Plan

- 纯增量 + 默认 off。无 schema/数据迁移。回滚=关 env / revert。

## Open Questions

1. 同语种"挂 onToken 边生成边喂"一步到位,还是先做"整段后句切流式喂"(合成段流式)再迭代?——倾向分两步,先落 API + 合成段流式(稳),onToken 接入随后。
2. 句切粒度 / 句间接缝平滑度 → 真机听感定。
3. VoiceLoop 同 session 流式何时接(复用本 API)。
