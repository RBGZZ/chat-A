# chat-A 语音模块踩坑与教训总结(截至 2026-06-25)

> 范围:STT / TTS / 声音复刻 / VoiceLoop / 语音管线 / Electron 桌面 app 语音相关部分 / DashScope(qwen-tts、qwen-omni、qwen-asr、CosyVoice)/ GPT-SoVITS。
> 体例:每条按 **现象 → 根因 → 解决/现状(含 commit 或 文件:行 佐证)→ 教训**。
> 来源:项目 auto-memory(qwen-tts-clone-model / cosyvoice-clone-synth-contract / voice-pipeline-state / electron-desktop-launch / canonical-gap-fill-batch / qwen-dashscope-api-params)、`git log`、源码注释、openspec archive。
> 标注约定:无把握是否真实发生者标「待确认」;能给出 commit hash 或 文件:行 处尽量给。

---

## A. DashScope qwen-tts / 声音复刻

### A1. VC 实时复刻模型名必须带日期快照,否则 close 1007 "Model not found"
- **现象**:desktop 朗读「复刻音色没声音」;WS 合成被服务端关闭,close code 1007,reason=`Model not found (qwen3-tts-vc-realtime)!`。
- **根因**:`QWEN_VOICE_CLONE_DEFAULT_TARGET_MODEL` 原配无日期别名 `qwen3-tts-vc-realtime`——**服务端不存在该别名**;VC 实时复刻模型必须带日期快照。
- **解决/现状**:改默认为带快照的 `qwen3-tts-vc-realtime-2025-11-27`(实测复刻+合成端到端通,8~11 块 PCM)。佐证:`packages/providers/src/qwen-voice-clone.ts:36-42`(`QWEN_VOICE_CLONE_DEFAULT_TARGET_MODEL = 'qwen3-tts-vc-realtime-2025-11-27'`);commit `7919827`。另:`qwen3-tts-vc-realtime-2026-01-15` 也存在(返回 "TTS speak request failed" 而非 "Model not found");无日期别名 / `cosyvoice-v1|v2` / `qwen-tts-vc` 均 "Model not found"。
- **教训**:DashScope 复刻类模型名以**带日期快照**为准;文档别名可能服务端不存在。**以真机为准**。

### A2. 复刻 target_model 必须与合成 model 逐字一致(音色绑单模型快照)
- **现象**:复刻成功但换合成模型后合成失败 / 音色对不上。
- **根因**:音色绑定到创建时的单一模型快照;合成时 model 与复刻 target_model 不同串即失败。
- **解决/现状**:`resolveCloneTargetModel` 抽成单一真相源,复刻创建与持久化 `CHAT_A_TTS_MODEL` 共用同一算法以保逐字一致;可用 query API(`buildManageBody('query',voiceId)`)查音色实际绑的 target_model。佐证:`packages/desktop/src/main.ts:116-131,148,191-195`;commit `497afdb`(voice-api-calibration 钉纪律)、`f8ef918`(复刻成功自动持久化 target_model)。
- **教训**:复刻与合成是**强耦合的一对**,模型串(含快照)必须逐字相同;最好在复刻成功时一并持久化合成模型,避免人工手配出错。

### A3. 复刻后 desktop 未自动切合成模型(已修)
- **现象**:复刻成功写了 `CHAT_A_VOICE_ID`,但合成仍用旧模型 → 用户得手动配 `CHAT_A_TTS_MODEL=对应快照`,极易出错。
- **根因**:`persistVoiceId` 早期只写 voiceId,未联动写 target_model / voiceCloning / TTS_KIND。
- **解决/现状**:复刻成功 `persistVoiceId` 现自动写 `CHAT_A_TTS_MODEL=target_model + CHAT_A_TTS_VOICE_CLONING=1 + CHAT_A_TTS_KIND=qwen-tts`。佐证:`packages/desktop/src/main.ts:189-195`;commit `f8ef918`;memory `qwen-tts-clone-model` §8。
- **教训**:复刻这种"一次性配置"操作要**一把写齐所有联动配置**,别留人工补配步骤。

