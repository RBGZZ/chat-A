# 设计:autonomy↔runtime 三处接缝填补

承 §7(行为层 / URGENT 软反转)、§4(打断在 runtime 执行)、§3.1(依赖倒置)、§3.2(可测 / 优雅降级)。
目标:**填缝不重写**。复用 VoiceLoop 既有打断核心(`#interrupt` + abort 三件套)、arbitrate 纯函数、open-thread/idle-arc 技能。

## 缝 1:`shouldPreempt` → VoiceLoop 真打断(干净触发入口)

### 现状
- `ProactiveTurnRunner.run` 产出 `shouldPreempt = outcome.decision==='speak' && outcome.preempted`(纯信号,§4 不在本包真 abort)。
- `AutonomyRunnerSkill.tick` 仅 `this.#onPreempt?.(outcome)` —— 装配缺省不传,等于丢弃。

### 设计
VoiceLoop 新增**触发钩子**(纯加法,不改打断核心):

```ts
/** autonomy 抢占触发(§7 软反转下的「autonomy 自身抢占」,受 attention + is_speaking 约束)。
 *  返回是否真打断;绝不凌驾用户语音 URGENT(那条 barge-in 路径独立、恒最高)。 */
requestAutonomyPreempt(reason?: string): boolean
```

判定(VoiceLoop 内,§7):
1. **非 speaking** → 不打断(没有在飞输出可抢占),返回 false。autonomy「抢占」只对在飞的 autonomy/动作输出有意义;空闲时它本就该走正常 `requestSpeak` 放行,不需打断。
2. speaking 且**未注入 attention** → 复用现状语义:直接进 `#interrupt`(autonomy on 但 attention 未接时,行为是「能抢就抢」,与 attention 缺省即时打断一致),返回 true。
3. speaking 且**注入 attention** → 经 `evaluateAttention(mode, {sustainedMs:0, somethingInFlight:true})` 判:`verdict.trueInterrupt` 才 `#interrupt`。这让 autonomy 自身抢占**受 attention_mode 约束**(focus 模式下 autonomy 不该轻易打断它自己在说的话)。

关键:**用户语音 URGENT 的 barge-in 路径(`#onAudio` 里 speaking 检出语音)完全不经此钩子**,它独立且恒最高 —— autonomy 抢占绝不与之竞争。`reason` 透传给 `turn:interrupt` 的 reason(§8.1 可追溯,区分 `barge_in` 与 `autonomy_preempt`)。

### 装配接通
`assembleAutonomy` 新增可选 `preempt?: (reason?: string) => void`;`onPreempt` 缺省回落:`onPreempt ?? (() => preempt?.('autonomy_preempt'))`。cli 级把 `voiceLoop.requestAutonomyPreempt` 传进来即真接(本 change 提供接缝;喂实例的 cli 胶水属拥有 cli 的一方)。

## 缝 2:`is_speaking` 真闸

### 现状
`assembleAutonomy` 的 `readState = deps.currentSpeakState ?? (() => ({ isSpeaking: false }))` —— 永远「不在说」。

### 设计
- VoiceLoop 暴露只读:`get isSpeaking(): boolean`(= `#state === 'speaking'`)与 `speakState(): SpeakStateView`(`{ isSpeaking, speakingPriority? }`,MVP `speakingPriority` 省略 → arbitrate 按最低看待,任何明确优先级可抢)。
- 装配:`currentSpeakState` 由 cli 传 `() => voiceLoop.speakState()`;arbiter 闭包**经回调读**真状态,**不 import VoiceLoop 内部**(只用其公开方法返回的纯数据)。
- 类型:VoiceLoop 返回的视图与 autonomy `SpeakState` 同构;为避免 runtime → autonomy 反向依赖,runtime 侧定义**结构等价**的 `SpeakStateView`(`{ isSpeaking: boolean; speakingPriority?: 'URGENT'|'PERCEPTION'|'LOWEST' }`),装配层做结构透传(同形状,无需转换)。

## 缝 3:autonomy 真候选生成

### 现状
`AutonomyRunnerSkill.tick` 用 `event.payload.description ?? event.kind` 当唯一候选(占位)。

### 设计
新增 autonomy 侧接口(standalone,不依赖 memory):

```ts
/** 主动候选源:据当前 signal/context 产出真实候选发言(空数组=本 tick 无可说)。 */
export interface ProactiveCandidateSource {
  gather(ctx: { readonly signalKind: string; readonly description?: string }):
    Promise<readonly string[]> | readonly string[];
}
```

- `AutonomyRunnerSkill` 接受可选 `candidateSource`:有则 `await gather(...)`,非空用之;空或无源回落现状占位。
- **真候选来源**(在 autonomy 提供适配器,装配注入):
  - open-thread:复用 `OpenThreadFollowUpSkill` 的 `renderFollowUpText` + `OpenThreadPort.listOpenThreads`,挑「最值得」一条渲染为候选。
  - idle-arc:复用 `IdleEmotionArcSkill` 的 `renderArcText` + `PresencePort`,据 idle 时长产出想念/重逢候选。
  - 提供 `combinedCandidateSource([...])` 合并多源候选(去空)。
- 决策 LLM 仍是唯一「是否值得说」裁决:候选只是**喂料**,schema 约束 + 概率闸 + 失败退 silent + 落 trace 全不变。restraint-first 不被削弱(候选多≠更爱说,决策闸照旧)。

## off 回归硬线

- 三处接缝全为**可选注入**;`assembleAutonomy` off 早退(`isAutonomyEnabled` false → undefined),三缝不构造。
- on 但不注入新端口:`preempt`/`voiceState`/`candidateSource` 均 undefined → 退回保守缺省 / 占位候选 / 仅记录,**与本 change 前逐字一致**。
- VoiceLoop 新增成员是纯加法只读 / 新方法,不改任何既有迁移、不改 `#onAudio` barge-in 路径 → 既有 runtime 测试不受影响。

## 测试(不触网,注入端口 + 假状态)

1. **VoiceLoop `isSpeaking`/`speakState`**:驱动到 speaking 态断言 `isSpeaking===true`,listening 态 false。
2. **`requestAutonomyPreempt` 真打断**:speaking 中调用 → 进 listening + emit `turn:interrupt(reason=autonomy_preempt)` + 半句写回;非 speaking 调用 → 返回 false、无副作用。
3. **attention 约束**:注入 focus attention,speaking 中 `requestAutonomyPreempt` 按 `evaluateAttention` 不打断(trueInterrupt=false);companion 则打断。
4. **缝 2**:arbiter 闭包读 `speakState()`→ isSpeaking=true 时高优先抢占、低优先 defer/drop。
5. **缝 3 候选源**:FakeOpenThreadPort/FakePresence → `combinedCandidateSource` 产真候选 → `AutonomyRunnerSkill.tick` 用真候选喂 FakeLlm。
6. **off 回归**:既有 voice-loop / autonomy / assembly-autonomy 测试全绿;`assembleAutonomy({})` 仍 undefined。
