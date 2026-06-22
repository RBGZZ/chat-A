## 1. 建包

- [x] 1.1 新建 `packages/persona`（`@chat-a/persona`）：package.json（type module、exports、typecheck）、tsconfig（继承 base）、`src/index.ts`；`pnpm install` 链入 workspace。

## 2. 数值内核（确定性 + golden test）

- [x] 2.1 定义类型:`Ocean`(五维)、`Pad`(P/A/D)、`PadPull`、`PersonaDials`(personality + emotion dials)、`PersonaSnapshot`(ocean + pad + turn)、`PersonaSeed`。
- [x] 2.2 实现 `oceanToPadBaseline(ocean, dials)`(Mehrabian 单一权威公式 + baseline_warmth 调制 Pleasure;钳制区间),纯函数。
- [x] 2.3 实现 `stepPad({pad, pull, baseline, dials, turn})`:spring `new=cur+0.3·pull−k·(cur−baseline)`,k 由 emotional_volatility 调制、pull 幅度由 emotional_intensity 调制、冷启动窗口内减半+加速回弹;钳制区间。
- [x] 2.4 golden test:OCEAN→PAD 恒定性 + 高宜人/外向抬升 Pleasure;spring 无 pull 收敛 / 正 pull 抬升;冷启动减半 / 窗口外恢复;baseline_warmth 抬升基线;volatility 改变回归速率。

## 3. 情绪 → tone 渲染

- [x] 3.1 实现 `padToEmotion(pad)`:固定 `PAD→离散情绪` 表(纯函数,小集合)。
- [x] 3.2 实现 `renderToneFragment(pad, dials)`:据离散情绪 + expressiveness/baseline_warmth 生成短 tone 文本;golden test(低 Pleasure 体现低落、与高 Pleasure 文本不同)。

## 4. Appraiser 接缝

- [x] 4.1 定义 `Appraiser` 接口;实现 P1 默认确定性 appraiser(外置最小 valence 词典 → 小幅 pull,无网络),标注为 LLM 版占位。
- [x] 4.2 测试:默认 appraiser 确定性产出 pull;可注入自定义 Appraiser 替换。

## 5. 持久化（复用 SQLite 真相源）

- [x] 5.1 `@chat-a/memory` schema v1→v2:新增 `kv_state` 表迁移（IF NOT EXISTS + 事务,保留既有记忆,`CURRENT_SCHEMA_VERSION=2`）。
- [x] 5.2 `@chat-a/memory` `MemoryStore` 增 `getState/setState`（内存实现 + SQLite 实现），扩契约测试（含跨重启 KV 恢复 + v1→v2 迁移保留数据）。
- [x] 5.3 `@chat-a/persona` 定义 `PersonaStore` + `InMemoryPersonaStore`;实现基于结构化 `KvLike={getState,setState}` 的 `createKvPersonaStore(kv)`（JSON 序列化 PersonaSnapshot）。
- [x] 5.4 测试:跨重启续接 PAD（非基线）;首启无状态用种子初始化（OCEAN=种子、PAD=基线）。

## 6. 种子 / 配置 / 骨架

- [x] 6.1 定义 `PersonaSeed` 加载（YAML/env 外置,可编辑）+ 默认种子（等价现 `XIAOXUE`,保证行为/测试不破）;dials 默认值集中,无 magic number。
- [x] 6.2 `@chat-a/cognition` `buildSystemPrompt` 改为接收 `PersonaSeed`（身份/背景/说话风格 → 静态骨架）;更新现有调用与测试。

## 7. 接线回合

- [x] 7.1 `packages/runtime` 依赖 `@chat-a/persona`;`Conversation` 注入 `PersonaSeed`/`Appraiser`/`PersonaStore`（默认内存 store + 默认种子,既有行为不破）。
- [x] 7.2 每轮流程:appraise → stepPad → save → renderTone;system 组装顺序「静态骨架 → 召回块 → tone fragment」。
- [x] 7.3 用户画像:启动时若提供画像且无对应记忆,写入 `subject=user` 种子记忆（经 MemoryStore）。
- [x] 7.4 测试:回合 system 含当轮 tone fragment;低 Pleasure 状态语气文本与高 Pleasure 不同（接缝级）。

## 8. 配置 / 客户端

- [x] 8.1 人格/情绪/角色种子 + appraiser 选择 + PersonaStore 后端走配置（env/YAML，默认保证既有 CLI/测试不破）。
- [x] 8.2 `packages/client` CLI 装配 persona（SQLite PersonaStore + 配置种子）;启动行显示人格/心情概要;手动验证:调高/调低 baseline_warmth 或 volatility,语气可感变化;重启后心情续接。

## 9. 收尾验证

- [x] 9.1 全量 `pnpm typecheck` + `pnpm test` 通过（含 persona golden/契约、memory v2 迁移、跨重启）。
- [x] 9.2 端到端冒烟:`start.bat` 走真实 DeepSeek,验证心情/旋钮影响语气 + 跨重启心情续接,无启动报错。
