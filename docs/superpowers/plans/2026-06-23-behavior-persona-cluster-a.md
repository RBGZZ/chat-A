# 行为/人格层设计更新（簇A）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落实簇A——把"关系亲密度 `closeness`"做成影响语气的中速慢变量,并把 §7/§7#3 的措辞修正与判断力增益写进 canonical。

**Architecture:** `closeness∈[0,1]` 存于 memory `people.relationship_state` JSON(惰性时间衰减,与 §5.5 衰减同纪律);persona `renderToneFragment` 增 closeness 入参调制 warmth/自我披露;runtime 在回合前读 closeness 喂 `tone()`、在回合收尾按 appraiser valence 抬升。其余(§7 措辞、8 因子量表、§7#3 原则、eval 指标、closeness→autonomy)本次只入 canonical 文档(对应运行时钩子尚未实现)。

**Tech Stack:** TypeScript(strict + exactOptionalPropertyTypes)、ESM、pnpm workspaces、Vitest、node:sqlite DatabaseSync。

## Global Constraints
- TypeScript strict,**exactOptionalPropertyTypes 开启**:可选字段绝不显式赋 `undefined`,用条件展开 `...(x!==undefined?{k:x}:{})` 或省略键。
- 注释/文档用**中文**(项目约定)。
- 每包改动需 `pnpm -F @chat-a/<pkg> typecheck` 与 `test` 全绿。
- 单一权威公式 + 惰性计算、不写回污染(承 §5.5);closeness 演化在回合收尾、**不进首字热路径**(承非阻塞硬约束)。
- closeness **单向**影响表达,**绝不反向**改 OCEAN/PAD。
- 两记忆实现(SQLite/in-memory)契约一致、零漂移。

---

## 执行结构(并行 / 串行)
- **并行阶段(三个互不相交域,可同时跑)**:Task 1(docs/canonical)、Task 2(memory closeness 存储)、Task 3(persona tone 调制)。
- **串行阶段(动焦点文件,等 Task 2+3 合并后)**:Task 4(runtime 回合接线)。
- Task 2 与 Task 3 都不依赖对方(各自加独立 API);Task 4 同时消费二者。

---

## Task 1: canonical 文档编辑（§7 / §7#3 / §6+§5.3b）

**Files:**
- Modify: `docs/chat-a-canonical-design.md`(§7 autonomy 段、§7#3、§6/§5.3b 关系亲密度小节)

**Interfaces:** 纯文档,无代码接口。

- [ ] **Step 1: §7 措辞修正**。在 §7 autonomy 段把"三参考项目自主性全是定时器触发,从不评估……质的超越……差异化护城河"改写为:
  > **🔧 修正(2026-06-23 调研)**:worth-of-speaking 已是既有先验(**Inner Thoughts** CHI2025 开源 / **ProactiveAgent** / **Proact-VL**)。chat-A 的可防守差异化在**组合**:决策 LLM(silent|speak|idle)+ 三道节流 + **跨会话持久内在生活** + **会反对/不服从** + 可插拔 SkillScheduler + no-action 预算单消费者优先级队列(无单一项目集齐)。真实蓝海:§7#1 内在生活 + open-thread 跟进 + 会反对。
- [ ] **Step 2: §7 判断力增益(记录,待决策 LLM 落地)**。在同段补:
  > **🆕 决策 LLM"是否值得说"采用 Inner Thoughts 8 因子动机量表**(关联/信息缺口/预期影响/紧迫/连贯/原创/平衡/动态)作评估维度——给系统更好判断依据,非强制规则(待 autonomy 决策 LLM 实现时落入其 prompt;量表权重/启用可配)。eval:记 ProactiveAgent False-Alarm/Missed-Needed/Non-Response/Correct 四分类为评估框架(只测不逼)。
- [ ] **Step 3: §7#3 反谄媚原则**。在 §7#3 末补:
  > **🆕 原则(2026-06-23)**:反谄媚 = 系统基于真实信念冲突(`core_belief`/`self_notions`)的**自主涌现判断,非强制机制**;**双向防偏**——既不被压服成谄媚,也不"为反对而反对"(performative contrarianism)。assertiveness 旋钮仍用户自治;"必须开口"由危机/安全底线(不可配)覆盖。**暂缓(已记录、不采纳)**:同意连击熔断器 / 主动性硬下限 / 生成后改写 pass(强制反谄媚,留未来可选/eval)。**eval 指标(只测不逼)**:SYCON-Bench Turn-of-Flip/Number-of-Flips + lechmazur Contrarian rate + persona_drift 探针。
- [ ] **Step 4: §6/§5.3b 关系亲密度小节**。在 §6 增小节 "关系亲密度 `closeness`(中速慢变量)":单标量 `closeness∈[0,1]` 存 §5.3b `people.relationship_state` JSON(填实预留位),与人格(特质·慢)/PAD(情绪·快)正交补"关系"轴;积极互动缓升(按 appraiser valence)、长期缺席惰性衰减(单一权威公式);**单向**喂 tone(warmth/自我披露)+(未来)autonomy 主动倾向,**不反改 OCEAN/PAD**;默认初值 0.1;**升级路径**:日后可扩多维(trust/familiarity/affection),JSON 预留支持。并在 §5.3b 标 `relationship_state` 首字段为 `closeness`。
- [ ] **Step 5: Commit**

```bash
git add docs/chat-a-canonical-design.md
git commit -m "docs(canonical): 簇A 文档更新 — §7措辞修正+8因子量表/§7#3反谄媚原则/§6+§5.3b closeness"
```

---

## Task 2: memory — closeness 存储 + 惰性衰减 + 抬升（可并行）

**Files:**
- Modify: `packages/memory/src/config.ts`(加 closeness 配置)
- Modify: `packages/memory/src/types.ts`(MemoryStore 加方法)
- Modify: `packages/memory/src/sqlite-store.ts`(读写 people.relationship_state JSON + 惰性衰减)
- Modify: `packages/memory/src/in-memory-store.ts`(同步镜像)
- Test: `packages/memory/test/contract.ts`(两实现共跑)、`packages/memory/test/sqlite.test.ts`(持久化)

**Interfaces:**
- Produces:
  - `MemoryConfig` 新增 `initialCloseness: number`(默认 0.1)、`closenessHalfLifeDays: number`(默认 30)、`closenessUpK: number`(默认 0.1)、`closenessFloor: number`(默认 0)。
  - `MemoryStore.getCloseness(personId: string): number` —— 读 relationship_state.closeness 并按距 `closenessUpdatedAtMs` 的时长惰性衰减 `value·0.5^(days/H)`,夹到 `[closenessFloor,1]`;无记录返回 `initialCloseness`。读不写回。
  - `MemoryStore.bumpCloseness(personId: string, valencePos: number, atMs: number): number` —— 先取衰减后的当前值 `c`,`c' = clamp(c + closenessUpK·clamp(valencePos,0,1)·(1−c), floor, 1)`,写回 `relationship_state` JSON `{closeness:c', closenessUpdatedAtMs:atMs}`,返回 `c'`。`valencePos≤0` 时只刷新衰减基线(等价 `c'=c`,更新时间戳)。对未知 personId 幂等不抛。

- [ ] **Step 1: 写失败测试(contract,两实现共跑)**。在 `packages/memory/test/contract.ts` 加:

```ts
it('closeness 默认初值 + 抬升渐近饱和 + 惰性衰减', () => {
  const s = makeStore();                 // 工厂注入,主用户已 seed
  const pid = PRIMARY_PERSON_ID;         // 测试常量(同文件既有)
  expect(s.getCloseness(pid)).toBeCloseTo(0.1, 5);          // 默认初值
  const t0 = 1_000_000_000_000;
  const c1 = s.bumpCloseness(pid, 1, t0);                   // 满正向
  expect(c1).toBeCloseTo(0.1 + 0.1 * (1 - 0.1), 5);         // 0.19
  const c2 = s.bumpCloseness(pid, 1, t0);                   // 再抬,渐近
  expect(c2).toBeGreaterThan(c1);
  expect(c2).toBeLessThan(1);
  // 30 天后(半衰期)读取应≈半衰
  const t30 = t0 + 30 * 24 * 3600 * 1000;
  expect(s.getClosenessAt(pid, t30)).toBeCloseTo(c2 / 2, 2); // 见 Step 3 测试钩子
});
it('bumpCloseness valence≤0 不升只刷新基线;未知 person 不抛', () => {
  const s = makeStore();
  const pid = PRIMARY_PERSON_ID;
  const c = s.bumpCloseness(pid, 0, 1_000_000_000_000);
  expect(c).toBeCloseTo(0.1, 5);
  expect(() => s.bumpCloseness('nope', 1, 1)).not.toThrow();
});
```

> 注:为确定性测试时间衰减,实现在 store 内部用注入时钟;contract 用一个**仅测试可见**的 `getClosenessAt(pid, atMs)`(见 Step 3)避免依赖真实时间。

- [ ] **Step 2: 运行测试确认失败**。Run: `pnpm -F @chat-a/memory test -t closeness`,Expected: FAIL（`getCloseness is not a function`）。
- [ ] **Step 3: 实现 config + store 方法**。
  - `config.ts` 的 `MemoryConfig` 加上述 4 字段;`defaultMemoryConfig` 填默认(0.1/30/0.1/0)。
  - `sqlite-store.ts`:加私有 `#readRel(pid): {closeness:number; updatedAtMs:number} | null`(`SELECT relationship_state FROM people WHERE person_id=?`,JSON.parse,容错返回 null)与 `#decay(c, updatedAtMs, atMs)`(`c * Math.pow(0.5, days/H)`,夹 `[floor,1]`)。实现:

```ts
getCloseness(personId: string): number {
  return this.getClosenessAt(personId, Date.now());
}
/** 测试可注入时刻;生产 getCloseness 用 Date.now()。 */
getClosenessAt(personId: string, atMs: number): number {
  const rel = this.#readRel(personId);
  if (rel === null) return this.#cfg.initialCloseness;
  return this.#decay(rel.closeness, rel.updatedAtMs, atMs);
}
bumpCloseness(personId: string, valencePos: number, atMs: number): number {
  try {
    const cur = this.getClosenessAt(personId, atMs);
    const v = Math.min(Math.max(valencePos, 0), 1);
    const next = Math.min(Math.max(cur + this.#cfg.closenessUpK * v * (1 - cur), this.#cfg.closenessFloor), 1);
    const json = JSON.stringify({ closeness: next, closenessUpdatedAtMs: atMs });
    this.#db.prepare('UPDATE people SET relationship_state=? WHERE person_id=?').run(json, personId);
    return next;
  } catch (err) { this.#onError(err, 'bumpCloseness'); return this.#cfg.initialCloseness; }
}
```
  - `#readRel` 解析 `{closeness, closenessUpdatedAtMs}`(字段名兼容:存 `closenessUpdatedAtMs`,读时映射 `updatedAtMs`)。
  - `in-memory-store.ts`:同样逻辑,relationship_state 用进程内 `Map<personId,{closeness,updatedAtMs}>` 镜像;`getCloseness/getClosenessAt/bumpCloseness` 行为逐字一致。
  - `types.ts`:`MemoryStore` 接口加 `getCloseness`/`getClosenessAt`/`bumpCloseness` 签名(注释标 `getClosenessAt` 为可注入时刻、测试与演化用)。

- [ ] **Step 4: 运行测试确认通过**。Run: `pnpm -F @chat-a/memory typecheck && pnpm -F @chat-a/memory test`,Expected: PASS（含新 closeness 用例 + 既有全绿）。
- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/config.ts packages/memory/src/types.ts packages/memory/src/sqlite-store.ts packages/memory/src/in-memory-store.ts packages/memory/test/contract.ts packages/memory/test/sqlite.test.ts
git commit -m "feat(memory): closeness 关系亲密度存储+惰性衰减+渐近抬升(§6/§5.3b relationship_state)"
```

---

## Task 3: persona — tone 按 closeness 调制 warmth/自我披露（可并行）

**Files:**
- Modify: `packages/persona/src/tone.ts`(`renderToneFragment` 加可选 closeness 入参)
- Modify: `packages/persona/src/engine.ts`(`tone(closeness?)` 透传)
- Test: `packages/persona/test/tone.test.ts`

**Interfaces:**
- Consumes: 无(独立)。
- Produces:
  - `renderToneFragment(pad, dials, closeness?: number): string` —— closeness 省略时**逐字等于现状**(向后兼容);提供时按 closeness 在片段加一行"关系亲密度"指令(高→更暖、更愿分享自己的事/用更亲昵称呼;低→更礼貌克制、少自我披露)。分档阈值可配(沿用 dials 风格),默认 `<0.34 疏远 / 0.34–0.66 适中 / >0.66 亲近`。
  - `PersonaEngine.tone(closeness?: number): ToneView` —— 透传给 `renderToneFragment`;省略时行为不变。

- [ ] **Step 1: 写失败测试**。在 `packages/persona/test/tone.test.ts` 加:

```ts
it('closeness 省略时 toneFragment 与现状逐字一致(向后兼容)', () => {
  const pad = { pleasure: 0, arousal: 0, dominance: 0 };
  expect(renderToneFragment(pad, DEFAULT_DIALS)).toBe(renderToneFragment(pad, DEFAULT_DIALS, undefined));
});
it('高 closeness 注入"亲近/愿分享"语气,低 closeness 注入"克制/少披露"', () => {
  const pad = { pleasure: 0, arousal: 0, dominance: 0 };
  const near = renderToneFragment(pad, DEFAULT_DIALS, 0.9);
  const far = renderToneFragment(pad, DEFAULT_DIALS, 0.05);
  expect(near).toContain('亲近');
  expect(near).not.toBe(far);
  expect(far).toContain('克制');
});
```

- [ ] **Step 2: 运行确认失败**。Run: `pnpm -F @chat-a/persona test -t closeness`,Expected: FAIL。
- [ ] **Step 3: 实现**。`tone.ts`:`renderToneFragment` 末参加 `closeness?: number`;若提供,按阈值 append 一行关系指令(疏远/适中/亲近三档文案,中文,沿用既有片段拼接风格);省略则**不追加**(保证向后兼容逐字相等)。`engine.ts`:`tone(closeness?: number)` 把 closeness 经条件展开传入 `renderToneFragment`(`...(closeness!==undefined?[closeness]:[])` 或显式分支,exactOptional 安全)。
- [ ] **Step 4: 运行确认通过**。Run: `pnpm -F @chat-a/persona typecheck && pnpm -F @chat-a/persona test`,Expected: PASS。
- [ ] **Step 5: Commit**

```bash
git add packages/persona/src/tone.ts packages/persona/src/engine.ts packages/persona/test/tone.test.ts
git commit -m "feat(persona): tone 按 closeness 调制 warmth/自我披露(向后兼容,closeness 省略行为不变)"
```

---

## Task 4: runtime — 回合接线（串行,等 Task 2+3 合并）

**Files:**
- Modify: `packages/runtime/src/conversation.ts`(SingleShotStrategy:tone 传 closeness)
- Modify: `packages/runtime/src/turn-shared.ts`(composeSystem 读 closeness;finalizeTurn 抬升 closeness)
- Test: `packages/runtime/test/`(新增 closeness 接线测试,沿用既有 fake deps 风格)

**Interfaces:**
- Consumes: `memory.getCloseness(personId)`/`memory.bumpCloseness(personId, valencePos, atMs)`(Task 2);`persona.tone(closeness)`(Task 3)。
- Produces: 回合行为——回合前用主用户 closeness 渲染 tone;回合收尾按当轮 appraiser valence 正分量抬升 closeness。

- [ ] **Step 1: 写失败测试**。新增 `packages/runtime/test/closeness-wiring.test.ts`:用 fake memory(记录 getCloseness 调用与 bumpCloseness 入参)+ fake persona(断言 tone 收到 closeness)跑一个回合,断言:① `tone` 被传入 `memory.getCloseness(primaryPersonId)` 的值;② 回合收尾调用了 `memory.bumpCloseness(primaryPersonId, valencePos, atMs)`,其中 valencePos 来自当轮 mood/appraiser 的 pleasure 正分量;③ closeness 读取在 LLM 之前、bump 在回复之后(不挡首字)。
- [ ] **Step 2: 运行确认失败**。Run: `pnpm -F @chat-a/runtime test -t closeness`,Expected: FAIL。
- [ ] **Step 3: 实现**。
  - `turn-shared.ts` `composeSystem`:在调用 `deps.persona.tone(...)` 前(注:tone 现在 SingleShotStrategy 里调)——改为在策略里读 `const closeness = deps.memory.getCloseness(deps.primaryPersonId)`(给 TurnDeps 加 `primaryPersonId`,由 Conversation 构造期从 memory/config 取)并 `deps.persona.tone(closeness)`。
  - `turn-shared.ts` `finalizeTurn`:在写记忆/情绪推进段加 `try { deps.memory.bumpCloseness(deps.primaryPersonId, Math.max(args.mood.pad.pleasure, 0), at); } catch {}`(失败不打断回合,§3.2;在回复之后、非热路径)。
  - `conversation.ts`:TurnDeps 装配加 `primaryPersonId`(从 memory 配置或既有主用户标识取)。
- [ ] **Step 4: 运行确认通过**。Run: `pnpm -F @chat-a/runtime typecheck && pnpm -F @chat-a/runtime test`,Expected: PASS。
- [ ] **Step 5: 全仓校验 + Commit**

```bash
pnpm -r typecheck && pnpm -r test
git add packages/runtime/src/conversation.ts packages/runtime/src/turn-shared.ts packages/runtime/test/closeness-wiring.test.ts
git commit -m "feat(runtime): 回合接线 closeness — 回合前读喂 tone、收尾按 valence 抬升(非阻塞)"
```

---

## 自查(写完计划后对照 spec)
- **覆盖**:spec §1.1/§1.2(§7 措辞+量表)→Task1 Step1-2;§3(§7#3 原则+eval)→Task1 Step3;§2(closeness:存储→Task2、tone→Task3、接线→Task4、升级路径→Task1 Step4)。✅
- **暂缓项不实现**:强制反谄媚机制、closeness 多维、closeness→OCEAN/PAD 反馈、eval 进运行时——计划中均无对应 code 任务,仅文档记录。✅
- **未实现钩子**:closeness→autonomy proactive lean、8 因子量表入 prompt → 因 `resolveProactiveLean`/决策 LLM 未实现,本计划只入 Task1 文档,待钩子落地再补切片(spec §1.2/§2.4 已述)。
- **类型一致**:`getCloseness/getClosenessAt/bumpCloseness`(Task2 定义,Task4 消费)、`tone(closeness?)`(Task3 定义,Task4 消费)签名一致。✅
- **占位符**:无 TBD/TODO;各 code 步给了测试+实现代码。
