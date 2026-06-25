## ADDED Requirements

### Requirement: CosyVoice 复刻契约创建音色

系统 SHALL 支持经 CosyVoice 契约创建复刻音色,与现有 qwen 契约并存且互不影响。请求体 SHALL 为 `{model:"voice-enrollment", input:{action:"create_voice", target_model, prefix, url, language_hints?}}`,其中 `target_model` 默认 `cosyvoice-v3.5-flash`、`prefix` 仅含数字字母且 ≤10 字符、`url` 为公网可访问或 `oss://` 临时 URL、`language_hints` 为可选语种数组(仅取首元素)。系统 SHALL 从响应 `output.voice_id` 解析音色 id。端点、字段名、默认 target_model SHALL 隔离在可改函数中以便真机校准。

#### Scenario: 创建成功返回 voice_id
- **WHEN** 以合法 url + target_model 调用 CosyVoice 创建,服务端返回 `output.voice_id`
- **THEN** 系统返回该 voice_id

#### Scenario: 非法 prefix 在发请求前拦截
- **WHEN** prefix 含非数字字母字符或超过 10 字符
- **THEN** 系统在发请求前抛出清晰中文错误,说明 prefix 约束

#### Scenario: 与 qwen 契约并存互不影响
- **WHEN** 调用方选择 qwen 复刻契约
- **THEN** 现有 qwen 创建请求体(qwen-voice-enrollment/action:create/base64/output.voice)逐字不变

### Requirement: CosyVoice 复刻音色异步轮询直到可用

CosyVoice 创建音色为异步部署;系统 SHALL 在创建后经 `query_voice`(`{model:"voice-enrollment", input:{action:"query_voice", voice_id}}`)轮询 `status`,直到取得 `OK`(可用)、`UNDEPLOYED`(失败)或超过最大轮询次数。轮询间隔、最大次数 SHALL 为可配置常量(默认间隔约 10 秒、上限约 30 次)。失败或超时 SHALL 返回清晰中文错误。

#### Scenario: 部署完成
- **WHEN** query_voice 返回 status=OK
- **THEN** 轮询结束,音色判定为可用

#### Scenario: 部署失败
- **WHEN** query_voice 返回 status=UNDEPLOYED
- **THEN** 系统停止轮询并报"音色部署失败"中文错误

#### Scenario: 轮询超时
- **WHEN** 达到最大轮询次数仍为 DEPLOYING
- **THEN** 系统停止轮询并报超时错误,提示稍后用 query_voice/list_voice 复核

#### Scenario: 取消中断轮询
- **WHEN** 轮询期间收到 AbortSignal 取消
- **THEN** 轮询干净终止,不再发起新请求

### Requirement: CosyVoice 音色管理

系统 SHALL 支持经 CosyVoice 契约列举与删除音色:`list_voice`(带 `prefix?`/`page_index`/`page_size` 分页)与 `delete_voice`(带 `voice_id`)。响应中音色标识字段名 SHALL 按 `voice_id` 解析,并隔离在可改函数中。

#### Scenario: 列举音色分页
- **WHEN** 调用 list_voice
- **THEN** 系统按分页取回并解析出 voice_id 列表

#### Scenario: 删除音色
- **WHEN** 以合法 voice_id 调用 delete_voice 且服务端成功
- **THEN** 调用成功返回,不抛错
