# 音频设备选择 + 采样率修复与能力驱动解耦 — 设计（Design v1.0）

- 日期：2026-06-26
- 状态：待评审（brainstorming → 待转 writing-plans）
- 关联记忆：`desktop-voice-realmachine-bringup`、`voice-pipeline-state`、`desktop-voice-open-issues`、`qwen-dashscope-api-params`
- 权威设计：`docs/chat-a-canonical-design.md`（本切片为其语音 I/O 接缝的增量实现）

## 1. 背景与问题

真机语音 bring-up（2026-06-25/26，commit `36302b6`）暴露三类问题，本切片一并解决：

1. **没有设备选择能力**：当前选麦/扬声器只能靠 env（`CHAT_A_AUDIO_INPUT_DEVICE_ID` 等数字 id），用户无从知道有哪些设备、id 是多少；且 PortAudio 数字 id 不稳定（插拔/重启/改默认设备会变）。
2. **bug1 — 无音频输出**：`NodeAudioDevice` 输入/输出共用一个 `#deviceId`，设了输入麦 id 后播放也往麦克风开输出流，报 `Channel count exceeds maximum number of channels for device`。
3. **bug2 — 转写乱码**：麦克风 48kHz 经「线性插值、无抗混叠低通」重采样到 16kHz 喂 STT，3 倍抽取把 8–24kHz 频段混叠折回语音带，导致转写乱码。

延伸需求（用户提出）：**采样率/音频格式参数需解耦**——未来会换不同模型，不同模型对采样率要求不同，现在这些参数被焊死或与「选哪个模型」各自为政。

### 1.1 调研结论（音频参数，4 路子代理）

| 模型 | 输入采样率 | 结论 |
|---|---|---|
| `paraformer-realtime-v2` | 任意率（48k 可直传） | 官方立场=如实声明原始率、勿自行重采样 |
| `qwen3-asr-flash-realtime` | 固定 16k | 必须降采样；官方示例用 ffmpeg(`-ar 16000`，带抗混叠) |
| Qwen-Omni realtime（含 3.5） | 固定 16k 输入 / 24k 输出 | 现有 48k→16k 降采样目标正确，仅质量不行 |
| `qwen3.5-omni-flash-realtime` | 同上（16k-in/24k-out） | 裸别名可调；与 `qwen3-omni-flash-realtime` 同协议，换模型≈改 model 字符串；单会话音频轮次 8→80，官方推荐 semantic_vad |

- **bug2 判定**：乱码高度吻合「无抗混叠降采样」，本切片换带低通的重采样器修复。
- **耦合现状**：VAD/Silero、EOU/Smart-Turn **物理锁 16k**（ONNX 输入，改不得）；TTS provider 的 `opts.sampleRate`、`AudioFormat` 接口、`AudioFrame` 带 format、`samplesPerSlice(rate)` 已解耦；但 STT 输入率写死 `STT_SAMPLE_RATE_HZ=16k`（qwen-asr/openai-compat 不可配）、Omni 无能力声明、采集率不读 provider 能力、无采样率校验——这些是解耦目标。

## 2. 目标与非目标

### 目标（本切片范围＝中度 + omni 解耦）
1. 开机枚举可用**输入/输出**设备，让用户选择；选择**存设备名**（非数字 id）到 `.env.local`，启动按名解析当前 id。
2. 触发时机：**首次/未选过/解析失败才弹**；已选且设备在 → 静默沿用；设置/命令里可随时重选。
3. 两个前端都做：**CLI 文字菜单** + **desktop 设置面板下拉框**，共享 client 层枚举/解析内核。
4. 修 bug1（输入/输出 deviceId 分离）、修 bug2（抗混叠重采样）。
5. **能力驱动采样率解耦**：采集目标率由「当前路径 provider 的能力声明」决定（STT 读 `capabilities.sampleRate`，omni 读新增 `inputSampleRate`），收口在一个解析函数；VAD/EOU 恒拿 16k；加采样率校验 fail-fast。
6. omni 参数解耦 + **默认模型升 `qwen3.5-omni-flash-realtime`** + `OmniTurnDetection` 增加 `semantic_vad`。
7. **默认运行路径仍为 STT 路**（omni 为次要、本次不作主测）。