### A4. TTS 从未发 language_type → 输出语种永远 Auto(真缺口已修)
- **现象**:配了输出语种却不生效,合成语种始终是服务端 Auto。
- **根因**:qwen-tts-realtime 早期 `session.update` 根本没发 `language_type` 字段。
- **解决/现状**:补 `tts.ts` 的 `ISO_TO_QWEN_LANGUAGE` + `toQwenLanguageType()`,有 language 才发 `session.language_type`(无值省略=Auto=逐字回归)。佐证:`packages/providers/test/tts.test.ts:91`、`packages/providers/test/qwen-tts-realtime.test.ts:138-183`;commit `497afdb`。
- **教训**:**Qwen 用首字母大写英文语种名**(Chinese/English/Japanese…),不是 `zh`/`en` ISO code;合法值:Chinese/English/German/Italian/Portuguese/Spanish/Japanese/Korean/French/Russian/Auto。

### A5. TTS response_format 用了 Java SDK 枚举名(协议非法值,已修)
- **现象**:早稿 `response_format=PCM_24000HZ_MONO_16BIT`,真机会回 invalid_value。
- **根因**:`PCM_24000HZ_MONO_16BIT` 是 Java SDK 的枚举名,不是 WS 协议值。
- **解决/现状**:改为小写 `pcm`(合法:`pcm`/`wav`/`mp3`/`opus`)+ 独立字段 `sample_rate:24000`。佐证:commit `0b04bfd`;memory `canonical-gap-fill-batch`(omni/tts 文档核实段)。
- **教训**:WS 协议字段值与官方 SDK 枚举名常**不是一回事**,别照搬 SDK 常量。

### A6. close reason 曾被吞 → 看不到真因(已修)
- **现象**:WS 合成失败只报「code 1007」,真因 "Model not found" 看不到,白调半天。
- **根因**:`ws.on('close', code => ...)` 只取 code,丢掉 reason。
- **解决/现状**:reason 并入错误信息(`closeWith(code, reason)`),错误文案带上服务端 reason。佐证:`packages/providers/src/qwen-tts-realtime.ts:230-234,395-412`(注释「服务端常在此说明真因,如 Model not found」);commit `7919827`。
- **教训**:**排查 WS 失败先看 close reason**;封装 WS 时务必把 reason 透出,别只留 code。

### A7. omni realtime 文本面协议上不成立(已移除)
- **现象**:早稿把 omni 当普通文本 LLM 装进 registry(`conversation.item.create`+`input_text`),想让纯文本路径零改复用 omni。
- **根因**:官方明确 realtime 的 `conversation.item.create` **仅接受 `function_call_output`**,且音频输入必需。
- **解决/现状**:删 stream/complete、不再 implements LlmProvider、从 registerLlm 注销 `qwen-omni`;纯文本一律走已实测通的 OpenAI 兼容 `qwen` provider。佐证:commit `b15b4af`;memory `voice-pipeline-state`(文档核实段)。
- **教训**:realtime 多模态接口≠通用文本 LLM 接口;接入前逐条核官方 client-events 文档。

### A8. instruct 版与复刻互斥(认知澄清,非 bug)
- **现象**:期望「复刻音色 + instruct 情绪控制」一把用上。
- **根因**:DashScope **无 instruct+复刻合并模型**——instruct 版(`qwen3-tts-instruct-flash-realtime`)是内置音色+自然语言控情绪/风格;复刻是另一套 `qwen3-tts-vc-realtime-*`,两者互斥。
- **解决/现状**:代码已支持 instruct(`CHAT_A_TTS_MODEL=instruct模型 + CHAT_A_TTS_INSTRUCTIONS`),无需改代码;但它帮不上"复刻要像"。佐证:memory `qwen-tts-clone-model` §7;`packages/providers/test/qwen-tts-realtime.test.ts:346`。`instructions` 官方限制仅中英文、≤1600 token。`qwen3-tts-instruct-flash-realtime-2026-01-22` 文档未列但真机探活通过(**以真机为准**)。
- **教训**:复刻保真与情绪表现力是**两套互斥能力**,别指望一个模型全包。

