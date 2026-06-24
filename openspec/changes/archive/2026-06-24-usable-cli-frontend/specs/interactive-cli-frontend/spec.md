## ADDED Requirements

### Requirement: 启动加载 .env.local

CLI 前端 SHALL 在启动装配 LLM/人格配置**之前**,尝试从项目根读取 `.env.local`,把其中的键值注入进程环境,使 `pnpm dev` 与 `start.bat` 行为一致(用户只需在根目录放一行 key 即可用真模型)。解析 MUST 为纯函数(`KEY=VALUE` 逐行、`#` 开头与空行跳过、只切第一个 `=`、去首尾空白与成对引号),对齐 `start.bat` 语义。注入 MUST **不覆盖**进程中已存在(非空)的真实环境变量(真实 env 优先)。文件不存在或读取失败 MUST 静默跳过、绝不崩(§3.2)。

#### Scenario: 解析键值与注释空行

- **WHEN** `.env.local` 含 `KEY=VALUE` 行、`#` 注释行、空行、含 `=` 的 value、带成对引号的 value
- **THEN** 解析得到去空白/去引号的键值映射,注释与空行被跳过,value 中第一个 `=` 之后的内容(含其余 `=`)完整保留

#### Scenario: 不覆盖已有环境变量

- **WHEN** 某键已存在于进程环境(非空),`.env.local` 也含同名键
- **THEN** 进程中的现有值优先,不被 `.env.local` 覆盖

#### Scenario: 文件缺失不崩

- **WHEN** 项目根不存在 `.env.local`
- **THEN** 启动照常进行,静默跳过加载,不抛错

### Requirement: 斜杠命令解析与分发

CLI 前端 SHALL 把每行输入先经**纯函数** `parseCommand` 归类,再分发:不以 `/` 开头的非空输入 = 普通对话(转交 `Conversation.send` 流式回复);`/help`、`/quit`、`/exit`(=quit)、`/clear`、`/persona`、`/reset` 为内建命令(大小写不敏感);其它 `/xxx` = 未知命令,MUST 给出友好提示(「未知命令,/help 查看」)而非当作对话发给 LLM;空输入 MUST 被忽略并重新提示。命令解析 MUST 无副作用、可单测。

#### Scenario: 普通对话与命令区分

- **WHEN** 输入一行不以 `/` 开头的非空文本
- **THEN** 归类为对话,转交 `Conversation.send` 流式输出回复

#### Scenario: 内建命令与别名

- **WHEN** 输入 `/quit` 或其别名 `/exit`(任意大小写)
- **THEN** 归类为退出命令,触发优雅收尾并结束

#### Scenario: 未知命令不发给 LLM

- **WHEN** 输入未注册的 `/xxx`
- **THEN** 打印友好提示并继续提示输入,不把该行作为对话发给 LLM

### Requirement: 友好启动横幅

CLI 前端 SHALL 通过**纯函数** `renderBanner` 渲染面向用户的启动横幅,至少包含:人格名(小雪)、当前 LLM provider/model、记忆后端状态、人格情绪旋钮摘要、以及「输入 /help 查看命令」提示。当 provider 为 `fake`(未配置真模型)时,横幅 MUST 追加"如何配置真模型"的引导(`.env.local` 一行 key / 切 Qwen 的 env)。渲染 MUST 无副作用、可单测。

#### Scenario: 横幅含关键信息

- **WHEN** 以某 provider/model、记忆后端、人格信息渲染横幅
- **THEN** 输出包含该 provider/model、记忆后端、人格名与「/help」提示

#### Scenario: fake 兜底给出引导

- **WHEN** provider 为 `fake`
- **THEN** 横幅追加配置真模型的引导文案;provider 非 fake 时不含该引导

### Requirement: 优雅退出与永不崩

CLI 前端 SHALL 在 Ctrl+C(SIGINT)、`/quit`、以及 stdin EOF(管道结束)三种情况下都执行**相同的收尾**(停语音 / 会话沉淀 / 关闭记忆库 / 关闭 trace / 关闭 telemetry)并优雅退出,不抛栈。收尾 MUST 幂等(多次触发不重复关库)。对话过程中 LLM/网络出错 MUST 打印友好中文提示并继续会话,绝不崩、绝不哑(§3.2)。`--voice` / `CHAT_A_VOICE=1` 的语音分发 MUST 原样保留。

#### Scenario: Ctrl+C 优雅退出

- **WHEN** 用户在对话中按 Ctrl+C
- **THEN** 打印告别、执行收尾并退出,不抛未捕获异常栈

#### Scenario: 对话出错友好降级

- **WHEN** 某一轮 `Conversation.send` 抛错(LLM/网络故障)
- **THEN** 打印友好中文提示,会话继续可用,不崩
