# Design — prosody-stt-emotion

> 范围:`packages/providers/**` + `packages/persona/**` 两块积木 + 单测。**不接 voice-loop/cli**(主控桥接,见 §4)。

## 1. qwen3-asr 真实 API 调研(以官方文档为准、真接对齐当时版本)

> 来源:Alibaba Cloud Model Studio 文档(2026-06 抓取)。**真接时以官方文档当时版本为准**,本节为接入对齐基线。
> - Qwen-ASR API 参考:https://www.alibabacloud.com/help/en/model-studio/qwen-asr-api-reference
> - 录音文件识别:https://alibabacloud.com/help/en/model-studio/qwen-speech-recognition
> - 实时语音识别:https://www.alibabacloud.com/help/en/model-studio/qwen-real-time-speech-recognition

### 1.1 端点选择:OpenAI 兼容 `/chat/completions`(多模态 chat,非 transcriptions)

**关键结论(与既有 `OpenAiCompatStt` 不同)**:qwen3-asr-flash 经 OpenAI 兼容端点走的是 **`POST /chat/completions`**(多模态 chat completion,音频作为 `input_audio` content),**不是** `/audio/transcriptions` 的 multipart 上传。因此**不能**直接复用 `OpenAiCompatStt`(它 POST `/audio/transcriptions` + FormData),需**新建** `QwenAsrStt`(POST `/chat/completions` + JSON body)。

- **方法/URL**:`POST {baseURL}/chat/completions`
  - 北京区 `baseURL` = `https://dashscope.aliyuncs.com/compatible-mode/v1`(= 既有常量 `QWEN_DASHSCOPE_COMPAT_BASE_URL`);海外区 `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`(可配置覆盖)。
- **鉴权**:请求头 `Authorization: Bearer <DASHSCOPE_API_KEY>`(**绝不打印 key**)。
- **模型**:`qwen3-asr-flash`(= 既有常量 `QWEN_ASR_DEFAULT_MODEL`)。

### 1.2 请求体(多模态 chat,音频走 input_audio)

```jsonc
{
  "model": "qwen3-asr-flash",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "input_audio", "input_audio": { "data": "data:audio/wav;base64,<BASE64_WAV>" } }
      ]
    }
  ],
  "stream": false,
  // ASR 专属参数:OpenAI Node SDK 走 extra_body;原生 fetch 直接平铺进顶层 body 即可。
  "asr_options": { "language": "zh", "enable_itn": false }
}
```

- `input_audio.data` 接受**音频 URL** 或 **base64 Data URL**(`data:audio/wav;base64,...`)。本实现把入口 PCM 流聚合成 WAV、base64 后以 Data URL 传(无需对象存储)。
- `asr_options.language`:ISO 语种(`zh`/`en`…);省略 = 多语种自动检测。
- `asr_options.enable_itn`:逆文本规整(数字/标点规范化),可选。
- **歧义/可改一处**:`asr_options` 在官方示例里经 SDK `extra_body` 下发;用原生 fetch 时把它平铺进 body 顶层(本实现做法)。若真机证实需嵌套别处,改 `buildRequestBody()` 一处即可(爆炸半径可控,镜像 qwen-tts `buildAppend`)。

### 1.3 响应体 + 情绪字段(本 change 核心)

非流式响应(`stream:false`):

```jsonc
{
  "choices": [
    {
      "message": {
        "content": "今天好累啊",                       // ← 转写文本
        "annotations": [
          { "type": "audio_info", "language": "zh", "emotion": "sad" }  // ← prosody 情绪
        ]
      }
    }
  ]
}
```

- **文本**:`choices[0].message.content`(字符串)。
- **情绪(prosody)**:`choices[0].message.annotations[].emotion`——取首条 `type==="audio_info"`(或首条带 `emotion` 的)标注。`annotations[]` 还含 `language`(检测语种)。
- **情绪 7 类枚举**(官方):`surprised` / `neutral` / `happy` / `sad` / `disgusted` / `angry` / `fearful`。
- **流式**(`stream:true`,本 change 不走):情绪在 `choices[].delta.annotations[].emotion`。本实现取批式非流式(`streaming:false`),与既有 `openai-compat` STT 形态一致。

### 1.4 为何不走 realtime WS

- qwen-asr 另有**实时语音识别**(WebSocket / DashScope SDK,边说边出、增量情绪)。但本 change 目标是**最小可用积木**:批式 `/chat/completions` 已带情绪,接入面小、可注入 fetch、易测且零新依赖(原生 `fetch` + `FormData` 不需要,纯 JSON)。
- realtime WS 留作后续(可镜像 `qwen-tts-realtime` 的注入式 `QwenWsFactory` 可测模式),需要时另起 change。**本 change 的 `SttResult.emotion` 类型对 realtime 同样适用**(未来 realtime provider 也产 `emotion`),不返工。

## 2. `SttResult.emotion` 纯加法证据

`stt.ts` 现有:

```ts
export interface SttResult {
  readonly text: string;
  readonly isFinal: boolean;
  readonly language?: string;
}
```

加一个**可选**字段(`exactOptionalPropertyTypes` 下「不设键」= 字段缺席):

```ts
export type SttEmotionLabel =
  | 'surprised' | 'neutral' | 'happy' | 'sad' | 'disgusted' | 'angry' | 'fearful';
export interface SttEmotion {
  readonly label: SttEmotionLabel;     // ASR 给的离散情绪
  readonly confidence?: number;        // 置信度(若 API 给;当前文档未稳定给出,留位)
}
export interface SttResult {
  readonly text: string;
  readonly isFinal: boolean;
  readonly language?: string;
  readonly emotion?: SttEmotion;       // ← 纯加法:既有 provider 一律不设此键
}
```