### A9. append 文本字段官方文档自相矛盾(已定案)
- **现象**:`input_text_buffer.append` 文本字段官方两处不一致(`{text}` vs `{arguments:{text}}`)。
- **根因**:文档自身矛盾。
- **解决/现状**:实现采根对象 `{type,text}` 并抽 `buildAppend` 隔离,真机核实此为对。佐证:commit `0e52070`(初版)、文档核实段确认;memory `voice-pipeline-state`。
- **教训**:文档歧义点**抽成单一隔离函数**,真机不对只改一处。

---

## B. CosyVoice(与 qwen 完全不同的另一套契约)

> 核心教训:**CosyVoice 与 qwen 复刻是两条管线,契约处处相反,严禁互相套用。** 源码已在注释钉死(`cosyvoice-tts.ts:12`「与 qwen-tts-realtime 协议完全不同(别套用)」)。

### B1. 复刻只收公网/oss:// URL,不收 base64(零操作 UX 被打破)
- **现象**:desktop "选本地文件一键复刻" 在 CosyVoice 上不成立。
- **根因**:CosyVoice `create_voice` 的 `input.url` **只收公网 URL**(qwen 是 `audio.data` base64 内联)。
- **解决/现状**:新增 `packages/providers/src/dashscope-upload.ts`——本地字节走 DashScope 官方临时上传(getPolicy→OSS multipart→`oss://` URL,48h),再 `create_voice`。佐证:`packages/providers/test/dashscope-upload.test.ts:77-108`;commit `bc45881`。
- **教训**:复刻入口的 UX(本地文件 vs URL)由 provider 契约决定;靠临时上传桥接,才能在两套契约下都保住"选本地文件"。

### B2. oss:// URL 必须加专用解析头,否则请求失败
- **现象**:传 `oss://` URL 给 create_voice 失败。
- **根因**:`oss://` 须配合请求头 `X-DashScope-OssResourceResolve: enable` 才能被解析。
- **解决/现状**:`ossResolveHeaders('oss://k')` 自动加该头,`https://` 不加。佐证:`packages/providers/test/dashscope-upload.test.ts:90-91`;真机端到端验证通过(memory `cosyvoice-clone-synth-contract` 末"真机端到端验证通过")。
- **教训**:OSS 临时 URL 有专属解析头,缺了静默失败。

### B3. 复刻异步部署,须轮询 query_voice
- **现象**:create 直返 voice_id 但音色不可立即合成。
- **根因**:create 同步返回 id,但音色**异步部署**;status∈{DEPLOYING, OK, UNDEPLOYED}。
- **解决/现状**:`createCosyVoice` 异步轮询 query_voice(pollIntervalMs 可配,测试设 0);真机实测**第 2 次轮询(~16s)即 status=OK**。佐证:`packages/providers/src/cosyvoice-voice-clone.ts`;commit `bc45881`;memory 实测段。建议 10s 间隔、最多 ~30 次(~5 分钟)。
- **教训**:CosyVoice 复刻是异步流程,要轮询;qwen 是同步直返,**别假设两者一致**。

### B4. 合成是 DashScope run-task 协议,音频为二进制裸帧(非 OpenAI-Realtime)
- **现象**:照 qwen-tts 的 OpenAI-Realtime 风格收 base64 音频,收不到。
- **根因**:CosyVoice 合成端点 `wss://.../api-ws/v1/inference`(非 qwen 的 `/api-ws/v1/realtime`);协议是 run-task / continue-task / finish-task,全程同一 task_id;**音频是独立 WS 二进制裸帧**(非 JSON base64),紧跟 sentence-synthesis 之后。
- **解决/现状**:新 `cosyvoice-tts.ts`(`ByteFrameQueue` 拼接二进制帧),`input` 必填且必须为空 `{}`,等 `task-started` 后才能发 continue-task;`task-failed` 透出。佐证:`packages/providers/src/cosyvoice-tts.ts:8-21,33-38`;`packages/providers/test/cosyvoice-tts.test.ts`;commit `bc45881`;真机 63 块/229680 样本通过。
- **教训**:同一家(DashScope)不同产品线协议族不同(run-task vs OpenAI-Realtime),逐产品核协议。

