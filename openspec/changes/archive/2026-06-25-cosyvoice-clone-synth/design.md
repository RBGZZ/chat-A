## Context

现有云音色复刻=qwen `qwen-voice-enrollment` + `qwen3-tts-vc-realtime`(WS,OpenAI-Realtime 风格,JSON base64 音频),已真机打通但**保真度低**("不像")。CosyVoice v3.5-flash 复刻保真更高,但契约与 qwen **完全正交**:

- **复刻创建**:同端点 `/api/v1/services/audio/tts/customization`,但 `model:"voice-enrollment"`、`action:"create_voice"`、音频走**公网/oss:// URL(不收 base64)**、返回 `output.voice_id`、**异步部署需轮询 query_voice**;管理动词 `list_voice`/`delete_voice` + 字段 `voice_id`。
- **合成**:DashScope `run-task`/`continue-task`/`finish-task` WS 协议,端点 `/api-ws/v1/inference`,音频为 **WS 二进制裸帧**(非 JSON base64)。
- **约束**:仅北京地域、无系统音色(必须先复刻)、合成 `model` 须 == 复刻 `target_model`(都是 `cosyvoice-v3.5-flash`,无日期快照)。

完整契约见记忆 `cosyvoice-clone-synth-contract`。涉及 canonical §4.1(音色复刻/可换性)、§4.3(provider Factory)、§3.2(流式延迟)、§3.1(注入式可测/优雅降级)。当前 desktop 已有 qwen 复刻闭环 + "复刻自动持久化合成模型"机制(本会话已做),CosyVoice 复用同套装配思路。

## Goals / Non-Goals

