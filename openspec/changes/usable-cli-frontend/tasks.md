## 1. .env.local 加载(纯函数解析 + 薄壳应用，§3.2 行为即配置）

- [x] 1.1 新增 `packages/client/src/env-file.ts`：`parseDotEnv(text: string): Record<string,string>` 纯函数——逐行 `KEY=VALUE`,`#` 开头(含 `eol=#`)与空行跳过,只切第一个 `=`(`tokens=1,*`),key/value 去首尾空白,去掉 value 两侧成对引号;对齐 `start.bat` 语义
- [x] 1.2 `env-file.ts` 增 `applyDotEnv(parsed, env)` 薄壳:仅当 `env[key]` 未定义/空时注入(真实环境变量优先,不覆盖)
- [x] 1.3 TDD:`test/env-file.test.ts` 覆盖 KEY=VALUE、注释行、空行、含 `=` 的 value、带引号 value、不覆盖已存在 env（先写测试后实现）

## 2. 斜杠命令解析（纯函数，§3.2）

- [x] 2.1 新增 `packages/client/src/commands.ts`：`parseCommand(line): ParsedCommand`——`trim` 后空 → `{kind:'empty'}`;不以 `/` 开头 → `{kind:'chat', text}`;`/help`、`/quit`、`/exit`(→quit)、`/clear`、`/persona`、`/reset` 各自 kind;其它 `/xxx` → `{kind:'unknown', name}`(大小写不敏感)
- [x] 2.2 `commands.ts` 增 `renderHelp(): string`(命令一览中文文案)与 `renderPersona(info): string`(人格名/身份/暖·外显·波动·敢顶嘴旋钮/当前情绪 PAD 摘要)纯函数
- [x] 2.3 TDD:`test/commands.test.ts` 覆盖各 kind、别名 `/exit`、大小写、未知命令、普通对话、空行、`/` 前后空白；渲染函数含关键字段（先写测试后实现）

## 3. 友好横幅渲染（纯函数，§9/§3.2）

- [x] 3.1 `commands.ts`(或同文件)增 `renderBanner(info): string` 纯函数:小雪 + provider/model + 记忆后端 + 人格/情绪旋钮 + 「输入 /help 看命令」提示;`provider==='fake'` 追加"如何配真模型(.env.local / Qwen)"引导
- [x] 3.2 TDD:横幅渲染单测——含 provider/model/记忆/人格名/「/help」;fake 分支含引导文案；真 provider 分支不含引导（先写测试后实现）

## 4. cli.ts 薄壳改造（不改装配语义，只改交互层）

- [x] 4.1 启动最前面:读项目根 `.env.local`(存在才读,读失败静默不崩),`applyDotEnv` 后再 `loadLlmConfig()`/`loadPersonaFromEnv()`(确保 key 生效);路径用 `process.cwd()` 根（与 start.bat 一致）
- [x] 4.2 用 `renderBanner` 替换平铺横幅打印;保留语音状态行与 fake 提示(并入横幅或紧随其后);开发者向详尽 env 状态保留为精简关键项
- [x] 4.3 REPL 循环改为先 `parseCommand`:`empty`→重提示;`chat`→`convo.send` 流式(出错走友好中文降级);`help`/`persona`→打印渲染文本;`clear`→清屏;`reset`→新 sessionId + 友好提示;`quit`→关闭 readline 走收尾;`unknown`→友好提示「未知命令,/help 查看」
- [x] 4.4 `SIGINT`(Ctrl+C)监听:打印告别 → 触发与 EOF 相同收尾(voice.stop / reflect / 关库 / telemetry.shutdown) → `process.exit(0)`,不抛栈;避免重复收尾(幂等守卫)
- [x] 4.5 对话出错降级文案改为友好中文(§3.2 永不崩永不哑),不再裸打印 `[出错: ...]`
- [x] 4.6 `--voice`/`CHAT_A_VOICE=1` 分发与 `cli-voice` 调用原样保留;`/reset` 仅影响文字会话上下文

## 5. README + 运行说明

- [x] 5.1 新增项目根 `README.md`:如何运行(`pnpm dev` / `start.bat` / `.env.local` 一行 key 示例)、切 Qwen 的 env 示例、斜杠命令一览、`--voice` 一句话、FakeLLM 兜底说明

## 6. 收尾与验证

- [x] 6.1 worktree 根 `pnpm -r typecheck` 全绿
- [x] 6.2 worktree 根 `npx vitest run` 全绿（新增 env-file/commands 单测 + 既有 audio/cli-voice 测试不破坏）
- [x] 6.3 非交互冒烟:`printf '你好\n/help\n/persona\n/quit\n' | npx tsx packages/client/src/cli.ts`(env 走 fake,不触网)能启动→响应→退出、不抛异常;贴输出
- [x] 6.4 自检:仅改 `packages/client/**` 与根 README;未碰 runtime/providers/memory/persona/observability/interaction 实现与 cli-voice 语音逻辑;`--voice` 分发保留
