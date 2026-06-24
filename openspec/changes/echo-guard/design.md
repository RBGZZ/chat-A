# 设计:EchoGuard 自打断防护(软件侧部分缓解)

## 边界声明(必读)

> **本 change 不是回声消除(AEC)。** 真正消除「扬声器→空气/回环→麦克风」的回声需**声学/原生**方案:自适应滤波器(如 WebRTC AEC3 / speexdsp)拿**播放参考信号**做线性回声对消,再叠残余回声抑制。这类方案依赖原生库 + 参考信号对齐 + 帧级时钟,**不在本 change 范围**,留作未来/原生(树莓派上可能走 ALSA/PulseAudio 的硬件或软件 AEC,或裸 WebRTC APM)。
>
> 本 change 做的是**软件侧部分缓解**:在小雪自己说话(`speaking`)时,**提高 barge-in 的确认门槛**(连续 N 帧高置信语音 + 可选能量阈值),把「自家 TTS 回声引起的偶发/单帧误触」过滤掉。它**不能**消除持续的强回声(那种情况下连续 N 帧也会达标),只能压制典型的、断续的、低能量的回声毛刺。完整方案仍需 AEC。

## 目标与非目标

**目标**
1. `speaking` 期压制自家 TTS 回声造成的**误打断**(刚开口就被自己掐断)。
2. **真人打断仍灵敏可用**——连续 N 帧真语音必能打断,绝不变成「打不断」。
3. **非说话期(listening/endpointing)灵敏度逐字不变**(端点检测不受影响)。
4. **行为即配置 + 安全默认**:未注入即现状;默认 N=1 使既有 barge-in 时序逐字不变(回归硬线)。

**非目标**:AEC(见边界声明);改 client/cli;接真模型/触网;改其余状态机迁移。

## 现状与接缝

`voice-loop.ts:342-363` 的 `speaking` 分支已分两路:
- **未注入 attention**:`speech_start` 事件即 `#go('vad:speech_start') → #interrupt()`(即时打断)。
- **注入 attention**:经 `#applyAttention` 按 `attention_mode` 判 `trueInterrupt`。

EchoGuard 插在「检出语音」与「确认打断」之间,**对两路都生效**:先做「这是不是足够确信的真语音(而非回声毛刺)」的连续帧去抖,**确认后**才走原有打断路径(未注入 attention → 即时打断;注入 attention → 再按 mode 判)。三者关系:

```
speaking 期上行帧
  → VAD(result: prob / speaking / event)
  → EchoGuardGate.push(frame)         // 本 change 新增;未注入则跳过(等价 N=1 即时)
       confirmed?  ──否──> 保持 speaking(只感知不打断,清晰可追溯)
            │是
            ▼
  → 原有打断路径:
       未注入 attention → #go(speech_start) + #interrupt()    // 现状
       注入 attention   → #applyAttention(...)                 // §7 软反转
```

## EchoGuardGate 算法(纯函数,确定性,无时钟)

放在 `@chat-a/voice-detect`(与 `VadGate` 同包同范式:纯逻辑去抖类,可被 runtime 复用、可单测)。

```ts
export interface EchoGuardConfig {
  /** 是否启用 EchoGuard(false=禁用,等价即时确认,逐字现状)。 */
  readonly enabled: boolean;
  /** speaking 期确认真打断所需的「连续高置信语音帧数」N(≥1)。N=1 等价即时打断(现状)。 */
  readonly confirmFrames: number;
  /** 确认所需的最低语音概率(prob ≥ 此值才算「高置信」帧);默认复用一个偏高阈值,压回声。 */
  readonly minSpeechProb: number;
  /** 可选能量阈值(RMS 归一化 0~1):>0 时要求该帧能量也达标才计入连续帧;0/缺省=不查能量。 */
  readonly minEnergy: number;
}

export const DEFAULT_ECHO_GUARD_CONFIG: EchoGuardConfig = {
  enabled: false,       // 安全默认:不启用 → VoiceLoop 未注入即现状
  confirmFrames: 1,     // 默认 N=1 → 即时打断,既有 barge-in 时序逐字不变(回归硬线)
  minSpeechProb: 0.5,   // 与 DEFAULT_VAD_CONFIG.speechProbThreshold 对齐(不比 VAD 更宽松)
  minEnergy: 0,         // 默认不叠能量(纯帧数去抖);需要时由 config 打开
};
```

`EchoGuardGate` 状态:`#run`(当前连续达标帧数)。每帧喂入 `(prob, energy01, speakingFromVad)`:

```
push({prob, energy01, speakingFromVad}):
  if !enabled: return { confirmed: true }          // 禁用=即时确认(现状)
  highConf = (prob >= minSpeechProb)
             && speakingFromVad
             && (minEnergy <= 0 || energy01 >= minEnergy)
  if highConf:  #run += 1
  else:         #run = 0                            // 掉到静音/低置信即清零重计(防回声断续累积)
  return { confirmed: #run >= confirmFrames, run: #run }
reset(): #run = 0
```