### B5. CosyVoice v3.5-flash 无系统音色、仅北京地域
- **现象**:不复刻就没法合成;选错地域端点连不上。
- **根因**:v3.5-flash/plus **无系统音色**(必须先复刻/设计才能合成)、**仅北京地域**;另有 `wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/...` 新式端点(待确认:二选一需真机校准,memory 标记)。
- **解决/现状**:`CosyVoiceTts` 设 `voiceCloning=true`、voiceId 能力列表留空、缺 voiceId fail-fast。佐证:`packages/providers/src/cosyvoice-tts.ts:20-21`。真机验证用 `wss://dashscope.aliyuncs.com/api-ws/v1/inference` 通过。
- **教训**:无内置音色的引擎,复刻是**前置必需**而非可选增强;地域限制要提前确认。

### B6. instruction 是单数键、≤100 字符、放 parameters 下
- **现象**:照 qwen 的 `instructions`(复数)发情绪指令不生效。
- **根因**:CosyVoice 情感控制字段是 `payload.parameters.instruction`(**单数**,非 qwen 的 `instructions`),≤100 字符(汉字按 2、其它按 1);SSML 是 `parameters.enable_ssml=true`。
- **解决/现状**:`buildRunTask` 发 `parameters.instruction`(单数)/`parameters.enable_ssml`;config `CHAT_A_TTS_INSTRUCTION`/`CHAT_A_TTS_ENABLE_SSML`。真机验证生效(同句三情绪时长随指令变:happy 4.4s / plain 4.8s / sad 7.2s)。佐证:`packages/providers/test/cosyvoice-tts.test.ts:177-200`;commit `f44b5b6`;memory `cosyvoice-clone-synth-contract` 情感控制段。
- **教训**:跨 provider 的"同义"字段名极易混(单复数、嵌套层级),逐字核;无预置情感枚举,纯自由文本指令,"实时"逐句改情感天然成立(每次 synthesize=独立 run-task)。

### B7. 语速过快致复刻音色漂移
- **现象**:复刻音色在快语速下"漂移"、不稳。
- **根因**:rate 与 instruction 独立;语速过快让复刻音色失真(用户实测)。
- **解决/现状**:配 `CHAT_A_TTS_RATE=0.8` 压住;并提醒情感强度别与 rate 冲突(如"语速极快"指令 + rate 0.8 会打架)。佐证:memory `cosyvoice-clone-synth-contract` 情感深调研段(`⚠️ rate/instruction 独立`)。
- **教训**:复刻音色对语速敏感,调参时 rate 与情绪指令要协调,别相互拉扯。

---

## C. Electron 桌面 app(语音相关)

### C1. node:sqlite 不存在于 Electron(已修)
- **现象**:Electron 启动即 `ERR_UNKNOWN_BUILTIN_MODULE`;连选 `MEMORY_BACKEND=memory` 也救不了。
- **根因**:`node:sqlite` 是 Node≥24 内建,Electron 31 内嵌 Node 20 无此模块;`export *` 把它拉进静态 ESM 图,链接期就炸。
- **解决/现状**:memory `sqlite-store.ts` + observability 4 文件统一改 `import type` + `createRequire(import.meta.url)` **惰性加载**(共享 `observability/src/sqlite-loader.ts`);`SqliteUnavailableError` 由 config-loader 捕获→降级 InMemoryMemoryStore。佐证:commit `1d723b9`;memory `electron-desktop-launch`。
- **教训**:Electron 内嵌 Node 版本低于开发机,**新版内建模块必须惰性加载**,别让它进静态依赖图。

