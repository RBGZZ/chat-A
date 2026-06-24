## Why

文字版 MVP 的 `cli.ts` 已能装配真 LLM/记忆/人格/动作并流式对话,但作为**给人用的终端前端**还差临门一脚:

- **启动即可用**:`pnpm dev` 不读 `.env.local`(只有 `start.bat` 读),非 Windows / 不走 bat 的用户拿不到 key,直接掉进 FakeLLM,体验割裂。
- **横幅是给开发者看的**:十余行 env 状态平铺,新用户看不懂"现在能不能聊、怎么聊、有哪些命令"。
- **没有命令**:想退出只能 Ctrl+C;想清屏、看人格/情绪、清空当前上下文都没有入口。`/help` 缺位。
- **健壮性边角**:Ctrl+C 已能退(readline 关闭),但收尾(sleep/关库/沉淀)走 EOF 才触发;空输入已忽略;LLM 出错已有兜底但提示偏开发者口吻。

本 change 把 `cli.ts` 打磨成"开箱即用、好用、不崩"的交互式 CLI 前端:加载 `.env.local`、友好横幅、最小够用的斜杠命令、Ctrl+C 优雅退出、对话出错的友好中文降级。**所有可单测的纯逻辑(命令解析、.env 解析、横幅渲染)抽成纯函数 + 单测**;交互/装配的副作用层保持薄壳。**不碰** runtime/providers/memory/persona/observability/interaction 实现,也**不改** `cli-voice.ts` 语音逻辑——仅复用其公共接口。

## What Changes

- **加载 `.env.local`(纯函数解析 + 薄壳应用)**:新增 `packages/client/src/env-file.ts`,`parseDotEnv(text)` 把 `KEY=VALUE`/`#注释`/空行解析成键值对(纯函数,可单测,对齐 `start.bat` 的语义:`eol=#`、`tokens=1,*`、不覆盖已存在的真实环境变量)。`cli.ts` 启动时从项目根读 `.env.local`(存在才读,缺省静默),把不在 `process.env` 的键注入——让 `pnpm dev` 与 `start.bat` 行为一致。
- **斜杠命令(纯函数解析 + 薄壳分发)**:新增 `packages/client/src/commands.ts`,`parseCommand(line)` 把一行输入解析为 `{ kind: 'chat'|'help'|'quit'|'clear'|'persona'|'reset'|'unknown', ... }`(纯函数,可单测)。支持 `/help`、`/quit`、`/exit`(=quit)、`/clear`、`/persona`、`/reset`;非斜杠 = 普通对话;未知 `/xxx` = 友好提示而非当对话发给 LLM。命令文案渲染(help 文本、persona 摘要)也做成纯函数。
- **友好横幅(纯函数渲染)**:新增 `renderBanner(info)` 纯函数,把"小雪 + provider/model + 记忆后端 + 人格/情绪旋钮 + 可用命令提示"渲染成简洁、面向用户的多行字符串(FakeLLM 时给出"如何配真模型"的引导)。`cli.ts` 收集 `info` 后调用它打印。开发者向的详尽 env 状态降级为可选(默认精简,保留关键项)。
- **Ctrl+C 优雅退出**:`SIGINT` 监听 → 打印一行告别 → 走与 EOF 相同的收尾(停语音/沉淀/关库)→ 退出,不抛栈。
- **对话降级文案友好化**:LLM/网络出错时打印**友好中文**(§3.2 永不崩永不哑),而非裸 `[出错: ...]`。
- **README + 脚本说明**:新增项目根 `README.md`"如何运行"(`pnpm dev` / `start.bat` / `.env.local` 示例 / 切 Qwen 的 env / 斜杠命令一览 / `--voice` 一句话)。

不破坏:`--voice` / `CHAT_A_VOICE=1` 语音分发原样保留;现有 `audio`/`cli-voice` 测试不受影响。

## Capabilities

### New Capabilities
- `interactive-cli-frontend`: 面向用户的交互式终端前端(§9 瘦客户端文字形态)——启动加载 `.env.local`、友好横幅、斜杠命令解析与分发、Ctrl+C/EOF/`quit` 统一优雅收尾、对话出错友好降级。纯逻辑(.env 解析 / 命令解析 / 横幅渲染)以单测固化;交互/装配为薄壳,复用既有 runtime/memory/persona/providers 能力,不引入新领域能力。

### Modified Capabilities
<!-- 无:不改任何已建能力的契约,仅在 client 壳层增加交互/装配行为。 -->

## Impact

- **代码**:仅 `packages/client/**`——新增 `src/env-file.ts`、`src/commands.ts`(纯逻辑 + 渲染),改 `src/cli.ts`(薄壳:加载 .env、调用渲染、命令分发、SIGINT 收尾);新增 `test/env-file.test.ts`、`test/commands.test.ts`。根 `README.md` 新增。根 `package.json` 已有 `dev`/`start`,无需改(README 说明即可)。
- **不涉及**:runtime/providers/memory/persona/observability/interaction 实现(只用公共接口);`cli-voice.ts` 语音逻辑;任何 schema/数据迁移。
- **canonical 章节**:§9(瘦客户端文字形态)、§3.2(永不崩永不哑 + 行为即配置:命令/横幅/路径全无 magic number 硬塞)。与权威设计一致,无冲突。
- **延迟预算**:启动期一次性同步读小文件 + 字符串渲染,可忽略;对话路径不变(仍直透 `convo.send` 流式)。
