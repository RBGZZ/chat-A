## Context

动机与需求见 `proposal.md` 与 `specs/persistent-memory/spec.md`。当前 `Conversation`（`packages/runtime`）直接依赖 cognition 的 `ConversationMemory`——一个进程内滑窗，重启即失忆。canonical §5/§9 P1 要求 SQLite 作记忆真相源 + 关键词召回 + ADD 写路径；§8.1 进一步要求 SQLite 是后续决策 trace/可重放的同一真相源。

约束（承 §3.1/§3.2）：跨模块只依赖类型化接口；确定性内核写 golden test；记忆不进 B 层实时帧管线热路径；行为参数全外置；schema 带版本 + 迁移、绝不丢记忆；树莓派友好（尽量零原生编译）。

## Goals / Non-Goals

**Goals:**
- 定义 `MemoryStore` 接缝，内存实现与 SQLite 实现满足同一契约、可互换（§3.1）。
- `SqliteMemoryStore` 以单文件 SQLite 为真相源，进程重启后记忆完整恢复。
- 写路径 ADD + 去重（§5.8 子集）；关键词召回（P1 关键词级）。
- schema 版本化 + 迁移骨架，迁移不丢记忆；未知更高版本明确报错。
- 记忆故障优雅降级（空召回继续回合），不进语音热路径。

**Non-Goals:**（详见 proposal Non-goals）
- 向量/语义检索、混合召回打分归一、情感共振（P2）。
- Redis 工作层、巩固流水线、离线双 Pass 调和 update/delete（P2/后续）。
- 三层认知记忆完整分层 + 统一衰减公式（本次仅最小记忆模型）。
- 决策 trace 落库 / 可重放（§8.1，本次只让 SQLite 真相源就位）。
- LLM 记忆抽取/蒸馏（记忆条目来源）——接缝只提供 add/recall，抽取器接线属后续。

## Decisions

### D1. SQLite 驱动 = `node:sqlite`（内置），`better-sqlite3` 为成熟备选
- **选择**：Node 24 内置的 `node:sqlite`（`DatabaseSync`，同步 API）。
- **为何**：零额外依赖、**零原生编译**（随 Node 分发）——对树莓派/跨平台是最大优势；同步 API 契合"本地毫秒级读"；与"SQLite 真相源"定位一致。
- **备选**：`better-sqlite3`（成熟、FTS5/扩展齐全），但需原生预编译二进制，ARM/树莓派 prebuild 不总齐。
- **风险兜底**：`node:sqlite` 仍是实验级（API 可能变 + 导入有 ExperimentalWarning）。由 D2 的接缝隔离——**只有 `SqliteMemoryStore` 触碰驱动**，换 `better-sqlite3` 仅改一处。tasks 第一步**先验证** `node:sqlite` 在本机 Node 24.16 可不带 flag 工作；不行则即切 `better-sqlite3`（接口不变）。

### D2. 新增 `packages/memory`（`@chat-a/memory`）承载接缝与实现
- `@chat-a/memory` 导出：`MemoryStore` 接口 + 记忆类型（`MemoryRecord` / `ChatMessage` 复用 protocol）+ `InMemoryMemoryStore` + `SqliteMemoryStore` + 记忆配置。
- runtime 的 `Conversation` 改为依赖 `MemoryStore` 接口（构造注入）；cognition 现有 `ConversationMemory` 迁移为 `@chat-a/memory` 的 `InMemoryMemoryStore`（滑窗实现），消除重复。
- **为何独立包**：记忆是清晰接缝（§3.1），未来要支持"模块级重写"（向量/三层记忆）；独立包让 runtime/cognition 只依赖接口、爆炸半径可控。

### D3. `MemoryStore` 接口（最小但可演进）
```
interface MemoryStore {
  // 写对话日志(快照来源)
  appendMessage(msg: StoredMessage): void
  // 取最近 N 条消息(滑窗快照,跨会话恢复连续性)
  snapshot(limit?: number): readonly ChatMessage[]
  // ADD 一条记忆条目(带去重)
  addMemory(rec: MemoryInput): void
  // 关键词召回
  recall(query: string, limit?: number): readonly MemoryRecord[]
  close(): void
}
```
- 同步签名（SQLite 同步驱动 + 内存实现皆天然同步；不引入无谓 async/延迟）。
- 现有 `Conversation` 用 `memory.snapshot()` 不变语义；新增 `recall()` 注入召回上下文。