### C2. esbuild ESM 产物的动态 require 报错(已修)
- **现象**:bundled CJS 依赖(yaml,persona 读人格卡用)内部 `require('process')` 在 ESM 产物抛「Dynamic require of X is not supported」。
- **根因**:esbuild 打成 ESM 后,CJS 依赖的运行时 require 没有垫片。
- **解决/现状**:`desktop/scripts/build.mjs` main bundle banner 注入 `import { createRequire as __cr } ...; const require = __cr(import.meta.url);`,让 esbuild 的 `__require` 垫片回落真 require。佐证:commit `1d723b9`;memory `electron-desktop-launch` bug#2。
- **教训**:ESM 产物里混 CJS 依赖要在 bundle banner 注 `createRequire` 垫片。

### C3. desktop 缺 ws 依赖 → TTS 挂(文字路不受影响)
- **现象**:文字回复正常但 TTS 一播放就 `Cannot find module 'ws'`。
- **根因**:qwen-tts/CosyVoice 是 WS provider,经 `createRequire('ws')` 运行时加载;`packages/desktop` 没列 `ws` 依赖,pnpm 严格 node_modules 不会自动可达。文字路是 HTTP fetch 故不受影响。
- **解决/现状**:加 `ws:^8.21.0` 到 desktop deps。佐证:commit `7919827`;memory `qwen-tts-clone-model` §2。
- **教训**:**凡 in-process 复用 providers 的 WS 能力的包,都要直接显式依赖 ws**;惰性 require 的依赖不会被打包工具自动拉进。

### C4. naudiodon 须按 Electron ABI 重编
- **现象**:点语音功能不可用 / 原生模块加载失败。
- **根因**:naudiodon 按 Node24 ABI 编译,Electron ABI 不同。
- **解决/现状**:须 `pnpm desktop:rebuild`(electron-rebuild naudiodon 按 Electron ABI);不可用时 `probeVoice` 探测→禁语音钮+提示,文字不受影响(优雅降级)。佐证:`packages/desktop/test/ipc-contract.test.ts:185-194`;memory `electron-desktop-launch`。
- **教训**:原生 addon 跨运行时(Node vs Electron)ABI 不同,**必须 electron-rebuild**;同时要有探测+优雅禁用兜底。

### C5. 必须从仓库根启动才读到 .env.local
- **现象**:从 `pnpm desktop:dev` 启动读不到 qwen key。
- **根因**:`loadEnvLocal` 读 `cwd/.env.local`;`pnpm desktop:dev` 的 cwd=packages/desktop,不是根。
- **解决/现状**:从仓库根启动 `<electron.exe> packages/desktop`(electron cwd=根=读根 .env.local,app 仍加载 packages/desktop)。佐证:memory `electron-desktop-launch` 启动段。
- **教训**:env 加载基于 cwd 时,启动目录要钉死;monorepo 里尤其要注意。

### C6. Electron 下记忆降级内存(非持久化)
- **现象**:Electron app 重启记忆不在。
- **根因**:因 C1 SqliteUnavailableError 降级 InMemoryMemoryStore;顶栏「记忆后端」显示 memory。
- **解决/现状**:暂为内存后端;要持久化需接 electron-rebuild 版 better-sqlite3(`external` 已列),独立一件。佐证:memory `electron-desktop-launch` 限制段。
- **教训**:降级是为先跑通,但要明确标记后续补持久化的独立任务。

### C7. (语音质量相关)desktop 朗读逐句合成致多音色混杂(已修)
- 见 §E2(归到保真度类)。

---

## D. 语音管线 / VoiceLoop

### D1. omni 模式小雪人设失格(真 bug,已修)
- **现象**:omni path-B 真音频验证时,小雪回成通用"AI 助手"腔,失格。
- **根因**:VoiceLoop omni 分支调 `respondToAudio(buf, {}, signal)`,`{}` 未传 persona instructions。
- **解决/现状**:omni path-B 前 `Conversation.composeOmniInstructions()`(复用同源 composeSystem:persona/记忆/tone/立场/风格)作 instructions 传入;降级安全、STT 路逐字不变。佐证:`packages/runtime/test/voice-loop-omni.test.ts:289-311`;commit `621cea5`(omni-persona-context);memory `canonical-gap-fill-batch`。
- **教训**:多条生成路径(文本/STT/omni)要**统一注入人设上下文**,新路径极易漏接系统提示。

