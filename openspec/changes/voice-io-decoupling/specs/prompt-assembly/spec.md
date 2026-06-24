## ADDED Requirements

### Requirement: OutputLanguageContributor 注入输出语种

系统 SHALL 提供 `OutputLanguageContributor`(PromptContributor,§5.4):当 `PromptContext.outputLang` 为非空字符串时,`contribute` SHALL 返回一段**温和、明确**指示"无论用户用什么语言,都用<目标语种>回复"的 `PromptFragment`(承 §4.1 LLM 按 `output_lang` 生成语言);`outputLang` 缺省/为空/全空白时 SHALL 返回 `null`(MUST NOT 拼空段)。其 `priority` SHALL 取 `PROMPT_PRIORITY.outputLanguage`(高注意力区,位于 `style` 与 `dissent` 之间,带间隙、外置可配,无 magic number),`tier` SHALL 为 `'peripheral'`(极端预算下可裁,核心事实/记忆优先)。`contribute` MUST 同步、MUST NOT 引入 I/O(承 §3.2 延迟预算)。

#### Scenario: outputLang 非空 → 注入语种指令

- **WHEN** `PromptContext.outputLang === 'zh'`
- **THEN** `contribute` 返回含目标语种「zh」的温和回复语种指令片段,`priority === PROMPT_PRIORITY.outputLanguage`

#### Scenario: outputLang 缺省/空 → 零注入(回归绿)

- **WHEN** `PromptContext.outputLang` 未设置或为空字符串/纯空白
- **THEN** `contribute` 返回 `null`,系统提示不含输出语种段(与未引入本 contributor 时逐字一致)

### Requirement: Conversation 注册 OutputLanguageContributor 并透传 outputLang

`Conversation` SHALL 在构造期把 `OutputLanguageContributor` 注册进 `PromptAssembler`,并经 `ConversationDeps.outputLang`(可选)→ `composeSystem` → `PromptContext.outputLang` 透传(`SingleShotStrategy` 与 `ToolCallingStrategy` 共用 turn-shared,零漂移)。仅在提供 `outputLang` 时透传(`exactOptionalPropertyTypes` 友好)。当未提供 `outputLang` 时,`OutputLanguageContributor` MUST 恒返回 `null`,系统提示字节与未引入本接线时**逐字一致**(KV 前缀稳定,§5.4)。

#### Scenario: 注入 outputLang → 系统提示含语种段

- **WHEN** `Conversation` 注入 `outputLang='ja'`,跑一个回合
- **THEN** 该回合 assembled.system 含目标语种「ja」的回复语种指令段

#### Scenario: 未注入 outputLang → 系统提示不变(回归绿)

- **WHEN** `Conversation` 未注入 `outputLang`
- **THEN** assembled.system 不含输出语种段,与未引入本接线时逐字一致