**纯加法证据**:
- `FakeStt` / `OpenAiCompatStt` / `WhisperLocalStt` 的 `yield {...}` 一字不改 → 不含 `emotion` 键 → 既有消费者读到 `undefined`(行为字面不变)。
- 可选字段不进既有 golden/快照断言(`toMatchObject`/`toEqual` 用的是不含 emotion 的对象,仍通过)。
- TS 编译:可选字段对既有调用零破坏。

## 3. `prosodyToPadPull` 映射(确定性内核,golden test)

`packages/persona/src/prosody.ts`,纯函数 + 外置映射表(行为即配置):

```ts
prosodyToPadPull(emotion?: SttEmotionLike, map = DEFAULT_PROSODY_PAD_MAP): PadPull
```

- 入参用**结构类型** `SttEmotionLike = { label: string; confidence?: number }`——persona **不依赖 providers 包**(接缝边界 §3.1,同 KvLike 手法);providers 的 `SttEmotion` 结构上满足之。
- 映射表 `DEFAULT_PROSODY_PAD_MAP`:7 类标签 → `PadPull`(基于 PAD 情绪心理学常识方向;数值保守,量级与文本 appraiser 的 `unit≈0.4` 同档,避免语音盖过文本):

  | label      | pleasure | arousal | dominance | 直觉 |
  |------------|---------:|--------:|----------:|------|
  | happy      | +0.4 | +0.3 |  +0.2 | 愉悦、上扬、有掌控 |
  | surprised  |  0.0 | +0.5 |  −0.1 | 强唤起、略失控 |
  | neutral    |  0.0 |  0.0 |   0.0 | 无拉力 |
  | sad        | −0.4 | −0.3 |  −0.3 | 低落、蔫、无力 |
  | fearful    | −0.3 | +0.4 |  −0.4 | 负向、紧张、被压 |
  | angry      | −0.3 | +0.4 |  +0.3 | 负向、激动、有攻击性 |
  | disgusted  | −0.4 | +0.1 |  +0.1 | 厌恶、负向 |

- **置信度调制**(可选、确定性):若 `emotion.confidence` 在 `(0,1]`,拉力按 `confidence` 线性缩放;缺省视作 1(不缩放,行为可断言)。
- **安全降级**:`emotion` 为 `undefined` / `label` 不在表内 / `label==='neutral'` → 返回**零拉力** `{pleasure:0,arousal:0,dominance:0}`(喂 `stepPad` 即「只回归基线、不施加语音拉力」)。
- **结果钳制 [-1,1]**(复用 `clampUnit`)。纯函数、无副作用、可 golden test(两次同入参输出全等)。

## 4. 主控桥接指引(本 change **不做**,留给主控)

主控在 STT 回合里把 prosody 情绪喂进 PAD 内核,典型缝法(伪码):

```ts
// voice-loop / conversation 收到 final SttResult 后(回合收尾旁路,不进首字热路径):
for await (const r of stt.transcribe(mic, { language })) {
  if (!r.isFinal) continue;
  const userText = r.text;
  // 1) 既有文本 appraiser 仍跑(说了什么)
  const textPull = await appraiser.appraise({ userText, pad, turn });
  // 2) 新增:语音情绪 → PAD 拉力(怎么说的);emotion 缺省 → 零拉力,安全
  const prosodyPull = prosodyToPadPull(r.emotion);   // r.emotion 来自 qwen-asr
  // 3) 合并两路拉力(主控决定权重;建议语音为辅,如 textPull + 0.5*prosodyPull),钳制后喂 stepPad
  const merged = mergePulls(textPull, prosodyPull);
  pad = stepPad({ pad, pull: merged, baseline, dials, turn, config });
}
```

要点(主控遵循):
- **emotion 是可选信号**:非 qwen-asr provider(fake/whisper/openai-compat)`r.emotion===undefined` → `prosodyToPadPull` 返零拉力,链路无感(优雅降级)。
- **不进首字热路径**:emotion→PAD 在**回合收尾**做,不阻塞 LLM 首字(承非阻塞召回精神 §3.2)。
- **合并权重外置**(行为即配置):文本拉力 vs 语音拉力的权重由主控配置,本 change 不写死合并策略,只给确定性的「单路语音→拉力」积木。
- **trace**:桥接处把 `r.emotion.label` 记进决策 trace(§8.1),便于「为何这轮心情沉了」可重建。

## 5. 可测试性 / 接缝

- `QwenAsrStt` 的 HTTP 经**注入式 `SttFetch` 端口**(`(url, init) => Promise<Response-like>`),缺省用全局 `fetch`;单测注入假 fetch 返回罐装 JSON → 断言解析出 `text`+`emotion`,**不触网**(镜像 qwen-tts 的 `wsFactory` 注入模式)。
- `registry`:`SttPorts` 加可选 `fetch`;`'qwen-asr'` 工厂透传。缺省(运行时)用全局 fetch,云端档无需运行时二进制端口。
- `prosodyToPadPull`:零依赖纯函数,golden test 钉死 7 类 + 未知 + undefined + 置信度缩放。

## 6. 与 canonical 一致性自检

- §7#5 从语音读情绪 prosody:本 change 打通「ASR 情绪 → 类型 → PAD 拉力」确定性通路 ✅
- §6.1 PAD/`stepPad`:`prosodyToPadPull` 产 `PadPull` 直喂既有 `stepPad`,不改既有公式 ✅
- §4.1/§4.3 STT 能力路由 + 可换性:`qwen-asr` 经判别联合注册,`createStt` 核心零改动,能力门 fail-fast ✅
- §3.2 行为即配置 / 可测试性 / 优雅降级:映射表外置、golden test、fetch 可注入、emotion 缺省零拉力 ✅
- §8.1 id 仅供 trace:provider `id` 不参与业务分支 ✅