**Goals:**
- 新增可独立工作的 CosyVoice 复刻 + 合成两条链路,作为 qwen 之外的并存选项,缺省零回归。
- 保住 desktop"选本地文件一键复刻"零操作 UX(经 DashScope 临时上传把本地文件转 oss:// URL)。
- 所有文档未定死的契约点隔离在可改纯函数,真机不符改一处(爆炸半径可控)。
- 注入式 fetch/wsFactory,单测全程不触网。

**Non-Goals:**
- 不做声音设计(voice design,`voice_prompt`/`preview_text`)——仅复刻(clone)。
- 不动 §5 记忆 / §6 人格 / 帧管线 / qwen 既有路径行为。
- 不实现自建 OSS 桶 / 生产级文件托管(仅用 DashScope 临时上传或用户自备 URL)。
- 不在本变更内做 CosyVoice 多方言/SSML 高级控制(留待后续,字段预留)。

## Decisions

### D1:CosyVoice 复刻独立模块,不改造 qwen-voice-clone.ts
新建 `packages/providers/src/cosyvoice-voice-clone.ts`,与 `qwen-voice-clone.ts` 并列。两套契约的 build*Body/parse* 纯函数各自独立。
- **为何**:两套契约字段几乎全不同(model/action/audio 载体/响应字段/同步 vs 异步),强行参数化共用会产出大量 if 分叉、违背"单一权威、勿漂移"。独立模块边界清晰、各自契约测试、互不污染。
- **备选**:在 qwen-voice-clone.ts 加 `kind` 分支——否决(把两套正交契约耦进一个文件,改一套易碰坏另一套)。
- 公开 API:`createCosyVoice(audio|url, opts)`(内部含上传+create+轮询)、`listCosyVoices`、`deleteCosyVoice`、`queryCosyVoice`。

### D2:DashScope 临时上传抽成独立模块 `dashscope-upload.ts`
`uploadToDashScopeTemp(bytes, filename, {apiKey, model, fetch?})` → `oss://` URL。
- **为何**:这是可复用的通用机制(未来其它需公网 URL 的 DashScope 接口也能用),且与复刻契约正交。独立后单测可单独覆盖、复刻模块只依赖其返回的 URL。
- getPolicy 的 `model` 参数取值文档未定死(`voice-enrollment` / `cosyvoice-v3.5-flash` / 多模态式)→ 设为**可配参数**,默认值标注"真机校准",注释钉死。
- 上传字段(OSSAccessKeyId/policy/Signature/key/file 等)隔离在 build 函数。

### D3:CosyVoiceTts 新 provider,run-task 协议 + 二进制帧
新建 `packages/providers/src/cosyvoice-tts.ts` implements `TtsProvider`,复用 `qwen-tts-realtime.ts` 的注入式 WS 端口形态(`QwenWsLike` 同构,或抽共享 `WsLike`)与 FrameQueue 异步桥思路,但**协议层全换**:run-task→continue-task→finish-task、`header.event` 分发、二进制帧(`message` 收到 Buffer/ArrayBuffer 即音频,JSON 帧为事件)。
- **为何不复用 QwenTtsRealtime**:协议消息名、音频载体(二进制 vs base64)、事件模型全不同;复用只会层层 if。共享的只是"WS 注入端口 + 事件↔for-await 桥 + s16le 进位",可抽小工具复用。
- `task_id` 用注入式 id 生成器(默认 crypto.randomUUID;测试可注入固定值,保持确定性——遵循"勿用不可重放随机")。
- 二进制帧:`parseEvent` 若 data 为文本 JSON 且含 `header.event` → 事件;若为二进制 → 音频帧入队。

### D4:config 与路由——缺省零变更
- TTS:`CHAT_A_TTS_KIND=cosyvoice` 新档(tts-config 加分支、tts-registry 加 createCosyVoiceTts);字段 model(默认 cosyvoice-v3.5-flash)/voice(=voiceId)/format/sample_rate 走既有 `CHAT_A_TTS_*`。
- 复刻:引擎选择经 `CHAT_A_VOICE_CLONE_KIND=qwen|cosyvoice`(默认 qwen,保持现状);desktop 据此走对应链路。
- **回归硬线**:不设这些键时,qwen/其它 TTS 与复刻路径**逐字不变**;新增分支只在显式选 cosyvoice 时进入。

### D5:契约不确定点统一"隔离 + 真机校准"
getPolicy model 参数、create_voice 是否接受 oss://+解析头、合成期 language_hints、端点二选一、v3.5-flash 推荐采样率、是否引入日期快照——**全部**设为可配置/隔离在可改函数,默认值取文档最可能值并注释"真机校准"。承本项目反复教训(qwen VC 模型名快照、append 字段歧义):契约假设必隔离。

## Risks / Trade-offs

- **getPolicy 的 model 参数未定死** → 设为可配参数 + 默认值注释;真机若 4xx,改一处即可;并支持用户直接传公网 https URL 绕过上传(双通道兜底)。
- **create_voice 可能不接受 oss:// 临时 URL** → 保留"用户自备公网 https URL"通道作为兜底;oss:// 为优选但非唯一路径。
- **异步轮询拉长复刻耗时(可达数分钟)** → 复刻本就是离线一次性操作、不在语音热路径;desktop 报进度状态防误判卡死;轮询带超时上限 + 取消。
- **二进制帧与文本事件在同一 WS 混合** → parseEvent 严格区分(可 JSON 解析且含 header.event=事件,否则=音频),并对 wav/mp3 首帧含文件头的情况在文档/默认用 pcm 规避。
- **北京地域 + 无系统音色限制** → 文档/降级提示明确说明;未复刻前选 cosyvoice 合成应 fail-fast 给清晰提示(无 voiceId 不可合成)。
- **多一套 provider 增加维护面** → 用契约测试 + 与 qwen 路径完全隔离把回归风险关在 cosyvoice 分支内;缺省 off。

## Migration Plan

- 纯增量:新增模块 + config 分支,无 schema 变更、无数据迁移。
- 上线后默认仍走 qwen/现状;用户显式设 `CHAT_A_VOICE_CLONE_KIND=cosyvoice` + `CHAT_A_TTS_KIND=cosyvoice` 才启用。
- 回滚=去掉这两个 env(或代码层 revert 新增文件),qwen 路径不受影响。

## Open Questions（真机校准项,代码留可改接缝,不阻塞落地）

1. getPolicy 的 `model` 参数对声音复刻填什么值?create_voice 是否接受 `oss://` + `X-DashScope-OssResourceResolve: enable`?
2. 合成端点:`dashscope.aliyuncs.com/api-ws/v1/inference` vs `{WorkspaceId}.cn-beijing.maas.aliyuncs.com`——哪个对 v3.5-flash 生效?
3. v3.5-flash 合成的推荐 `format`/`sample_rate`?合成期 `language_hints` 是否生效(还是仅注册期)?
4. v3.5-flash 是否也引入日期快照 model 名(目前文档显示无)?