**关键性质**
- **N=1**:首个达标帧即 `confirmed:true` → 与现状「检出 speech_start 即打断」时序一致(回归硬线)。
- **N≥2**:需**连续** N 帧达标;中途任一帧掉线(静音/低概率/能量不足)即清零——典型回声是断续/低能量毛刺,难连续达标;**真人持续说话**概率持续高,连续 N 帧轻松达标 → 仍能打断(只延迟约 (N-1)×帧时长)。
- **无时钟、无副作用**:纯计数,确定性可测(喂概率序列断言 confirmed 序列)。
- `reset()` 在每次回合切换/打断后调用,清连续计数(承 VadGate.reset 范式)。

### 能量计算(可选叠加)

VoiceLoop 把 `PcmFrame.samples`(Int16)算 RMS 后除以 `fullScale`(32768)归一化到 0~1 喂 Gate(复用 `EnergyVadConfig` 同款归一,无 magic number)。能量阈值的意义:自家回声经空气衰减后**能量通常低于近场真人说话**,叠一道能量门能进一步压回声。默认 `minEnergy=0`(不查),保守不误伤真人。RMS 计算放 VoiceLoop 侧(它持帧),Gate 只收已归一的标量(保持 Gate 纯净、不依赖 PcmFrame 形状)。

## VoiceLoop 集成(packages/runtime/src/voice-loop.ts)

- 构造可选项新增 `readonly echoGuard?: EchoGuardConfig`。注入则 `new EchoGuardGate(cfg)` 存为 `#echoGuard`;未注入 `#echoGuard = undefined`。
- `#onAudio` 的 `speaking` 分支改为:**先**问 EchoGuard 是否确认(未注入则恒确认=现状),**确认后**才进入既有两路打断逻辑。未注入时 `speaking` 分支逐字不变(连 `#echoGuard` 判空短路都不进)。
- 进/出 `speaking` 时 `reset()` EchoGuard 连续计数(在 `#go` 进 speaking 后、`#interrupt`/`#finishTurn`/`#resetToListening` 处);保守起见也可在每次确认打断后 reset。
- **危机/硬打断豁免**:若注入 attention 且其 `buildSignal` 产出的信号带 `hardInterrupt`/`crisis`,则**绕过 EchoGuard 直接走打断**(承「救命不可配」§法律底线)。实现:speaking 期先按现有 attention `buildSignal` 取 signal,若 `signal.hardInterrupt || signal.crisis` 为真则跳过 EchoGuard 确认。
  - 注:未注入 attention 的纯 EchoGuard 路径没有 crisis 标注来源,此时 EchoGuard 的 N 帧去抖照常生效(纯语音对话场景,无危机分类器);豁免只在已有 attention 信号通道时有意义。

## 测试策略(确定性、不触网)

`packages/voice-detect/test/echo-guard.test.ts`(Gate 纯函数):
1. `enabled:false` → 恒 `confirmed:true`(现状)。
2. `N=1` → 首个达标帧即确认。
3. `N=3` → 第 3 个连续达标帧才确认;中途插一个低概率帧 → 计数清零,需重新连续 3 帧。
4. 能量阈值:`minEnergy>0` 时,概率达标但能量不足 → 不计入。

`packages/runtime/test/voice-loop-echo-guard.test.ts`(VoiceLoop 集成,Stub VAD 注入确定帧序列):
1. **回声样式被压制**:注入 `echoGuard{enabled,confirmFrames:3}`,speaking 期喂「高-低-高-低」断续回声样式(连续达标不足 3)→ 保持 `speaking`,不打断、无半句写回。
2. **真人连续 N 帧仍能打断**:同配置,speaking 期喂连续 ≥3 帧高概率 → 打断回 `listening` + clearBuffer + 半句写回(证「打得断」)。
3. **非说话期灵敏度不变**:listening/endpointing 期帧序列驱动正常闭环,EchoGuard 注入与否结果一致(只 speaking 期生效)。
4. **危机豁免**:注入 attention 的 `buildSignal` 标 `hardInterrupt`,speaking 期单帧即打断(不被 N 帧拖延)。

`packages/runtime/test/voice-loop.test.ts`(既有,回归硬线):**不改**——未注入 EchoGuard 时全绿(默认即现状)。

## 风险与权衡

- **N 太大 → 打断变迟钝**:故默认 N=1(零行为变化),手测调大须在「压回声」与「真人打断延迟」间权衡;N×帧时长应远小于人对打断的容忍(建议 ≤5 帧 / ≤50ms)。
- **强持续回声 EchoGuard 压不住**:如实承认——那是 AEC 的活;EchoGuard 只压断续/低能量毛刺。
- **能量门误伤小声真人**:故 `minEnergy` 默认 0(不启用),需手测标定后再开。
- **真机待验证**:N 的实际取值、能量阈值、是否够压住具体设备(Pi 外放 + 板载麦)的回声,须 PC/Pi 真机手测标定;CI 只验逻辑确定性。