### 非目标（留给后续「完整解耦」切片）
- 播放率读帧动态开流（当前 TTS=24k、播放=24k 一致，不动）。
- 模型→音频参数注册表（按 model 名自动推参）。
- `TTS_AUDIO_FORMAT` 字面 24000 常量化。
- STT 要求率 ≠ 16k 时的「STT 流与 VAD 流分叉」双流实现（本切片只实现共用 16k 路径，留接缝不实现 = YAGNI）。

## 3. 架构总览

```
麦克风(设备原生率, 如48k)
  → NodeAudioDevice 按原生率开流
  → 抗混叠重采样(resample.ts)  ──┬──→ 16k 流 → VAD/Silero + EOU/Smart-Turn (恒16k, 硬约束)
                                 └──→ 目标率流 → STT / omni 端口
                                      (目标率 = resolveRequiredInputRate(path, stt, omni))
                                      当前所有模型目标率=16k → 与 VAD 流共用同一条16k流(零额外开销)

下行(本切片不改): TTS(24k) → AudioFrame.format → device.play → 输出设备(分离的 outputDeviceId)
```

采集率（开流率）由 §4 设备选择自动取自设备 `defaultSampleRate`，用户无需配 `CHAT_A_AUDIO_CAPTURE_RATE`（保留为手动逃生口）。

## 4. 详细设计

### §1 共享设备内核 `packages/client/src/audio/device-registry.ts`（新增，纯函数）

数据模型：
```typescript
interface AudioDeviceInfo {
  id: number;             // 当前 PortAudio id（仅本进程有效，不持久化）
  name: string;           // 设备名（持久化用这个）
  hostApi: string;        // hostAPIName，用于消歧（同一麦在 MME/WASAPI 各出现一次）
  maxInputChannels: number;
  maxOutputChannels: number;
  defaultSampleRate: number;  // 设备原生率 → 自动推导开流率
}
```
API（注入 `getDevices` 以可单测）：
- `listInputDevices(mod): AudioDeviceInfo[]` — `maxInputChannels > 0`
- `listOutputDevices(mod): AudioDeviceInfo[]` — `maxOutputChannels > 0`
- `resolveDeviceByName(devices, name, hostApi?): AudioDeviceInfo | null` — 按 `(name, hostApi)` 精确匹配；命中返回当前 id + defaultSampleRate；未命中返回 null；同名多设备用 hostApi 消歧，仍歧义取第一个并 warn。

### §2 持久化（`.env.local` upsert，沿用复刻功能的 `upsertEnvKey`）

存储键：
- `CHAT_A_AUDIO_INPUT_DEVICE_NAME` / `CHAT_A_AUDIO_OUTPUT_DEVICE_NAME` — 设备名
- `CHAT_A_AUDIO_INPUT_DEVICE_HOST` / `CHAT_A_AUDIO_OUTPUT_DEVICE_HOST` — hostApi（消歧，可选）

**不存** 数字 id 和采集率（每次启动解析/推导）。旧的 `CHAT_A_AUDIO_INPUT_DEVICE_ID` / `_CAPTURE_RATE` / `_OUTPUT_DEVICE_ID` 保留为**显式手动覆盖逃生口**（设了就优先用，给调试/确定性测试留路）。

### §3 启动解析流程 + 两个壳

启动解析（装配层，仅当语音开 + `CHAT_A_AUDIO_DEVICE=node` 时）：
```
1. 枚举设备
2. 读 *_DEVICE_NAME：
   - 有名 → resolveDeviceByName：
       命中 → 用解析 id + 原生率构造 NodeAudioDevice（静默）
       未命中 → 触发"选择"（壳层），选完 upsert 回 .env.local
   - 无名（首次）→ 触发"选择"
3. 非交互环境（CLI 管道/CI、desktop 探测失败）无法弹选择 → 回退系统默认(-1) + 明确中文提示，绝不崩(§3.2)
```