### D4. 数据模型（schema v1）
- `memory_meta(key TEXT PRIMARY KEY, value TEXT)` —— 存 `schema_version` 等。
- `messages(id INTEGER PK, session_id, turn_id, role, content, created_at, correlation_id)` —— 对话日志；`snapshot` 读最近 N（按 `id` 倒序再正序）。
- `memories(id INTEGER PK, text, normalized_text TEXT UNIQUE, kind, created_at, last_seen_at, hits, source_session)` —— 记忆条目；**去重靠 `normalized_text` 唯一约束**（`INSERT ... ON CONFLICT(normalized_text) DO UPDATE SET hits=hits+1, last_seen_at=...`），重复只增计数不增行、绝不丢原记忆。
- `PRAGMA journal_mode=WAL`（崩溃安全 + 读写并发）。

### D5. 关键词召回 = 确定性 token/LIKE 匹配（P1），FTS5 留 P2
- P1 召回：查询分词后对 `memories.text` 做规范化包含匹配（`LIKE`/token 命中），按 `last_seen_at`/`hits` 排序取前 N。
- **为何不用 FTS5**：P1 只需"命中关键词即可召回"，LIKE/token 完全确定、可写 golden test、不依赖 SQLite 编译选项；FTS5 + BM25 + 语义混合属 §5.5 P2 的 hybrid recall，届时一并上。
- 排序、上限、分词规则全走配置（§3.2 行为即配置）。

### D6. 迁移：版本号 + 顺序迁移 + 事务
- 代码持有 `CURRENT_SCHEMA_VERSION` 与按版本递增的迁移步骤数组。
- 打开库：读 `memory_meta.schema_version`（无则视为 0/新库）→ 若 `< CURRENT` 在**单事务**内逐步迁移并保留数据 → 若 `> CURRENT` **抛明确错误**（不写不坏库）。
- 承 §3.2 数据迁移纪律：每次 schema 变更新增一个迁移步骤，绝不就地破坏。

### D7. 优雅降级 + 延迟
- `recall`/`snapshot` 读失败 → 捕获并返回空 + 记录错误（§8.1 三层日志的 error 层），回合以空上下文继续（§3.2）。
- 写入（`appendMessage`/`addMemory`）在**回合收尾**做，不阻塞流式首字；失败只记录不抛进回合。
- 记忆读写位于回合编排层（runtime `Conversation`），**不进 B 层帧管线**——对语音首字延迟无影响（§3.2 延迟预算）。

## Risks / Trade-offs

- **`node:sqlite` 实验状态** → 由 D1/D2 接缝隔离 + tasks 首步验证 + `better-sqlite3` 备选；锁 Node 版本。
- **LIKE 召回的召回率/性能有限**（大数据量全表扫描）→ P1 数据量小可接受；P2 上 FTS5+ANN（canonical §5.8 待决项已列）。给 `memories` 必要索引（`last_seen_at`），并对召回结果数设上限。
- **去重靠 `normalized_text` 唯一约束的"等价"判定较粗**（仅规范化文本相等）→ P1 足够；语义级去重属 P2 巩固。规范化规则外置，便于演进。
- **记忆条目来源未接线**（本次不做 LLM 抽取）→ 接缝先就位，wiring 抽取器作为后续小步；本次可先持久化对话消息保证"重启记得"，`addMemory` 由后续接入。
- **WAL 在某些文件系统/网络盘行为异常** → 默认本地路径；异常时可配置回退 `journal_mode`。

## Migration Plan

1. 新增 `@chat-a/memory`，不动现有行为（runtime 仍可用内存实现，默认不变）。
2. `Conversation` 接口化依赖 `MemoryStore`；`ConversationMemory` 迁移为 `InMemoryMemoryStore`，cognition 侧改为再导出或移除（保持对外构造兼容）。
3. 配置开关选择内存 vs SQLite 实现（行为即配置）；默认值保证既有测试/CLI 不破。
4. 回滚：实现选择是配置项，回退到内存实现即恢复原行为；SQLite 文件独立、删除不影响代码路径。

## Open Questions

- `node:sqlite` 在本机 Node 24.16 是否需 `--experimental-sqlite` flag / 警告是否可接受（tasks 首步验证后定 D1 是否切备选）。
- 记忆条目来源：本次是否顺带把"每条用户消息入 `memories`"作为最朴素来源，还是仅持久化 `messages`、`addMemory` 留空待抽取器（倾向后者：先保证重启连续性，抽取分步做）。
- 记忆 DB 默认路径与多实例（PC vs 树莓派）路径约定。