### D2. prosody→PAD "最后一公里"丢 emotion(真 bug,已修)
- **现象**:STT 读到的情绪没影响心情。
- **根因**:cli-voice/cli/cli-brain/desktop main 的 send 闭包丢了 emotion 第 4 参,情绪没透传到 `persona.advance`。
- **解决/现状**:补齐 emotion 透传(send→TurnContext→strategy→finalizeTurn→persona.advance);与文本 appraiser 拉力按 `PROSODY_PULL_WEIGHT=0.5` 合并、单次 stepPad。佐证:commit `8e178b0`(代理A);memory `canonical-gap-fill-batch` 会话末状态二。
- **教训**:多层透传的可选参数,任一闭包漏传就静默丢失;端到端验证要覆盖"参数真到终点"。

### D3. 音色复刻闭环断在 desktop voiceStart(真 bug,已修)
- **现象**:复刻的 `CHAT_A_VOICE_ID` 从未进 TTS,语音模式听不到复刻音色。
- **根因**:desktop voiceStart 没传 ttsOptions。
- **解决/现状**:新增 `buildVoiceTtsOptions` 注入(完整保留 outputLang→ttsOptions.language,不只塞 voiceId,保语种解耦)。佐证:commit `8e178b0`;memory `canonical-gap-fill-batch`。
- **教训**:复刻配置要贯穿到**每一条合成入口**(朗读路 / 语音模式路),漏一条就半残。

### D4. EchoGuard(自听回声防误打断)
- **现象**:扬声器播放被麦克风拾回,可能误触发打断。
- **根因**:无 AEC 时自播音频会被 VAD 当成用户说话。
- **解决/现状**:`EchoGuardGate` 纯函数 N 帧去抖,**仅 speaking 期生效**;真人连续帧仍能打断、危机/硬打断豁免、异常兜底放行;语音模式默认开(`CHAT_A_ECHO_GUARD=off` 关)。**完整 AEC 需原生、不在范围**。佐证:`packages/voice-detect/test/echo-guard.test.ts:46,231`;commit `3f41d5c`、`8e178b0`(默认开)。
- **教训**:无硬件 AEC 时用软去抖兜底是务实折中,但要保留真人打断与危机豁免,别"防过头"。

### D5. 打断 / AbortSignal 真取消
- **现象**:barge-in 早期只作废 generation,LLM 仍在后台跑。
- **根因**:取消未透传到 provider 层。
- **解决/现状**:`Conversation.send(text,onToken,signal?)` 经 TurnContext.signal 透传到 llm.stream/completeWithTools;barge-in/stop 时 abort()→真停 LLM;TTS 也透传 AbortSignal(qwen-tts 无 cancel 事件,靠 `input_text_buffer.clear`+丢弃播放队列)。佐证:merge `2083229`(turn-cancellation);memory `voice-pipeline-state`;`qwen-dashscope-api-params`(无 cancel 事件)。
- **教训**:取消要一路透传到最底层 provider;不同 TTS 协议的中断机制不同(有的无 cancel 事件,靠 clear+本地静音)。

### D6. sherpa-onnx / naudiodon 原生依赖与 API 形状未定
- **现象**:真 VAD/EOU/音频 I/O 需原生依赖,headless 跑不了;`sherpa-onnx-node` 真 API 形状未固定。
- **根因**:`sherpa-onnx-node` 很可能是流式 buffer API(`Vad`/`CircularBuffer`+`acceptWaveform`/`isSpeechDetected`),**非**「一窗一概率」纯函数;推理端口设计为同步以"零改 VoiceLoop"。
- **解决/现状**:工厂用鸭子类型挑「吃 Float32Array→返回 number」的面,挑不到抛明确中文错误指明在 `sherpa-vad-session.ts` 补适配(不静默错配);真路径加载失败打印中文提示并回落桩,绝不崩;sherpa-onnx 未写进任何 package.json(仅动态 import,`CHAT_A_SHERPA_MODULE` 可覆盖)。佐证:merge `7bda0d3`(voice-mode-wiring);memory `voice-pipeline-state`(⚠️ 未决假设段)。**待确认**:真 API 形状需真机手测核对。
- **教训**:对未固定的第三方原生 API,用鸭子类型适配 + fail-fast 明确错误 + 回落桩,别静默错配。