**CLI 壳**（`cli.ts` 启动、进 REPL 前；复用已有 readline）：文字编号菜单，先选输入再选输出，写回 `.env.local`。
```
未检测到已保存的输入设备，请选择麦克风：
  [0] 麦克风阵列 (Intel® 智音技术)  (WASAPI, 48000Hz)
  [1] 麦克风 (Realtek)             (MME, 44100Hz)
请输入序号 › _
```

**Desktop 壳**（沿用 `ipc-contract.ts` 纯函数 + 注入面风格，可单测）：
- 新增 IPC：`audio:listDevices`（主进程枚举返回输入/输出清单）、`audio:selectDevice`（渲染层提交 → 主进程 upsert `.env.local`）。
- 渲染层设置面板两个下拉框（输入/输出），首次/解析失败时引导选择，选择即时保存。

### bug1 — 输入/输出 deviceId 分离

- `NodeAudioDeviceOptions` 增加 `readonly outputDeviceId?: number;`
- `NodeAudioDevice` 增加 `#outputDeviceId` 字段；构造 `this.#outputDeviceId = opts.outputDeviceId ?? -1`（缺省 -1=默认扬声器，**绝不套用输入 id**）。
- `#openOutput`（node-audio-device.ts:~242）改用 `this.#outputDeviceId`。
- `createAudioDevice` 把解析出的输出设备 id 透传为 `outputDeviceId`，读 `CHAT_A_AUDIO_OUTPUT_DEVICE_ID` 作覆盖逃生口。

### §4 采样率修复 + 能力驱动解耦

**§4.1 抗混叠重采样** `packages/client/src/audio/resample.ts`（新增，纯函数）
- 用带低通的重采样（多相 FIR / 抽取前截止 ~7.2kHz 低通）替换 `resampleLinearTo` 的裸线性插值。
- 可单测：喂正弦扫频，断言 >8kHz 分量在降采样后被压制（混叠抑制）。
- `node-audio-device.ts` 改用它。

**§4.2 能力驱动采集率**
- 约定：`SttCapabilities.sampleRate` = 该 STT 要求的输入率（现已有此字段，无人读）。新增 `resolveRequiredInputRate(path, stt, omni): number` 收口解析：STT 路读 `stt.capabilities.sampleRate`，omni 路读 `omni.inputSampleRate`。
- 装配层（`startVoiceMode`/`createAudioDevice`）用该结果作为重采样目标，不再硬引常量。
- 设备按原生率开流（取 §3 解析出的 `defaultSampleRate`）→ 抗混叠重采样到目标率。
- 当前所有模型目标率=16k，行为正确；接缝就位，未来换非 16k 模型只需其能力声明不同。

**§4.3 VAD/EOU 恒 16k 分支**
- 保证喂检测器的永远是抗混叠后的 16k。目标率=16k（现状）时 STT/omni 与 VAD 共用同一条 16k 流；目标率≠16k 时才分叉第二条（本切片不实现，留接缝）。

**§4.4 采样率校验（fail-fast）**
- 装配时校验「采集可产出的率」与「provider 要求率」可达；不可达 → 明确中文报错而非静默乱码。

**§4.6 omni 参数解耦**
- `OmniAudioPort` 增加可选 `readonly inputSampleRate?: number`（必要时 `inputAudioFormat?`）。
- `QwenOmniLlm` 声明 `inputSampleRate = 16000`（经 `QwenOmniLlmOptions` / `CHAT_A_OMNI_SAMPLE_RATE` 可覆盖）；发送时 `input_audio_format`/采样率由 options 驱动（从硬写注释提升为配置）。
- 装配层 omni 路读 `omni.inputSampleRate`（即 §4.2 的 `resolveRequiredInputRate` 分支）。
- **默认 omni 模型升 `qwen3.5-omni-flash-realtime`**（改 `cli-voice.ts` 的 `DEFAULT_OMNI_MODEL`；裸别名可调，无需日期快照；仍可经 `CHAT_A_OMNI_MODEL` 覆盖）。
- `OmniTurnDetection` 类型增加 `'semantic_vad'`（3.5 官方推荐）；映射到 session 的 `turn_detection.type`。**omni 路默认回合模式由 `'manual'` 改为 `'semantic_vad'`**，经 `CHAT_A_OMNI_TURN_DETECTION` 可覆盖（manual/server_vad/semantic_vad）；此改动只影响 omni 路，不影响 STT 路。
- 不回归：Qwen-Omni=16k、canonical=16k，落地后行为字面不变。

