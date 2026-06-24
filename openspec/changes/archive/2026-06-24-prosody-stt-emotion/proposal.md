## Why

§7#5「**从语音读情绪 prosody**」要求小雪听出**怎么说的**(疲惫/低落/兴奋),不只是**说了什么**——这是「伴侣而非助手」的关键体感(prosody 永不漏听,见 §0/§2 不可配底线)。当前 STT 接缝只产 `{text, isFinal, language?}`,**没有任何情绪信号**通路;PAD 情绪内核(§6.1)也只吃文本 appraiser 的拉力,**听不见语气**。

阿里 DashScope 的 **qwen3-asr-flash**(经 OpenAI 兼容端点)在转写文本之外**自带说话人情绪标注**(`annotations[].emotion`,7 类:surprised/neutral/happy/sad/disgusted/angry/fearful)。key 已在 `.env.local`(`CHAT_A_DASHSCOPE_API_KEY`)。这正好补上「prosody → 情绪」这条通路的**云端积木**。

本 change 只做**两块积木 + 单测**,**不接进 voice-loop/conversation/cli**(主控桥接区):
1. **`qwen-asr` STT provider**:转写除文本外**可选返回 prosody 情绪信号**(`SttResult.emotion?`,**纯加法**;既有 provider emotion 恒为 undefined,消费者不受影响)。
2. **`prosodyToPadPull(emotion)`**:persona 侧的**确定性纯函数**,把 ASR 情绪标签映射成 PAD 拉力(可 golden test),供主控后续喂 `stepPad`。

## What Changes

- **STT 返回类型纯加法扩展**(`stt.ts`):`SttResult` 加可选 `emotion?: SttEmotion`(标签 + 可选置信度);新增 `SttEmotion`/`SttEmotionLabel` 类型。**既有实现一律不设此键**(`exactOptionalPropertyTypes` 合规),既有 `SttProvider` 消费者读不到即等于行为不变。
- **新增 `QwenAsrStt`**(`packages/providers/src/qwen-asr-stt.ts`):实现 `SttProvider`。
  - 经 DashScope OpenAI 兼容 **`/chat/completions`** 端点(qwen3-asr 用**多模态 chat** 形态,音频走 `input_audio` base64 Data URL,**非** `/audio/transcriptions` multipart——见 design §1)。鉴权 `Authorization: Bearer <key>`(**不打印 key**)。
  - 把入口 `AsyncIterable<PcmChunk>` 聚合为单个 WAV(批式,`streaming:false`),base64 后塞进 `input_audio.data`。
  - 解析:文本取 `choices[0].message.content`;**情绪取 `choices[0].message.annotations[].emotion`** → 映射成 `SttResult.emotion`(取首条 audio_info 标注;无标注则不设 emotion 键,纯加法)。
  - **能力门 fail-fast**:`assertSttLanguage`;构造缺 key → fail-fast(提示 `CHAT_A_DASHSCOPE_API_KEY`)。
  - **可测**:HTTP 经**注入式 `fetch` 端口**(缺省用全局 `fetch`),单测注入假 fetch、**全程不触网**。
- **配置 + 注册**:
  - `stt-config.ts`:新增判别联合分支 `QwenAsrSttConfig`(`kind:'qwen-asr'`);`loadSttConfig` 支持 `CHAT_A_STT_KIND=qwen-asr`(model/language/enableItn,apiKey 回落 `CHAT_A_DASHSCOPE_API_KEY`,baseURL/model 有内置默认)。**保留**既有 `kind=qwen` 便捷档(回归不破)。
  - `stt-registry.ts`:`SttPorts` 加可选 `fetch` 端口;登记 `'qwen-asr'` 工厂。
  - `index.ts`:导出新 provider 与类型。
- **persona 侧** `prosodyToPadPull`(`packages/persona/src/prosody.ts`):**确定性纯函数**,7 类情绪 → PAD 拉力(映射表外置 `DEFAULT_PROSODY_PAD_MAP`,行为即配置;可注入覆盖)。未知/缺省标签 → 零拉力(安全降级)。`index.ts` 导出。

## 范围与 Non-goals

- **只做 providers + persona 两侧积木 + 单测**。**不碰** voice-loop/conversation/cli/runtime/cognition/memory/voice-detect/gateway——STT 路把 emotion 经 `prosodyToPadPull` 喂 `persona.stepPad` 的桥接**由主控做**(指引见 design §4)。
- **不发真网络请求**:单测全用注入式假 fetch,覆盖「响应→解析出 text+emotion」「无 annotations 时不设 emotion」「能力门/缺 key fail-fast」。真音频识别手测留给主控(需 key + 真网络)。
- **不改既有 STT/persona 行为**:`SttResult.emotion` 纯加法,既有 fake/openai-compat/whisper-local 路径与既有 persona 公式一字不动;既有测试全绿(回归硬线)。新东西默认不启用(需显式 `kind=qwen-asr`)。
- **严格只改** `packages/providers/**` + `packages/persona/**`(+ 各自测试)+ 本 change 文档。

## Capabilities

### Modified Capabilities
- `provider-tooling`: 在既有 STT Provider 接缝能力上补两条:① `SttResult` **纯加法**可选 `emotion`(prosody 情绪信号),既有 provider 恒不设、消费者行为不变;② **DashScope qwen3-asr-flash STT Provider**(`kind:'qwen-asr'`)经 OpenAI 兼容 `/chat/completions` 转写并解析 `annotations[].emotion`,fetch 可注入以保证不触网。

### Added Capabilities
- `persona-emotion`: 新增**确定性 prosody 情绪 → PAD 拉力映射**要求(`prosodyToPadPull`):把 ASR 的离散情绪标签映射成 PAD `PadPull`(可 golden test、映射表外置可配),供 §6.1 `stepPad` 消费,作为「从语音读情绪」(§7#5)喂入 PAD 内核的确定性内核。

## Impact

- **影响 canonical 章节**:§7#5(从语音读情绪 prosody)、§6.1(PAD 拉力/`stepPad`)、§4.1/§4.3(STT 能力路由 + 可换性)、§3.2(行为即配置、可测试性确定性内核 golden test、优雅降级)、§8.1(id 仅供 trace)。与权威设计一致。
- **代码**:仅 `packages/providers`(`stt.ts` 加类型、`qwen-asr-stt.ts` 新增、`stt-config.ts` 加分支+env、`stt-registry.ts` 注册+fetch 端口、`index.ts` 导出)+ `packages/persona`(`prosody.ts` 新增、`index.ts` 导出)。
- **测试**:`qwen-asr-stt.test.ts`(注入假 fetch:解析 text+emotion / 无 annotations / 能力门 / 缺 key)、`stt.test.ts` 回归(kinds 列表 + qwen-asr config)、`prosody.test.ts`(golden 映射 + 确定性)。不触网。
- **延迟预算**:批式识别(整段上传),与既有 `openai-compat` STT 一致,不引入新的首字延迟焊接;emotion 随转写同程返回,`prosodyToPadPull` 为 O(1) 纯函数。主控桥接时把 emotion 喂 PAD 走**回合收尾/旁路**,不进首字热路径(承非阻塞召回硬约束精神)。
- **不涉及**:LLM/omni/TTS、runtime/client/memory/voice-detect/gateway;现有 STT/persona 路径行为不变。
