# dashscope-file-upload Specification

## Purpose
TBD - created by archiving change cosyvoice-clone-synth. Update Purpose after archive.
## Requirements
### Requirement: 本地文件上传至 DashScope 临时存储并取得 URL

系统 SHALL 提供把本地文件上传到 DashScope 临时存储并返回可用于后续 DashScope API 的临时 URL 的能力,流程为:`GET {endpoint}/api/v1/uploads?action=getPolicy&model={model}`(Bearer 鉴权)取得上传凭证 → 用凭证以 multipart/form-data POST 到凭证给出的 `upload_host` → 拼出 `oss://{key}` 形式的临时 URL。该 URL 的有效期 SHALL 视为 48 小时。`model`、`endpoint` 与上传所用字段名 SHALL 隔离在可改函数中以便真机校准。

#### Scenario: 取得上传凭证并上传成功
- **WHEN** 调用上传函数并传入文件字节与文件名,getPolicy 与 OSS POST 均返回成功
- **THEN** 系统返回 `oss://{upload_dir}/{filename}` 形式的临时 URL

#### Scenario: 凭证获取失败优雅报错
- **WHEN** getPolicy 返回非 2xx 或响应缺少必要凭证字段
- **THEN** 系统抛出清晰中文错误(含 HTTP 状态/片段,**不含 API key**),不静默吞掉

#### Scenario: 注入 fetch 单测不触网
- **WHEN** 调用方注入 mock fetch
- **THEN** 上传流程全程不发起真实网络请求,凭证与 OSS 响应由 mock 提供

### Requirement: oss:// URL 在后续调用须声明解析头

当把 `oss://` 临时 URL 用于后续 DashScope 接口(如声音复刻 create_voice)时,系统 SHALL 在该次 HTTP 请求头中加入 `X-DashScope-OssResourceResolve: enable`;缺失该头时服务端无法解析 oss:// 链接。是否对某具体接口生效属真机校准项,但代码 SHALL 默认对 oss:// URL 携带此头。

#### Scenario: oss:// URL 触发解析头
- **WHEN** 复刻请求的 `url` 以 `oss://` 开头
- **THEN** 该请求头包含 `X-DashScope-OssResourceResolve: enable`

#### Scenario: 公网 https URL 不强制该头
- **WHEN** 复刻请求的 `url` 为普通公网 `https://` 地址
- **THEN** 系统不要求附加该解析头(普通公网 URL 无需解析)

