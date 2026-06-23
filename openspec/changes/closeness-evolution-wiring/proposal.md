## Why

长期伴侣不会对刚认识的人和相处已久的人用同一种语气:关系会随积极互动慢慢变近(更暖、更愿意分享自己的事、用更亲昵的称呼),也会随长期缺席慢慢变淡。canonical §6.1b(2026-06-23 新加)给出**关系亲密度 closeness ∈ [0,1]**,每 person_id 一个,存在人物花名册的 `relationship_state`(JSON)里;演化两条:**积极互动缓升、长期缺席衰减**;作用:**喂 tone**(温暖度 / 自我披露深度 / 称呼亲昵度)。

当前 `packages/memory` 的人物花名册(`people.relationship_state`,schema v3 已建)只是空着的 JSON 列,**没有 closeness 演化逻辑**;persona 的 `renderToneFragment` 只读 PAD/旋钮生成语气,**不吃关系状态**;回合收尾 `finalizeTurn` 推进情绪/立场/记忆,**不更新 closeness**。本 change 把这条慢变量接线落地:**单一权威公式**(承 §5.5 同纪律,不引后台/读取两套漂移)做衰减与抬升,回合前读喂 tone、回合收尾按情绪正向程度缓升,全部参数外置(无 magic number)。

## What Changes

- **memory 增 closeness 演化 API + 单一权威公式**:`MemoryStore` 加 `getCloseness(personId)` / `getClosenessAt(personId, atMs)`(可注入时刻,确定性测试)/ `bumpCloseness(personId, valencePos, atMs)`。两实现(SQLite / InMemory)共用 `config.ts` 纯函数 `decayCloseness`(`c·0.5^(days/H)`,惰性实时算、**读不写回**)与 `bumpClosenessValue`(`c' = c + k·clamp(valence⁺,0,1)·(1−c)`,渐近饱和),杜绝两后端各写一遍漂移(§3.2)。
- **行为即配置**:`MemoryConfig` 增 `initialCloseness`(初值,默认 0.1 陌生起步)、`closenessHalfLifeDays`(衰减半衰期,默认 30)、`closenessUpK`(抬升系数,默认 0.1)、`closenessFloor`(下限,默认 0)。全部默认收敛在 `DEFAULT_MEMORY_CONFIG`,无散落 magic number。
- **closeness 喂 tone**:`renderToneFragment(pad, dials, closeness?)` 新增**可选** `closeness` 形参,按 `CLOSENESS` 三档阈值(外置)追加一行【关系】语气指令:亲近档→更暖/愿分享/更亲昵称呼;疏远档→礼貌克制/少自我披露;适中档不追加(省 token)。**省略 closeness 时逐字等于旧行为**(向后兼容)。persona `engine.tone(closeness?)` 透传(exactOptional 安全,条件展开)。
- **回合接线**:conversation.ts 回合前 `getCloseness(primaryPersonId)` → `persona.tone(closeness)` 渲染语气(纯读,不挡首字);`finalizeTurn` 在回复之后、非首字热路径按当轮情绪正向程度(`max(pad.pleasure, 0)`)调 `bumpCloseness`,失败不打断回合(§3.2)。

非破坏性:`relationship_state` 列 v3 已就位,closeness 作为其 JSON 子字段;旧库无记录的 person 在读取路径**惰性兜底**配置初值(无需 backfill、零数据丢失)。`renderToneFragment` / `engine.tone` 新增形参均可选,省略时旧消费者零改动。

## Capabilities

### New Capabilities
<!-- 无 -->

### Modified Capabilities
- `persistent-memory`:人物花名册 `relationship_state` 落地**关系亲密度 closeness 演化**——新增读(惰性衰减)/抬升(渐近饱和)API,单一权威公式,参数外置,旧库读取路径惰性兜底初值零数据丢失。
- `persona-emotion`:tone 生成读 closeness,按三档(外置阈值)调温暖度 / 自我披露深度 / 称呼亲昵度;closeness 单向影响表达,绝不反改 OCEAN/PAD;省略 closeness 时逐字等于旧行为。

## Impact

- **影响 canonical 章节**:§6.1b(关系亲密度 closeness 演化与喂 tone,新加)、§2.4(closeness→tone 单向映射)、§5.3b(人物花名册 relationship_state)、§5.5(衰减族单一权威公式同纪律:惰性、读不写回、不引两套漂移)、§3.2(数据迁移纪律 + 行为即配置:初值/半衰期/抬升系数/下限/阈值全外置)。与权威设计一致,无冲突。
- **代码**:
  - `packages/memory`:`config.ts`(4 个 closeness 参数 + `decayCloseness`/`bumpClosenessValue` 纯函数)、`types.ts`(`MemoryStore` 增 3 个方法签名)、`sqlite-store.ts`(`#readRel` 读 relationship_state JSON、`getClosenessAt`/`bumpCloseness` 实现,**只动 roster/relationship_state 读写,不碰 recall 主排序/联想扩散**)、`in-memory-store.ts`(同契约,内部 Map 镜像)。
  - `packages/persona`:`tone.ts`(`CLOSENESS` 阈值 + 三档文案 + `renderToneFragment` 可选形参)、`engine.ts`(`tone(closeness?)` 透传)。
  - `packages/runtime`:`conversation.ts`(回合前读 closeness 喂 tone;`primaryPersonId` 注入)、`turn-shared.ts`(`finalizeTurn` 最小接线,仅加一次 `bumpCloseness` 调用;**不碰 voice-loop.ts**)。
- **测试**:`packages/memory/test/contract.ts`(双实现共跑 golden:抬升渐近 + 惰性衰减 + valence≤0 不升 + 未知 person 不抛)、`packages/persona/test/tone.test.ts`(高→亲近/低→克制、省略=旧行为)、`packages/runtime/test/closeness-wiring.test.ts`(回合前喂 tone、收尾 bump 非阻塞)。
- **延迟预算**:回合前一次惰性读(单条 SQLite SELECT + JS 算);收尾抬升一次小幅 UPDATE,均无网络/LLM,且在首字之后,首字延迟零影响(§3.2 非阻塞)。
- **不涉及**:多人/声纹归属(P2,relationship_state 后续列已就位但不演化)、closeness 反向影响人格/情绪(明确单向)、recall 主排序与联想扩散(本 change 不动)、providers/observability/interaction/autonomy。
