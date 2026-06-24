## 1. 后端复刻模块(packages/providers/qwen-voice-clone.ts)

- [x] 1.1 新建 `qwen-voice-clone.ts`:导出 `VoiceCloneAudio`(`{data,mime}` | `{path}`)、`CreateVoiceOptions`、`createVoice(audio,opts,signal?)→Promise<{voiceId}>`;fetch 注入复用 `FetchLike`(从 gpt-sovits 导出复用),缺省 `globalThis.fetch`。
- [x] 1.2 实现纯函数 `audioToDataUri(bytes,mime)`、`mimeFromPath(path)`(.wav/.mp3/.m4a)、`buildCreateBody(opts,dataUri)`、`parseVoiceId(resp)`;10MB 上限前置校验;缺 key fail-fast、非 2xx/解析失败抛中文错(**不含 key**)。
- [x] 1.3 实现 `listVoices(opts,signal?)`、`deleteVoice(voiceId,opts,signal?)`:`buildManageBody(action,voiceId?)`、`parseVoiceList(resp)`(抽成可改函数,注释"真机校准")。
- [x] 1.4 在 `index.ts` 导出 `qwen-voice-clone`;确保 `FetchLike` 已对外导出可复用。

## 2. qwen-tts-realtime 复刻能力(packages/providers)

- [x] 2.1 `QwenTtsRealtimeOptions` + `QwenTtsRealtime` 增 `voiceCloning?:boolean`,构造时设 `capabilities.voiceCloning`(缺省 false);确认 `synthesize` 已用 `opts.voiceId ?? this.#voice` 把复刻 voiceId 当 `voice` 透传(最小改动,不动内置路径)。
- [x] 2.2 `tts-config.ts` 的 `QwenTtsRealtimeConfig` 增 `voiceCloning?`;`loadTtsConfig` 读 `CHAT_A_TTS_VOICE_CLONING=1`→`voiceCloning:true`(纯加法,省略安全)。
- [x] 2.3 `tts-registry.ts` 的 `qwen-tts` 工厂透传 `voiceCloning`(`...(cfg.voiceCloning!==undefined?{voiceCloning:cfg.voiceCloning}:{})`)。

## 3. 桌面端 IPC 与主进程(packages/desktop)

- [x] 3.1 `ipc-contract.ts`:`IPC` 增 `voiceClone:'voice:clone'`、`voiceCloneResult:'voice:clone-result'`、`voiceCloneStatus:'voice:clone-status'`;增类型 `VoiceCloneResult`、`VoiceCloneStatus`;纯函数 `upsertEnvLocal(text,key,value)`(改/插一键、保留其它行)、`runCloneVoice(port,input)`(注入 `createVoice` + 持久化 + emit 结果/错误,纯逻辑可单测)。
- [x] 3.2 `preload.ts`:`XiaoxueApi` 增 `voiceClone(input)`、`onCloneResult`、`onCloneStatus`;经 `IPC` 常量桥接,白名单最小面。
- [x] 3.3 `main.ts`:注册 `voice:clone` handler——读文件字节(或收渲染层字节兜底)→ 注入真 `createVoice`(apiKey 取 `CHAT_A_DASHSCOPE_API_KEY`、targetModel 取 `CHAT_A_TTS_MODEL` 或默认 vc-realtime)→ 经 `runCloneVoice` 持久化 `.env.local` 的 `CHAT_A_VOICE_ID` + 设入 `handle.env`;启动时探测 key 缺失推 `voiceCloneStatus`;全程 try/catch 不崩。

## 4. 渲染层复刻区(packages/desktop/renderer)

- [x] 4.1 `index.html`:加"复刻小雪声音"区(`<input type="file" accept="audio/*">` + 复刻按钮 + 状态/结果文案位)。
- [x] 4.2 `api.ts`:本地 `XiaoxueApi` 形态同步增 `voiceClone`/`onCloneResult`/`onCloneStatus` 与 `VoiceCloneResult`/`VoiceCloneStatus` 类型。
- [x] 4.3 `renderer.ts`:选文件→取 `.path`(无则 `arrayBuffer()` 兜底)→调 `voiceClone`;订阅结果显示成功 voiceId / 失败中文;订阅 status 无 key 时禁用区。
- [x] 4.4 `styles.css`:复刻区样式(与现有简洁中文 UI 一致,禁用态)。

## 5. 测试(mock fetch / fakeFS,不触网)

- [x] 5.1 `qwen-voice-clone.test.ts`:createVoice 解析 voiceId、参考音频按 base64 data URI 进请求(含 MIME)、action=create、鉴权头正确(不含 key 泄漏)、10MB 上限拒绝、缺 key fail-fast、非 2xx 中文错、AbortSignal、deleteVoice/listVoices 请求体与解析。
- [x] 5.2 `qwen-tts-realtime` 复刻测试(扩 `qwen-tts-realtime.test.ts` 或新文件):voiceCloning=true 能力位、voiceId 当 `session.update.voice` 透传;**默认 voiceCloning=false 时内置路径逐字回归**(硬线)。
- [x] 5.3 `tts-config`/`tts-registry`:env `CHAT_A_TTS_VOICE_CLONING` → config.voiceCloning → provider 能力位;默认不配置时 config 形态不变(回归)。
- [x] 5.4 桌面 `ipc-contract.test.ts` 扩:`upsertEnvLocal`(改/插/保留注释/文件不存在新建)、`runCloneVoice`(成功映射 + 持久化调用 + 失败降级不抛)。

## 6. 校验与收尾

- [x] 6.1 `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm -r typecheck` 全绿。
- [x] 6.2 `npx vitest run` 全绿(新增 + 回归)。
- [x] 6.3 `git commit`(中文)到当前 worktree 分支;不 push、不动 master。