## 5. 错误处理与降级（§3.2 永不崩永不哑）

- 枚举失败 / naudiodon 未装 / 选择中途取消 / 解析未命中且非交互 → 回退系统默认设备 + 中文提示，文字路不受影响（沿用现有 `probeVoice` / 回落 Fake 范式）。
- 采样率不可达 → fail-fast 明确报错（而非静默乱码）。
- omni 账号未开通 / 模型不可用 → 沿用现有 omni 回落 STT 路径范式。

## 6. 测试

- `device-registry`：注入假 `getDevices`，覆盖枚举过滤、name 解析命中/未命中/同名 hostApi 消歧。
- `resample`：正弦扫频断言混叠抑制；恒等率（16k→16k）断言透传不变。
- `resolveRequiredInputRate`：STT/omni 两路 + 缺省回退。
- `createAudioDevice`（`key-only-wiring.test.ts`）：补 name 解析、输入/输出 id 分离、`CHAT_A_AUDIO_OUTPUT_DEVICE_ID` 覆盖用例。
- desktop IPC（`ipc-contract.test.ts`）：补 `audio:listDevices` / `audio:selectDevice`。
- omni（`qwen-omni-llm.test.ts`）：`inputSampleRate` 声明、`semantic_vad` 映射、默认 model = 3.5。
- 采样率校验 fail-fast 用例。

## 7. 主要改动文件

- 新增：`packages/client/src/audio/device-registry.ts`、`packages/client/src/audio/resample.ts`
- 改：`packages/client/src/audio/node-audio-device.ts`（outputDeviceId、改用抗混叠重采样、枚举提取为正式 API）
- 改：`packages/client/src/cli-voice.ts`（解析流程、`resolveRequiredInputRate`、输出 id、DEFAULT_OMNI_MODEL=3.5）
- 改：`packages/client/src/cli.ts`（CLI 选择菜单壳）
- 改：`packages/runtime/src/voice-loop.ts`（`OmniAudioPort.inputSampleRate`）
- 改：`packages/providers/src/qwen-omni-llm.ts`（`inputSampleRate`、`semantic_vad`、发送格式配置化）
- 改：`packages/providers/src/stt-*.ts`（STT capabilities.sampleRate 不再各处硬写、可配）
- 改：`packages/desktop/src/ipc-contract.ts`、`main.ts`、`preload.ts`、渲染层（设备列举/选择 IPC + 下拉框）
- 清理：`36302b6` 遗留的纯诊断日志 spam（`[mic] rms`/`[voiceStart]`/`[trace]`/`[timing]`/设备枚举临时块/`probeVoice` 临时 console.error）

## 8. 风险与开放项

- **qwen3.5-omni-flash-realtime 账号开通状态未确认**（疑似邀测/白名单）、realtime 精确计费/限流、确切日期快照 id 均**无官方确认**——上线前需在百炼控制台核实。默认升 3.5 后若账号未开通，靠现有 omni 回落 STT 范式兜底；可经 `CHAT_A_OMNI_MODEL` 回退 3 路。
- 抗混叠重采样选型（自写多相 FIR vs 引入轻量库）需在 writing-plans 阶段定，受嵌入式轻量化约束（见记忆 `embedded-lightweight-strategy`）。
- 设备名在某些驱动下可能超长/带特殊字符，`.env.local` 写入需转义（`upsertEnvKey` 现有行为需复核）。