---

## E. 保真度 / 音质

### E1. qwen 云复刻"不像"→ 转 CosyVoice / GPT-SoVITS
- **现象**:同一段参考音频(用户在别的服务复刻像过),qwen `qwen-voice-enrollment`+vc-realtime 复刻出来"连贯但不像"(stereo→mono 转换也不像,排除格式问题)。
- **根因**:**qwen 云复刻保真度就是低,无质量参数可调,改不动**。
- **解决/现状**:① 短期接 CosyVoice v3.5-flash(保真公认更高,见 §B,commit `bc45881`,真机已端到端通,**人耳保真度对比待确认**);② 项目自带 `GptSoVitsTts`(本地零样本克隆,127.0.0.1:9880)是高保真正路,待用户起本地服务;③ 候选:qwen 非实时 VC 模型 `qwen3-tts-vc-2026-01-22`(走 HTTP 非 WS,需新接,改善不确定,**待确认**)。佐证:memory `qwen-tts-clone-model` §6;`packages/providers/src/gpt-sovits-tts.ts`;commit `68aac20`(GPT-SoVITS)。
- **教训**:云复刻保真度有天花板且不可调;要"像"须上高保真技术(本地零样本克隆 / 更高端复刻模型),技术选型要给保真度留后路(Factory 接缝 day1 埋)。

### E2. desktop 朗读逐句合成致复刻音色逐句漂移(已修)
- **现象**:desktop 朗读复刻音色听感"多个音色混杂"。
- **根因**:朗读原**逐句**分多次 WS 合成(`splitReplySentences` 用 SentenceSplitter),复刻音色每句独立合成→**逐句音色漂移**;隔离单句合成则干净。
- **解决/现状**:改为**整段一次合成**(`splitReplySentences` 直接返回 `[text]`;qwen-tts-realtime 本就流式,整段也边合边出音),音色一致无漂移/重叠;回复短,首音延迟可接受。佐证:`packages/desktop/src/main.ts:414-415`(注释钉死);commit `4897b23`;memory `qwen-tts-clone-model` §5。
- **教训**:复刻音色对"每次合成会话"敏感,多次独立合成会漂移;流式引擎下整段一次合成兼顾一致性与延迟。

### E3. GPT-SoVITS 采样率 / media_type 待校准
- **现象**:接 GPT-SoVITS 时采样率、media_type、错误体格式未定。
- **根因**:`GptSoVitsTts` HTTP `POST {baseURL}/tts`,media_type=raw 裸 PCM 流式,**采样率默认 32000 待校准**。
- **解决/现状**:能力门先行、fetch 可注入 mock 测试;**真机待验**(需用户本地起 GPT-SoVITS 服务 + 参考音频路径)。佐证:`packages/providers/test/gpt-sovits-tts.test.ts:194`;commit `68aac20`;memory `canonical-gap-fill-batch`。**待确认**:采样率/media_type/错误体真机校准。
- **教训**:接本地推理服务的采样率/编码要真机校准,默认值多半要改。

---

## F. 工程 / 协作教训

### F1. 子代理误标 MODIFIED 致 archive abort
- **现象**:openspec archive 时 abort。
- **根因**:子代理写 delta spec 易把**新** Requirement 误标 `## MODIFIED`(主 spec 无同名→abort)。
- **解决/现状**:收口时按"主 spec 有无同名"改 ADDED/MODIFIED。佐证:memory `canonical-gap-fill-batch`(教训段,重复出现两次)。
- **教训**:delta spec 的 ADDED/MODIFIED 以主 spec 是否已有同名 Requirement 为准。

### F2. here-string 把 commit message 写成 "@"
- **现象**:git log 出现两条 message 仅为 `@` 的 commit(`68aac20 @ feat(...)`、`621cea5 @ fix(...)`)。
- **根因**:PowerShell here-string 用法不当,`@` 闭合 token 漏进了 commit message。
- **解决/现状**:已合并(message 含杂质但未返工)。佐证:`git log` 中 `68aac20`、`621cea5` 行首的 `@`。
- **教训**:PowerShell 传多行 commit message 用单引号 here-string,闭合 `'@` 必须在第 0 列单独成行;别让闭合 token 漏进正文。

### F3. 共享文件合并的"闭合 token"陷阱
- **现象**:多个子代理在 desktop 共享文件(ipc-contract/main/preload/api/renderer/index.html/styles)末尾各自追加→git 合并时公共的 `}`/`});`/`</section>`/`/**` 被 diff3 提到冲突区外,盲删冲突标记的并集会丢闭合 token / 让成员漏进别人的块。
- **根因**:两侧各自"向同一 interface/describe/registerIpc 加成员 + 再开自己的新块",共享闭合 token 被提出冲突区。
- **解决/现状**:**必须逐区手工解、补回缺失闭合**;只有「各块自带闭合」(styles.css/renderer.ts 语句/preload 加方法)才能 sed 安全并集。佐证:memory `canonical-gap-fill-batch`(合并工程教训段)。
- **教训**:多代理改同一文件的尾部追加是高危合并场景;盲目并集冲突标记会破坏语法,共享结构体务必逐区手解。

### F4. 以源码 / git grep 为准,警惕审计误报
- **现象**:Explore 子代理多次误报"接缝待实装",实际功能已在 master(PPR/closeness、夜间巩固 `#reconcile`/`#surpriseGate`)。
- **根因**:核查未以源码为准。
- **解决/现状**:核查纠错——`consolidation.ts:257-361` 双 Pass 调和确已完整实现,20 测试。佐证:memory `canonical-gap-fill-batch`(核查纠错段)、`voice-pipeline-state`(审计教训段)。
- **教训**:进度核查**以 git grep / 源码为准**,别信凭印象的审计结论。

### F5. 子代理误入"计划模式"卡住
- **现象**:子代理想 ExitPlanMode 停下等确认(但子代理无此工具)。
- **根因**:子代理误入计划模式。
- **解决/现状**:SendMessage 让其"自主执行勿再问"即续。佐证:memory `canonical-gap-fill-batch`(教训段)。
- **教训**:派子代理时明确"自主执行、勿等确认";卡住用 SendMessage 续跑。

### F6. 测试音频产物污染工作区
- **现象**:smoke:qwen/test:voice 输出 *.wav 散落;复刻测试遗留 WAV(`复刻音色测试.wav` 等)。
- **解决/现状**:gitignore 测试音频产物 *.wav。佐证:commit `73bb4c8`;memory `qwen-tts-clone-model` §6 末。
- **教训**:语音冒烟测试会产音频文件,提前 gitignore。

---

## 附:真机验证状态速览(截至 2026-06-25)

- ✅ 已真网络/真机验证通过:qwen 纯文本(qwen-plus)、qwen-tts-realtime WS 合成(内置+复刻音色出声)、qwen omni path-B audio-in 转写、CosyVoice 复刻+合成端到端、desktop Electron 文字路 + 朗读(Web Audio)+ 复刻音色出声 + naudiodon 编译/枚举 22 设备。
- 🟡 待确认/待真机:CosyVoice vs qwen 人耳保真度对比、qwen-asr 情绪入 PAD 真效果、真麦克风免提连续对话、sherpa-onnx 真 API 形状、GPT-SoVITS 采样率/media_type、CosyVoice 北京新式端点二选一、合成期 language_hints 是否生效、CHAT_A_AUTONOMY=on 主动开口。
