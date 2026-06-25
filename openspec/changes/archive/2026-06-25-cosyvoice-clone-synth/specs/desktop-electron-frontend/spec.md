## ADDED Requirements

### Requirement: desktop 经 CosyVoice 管线一键复刻本地音频

当选用 CosyVoice 引擎时,desktop 复刻入口 SHALL 在"选本地文件"前提下完成:读盘 → DashScope 临时上传取得 `oss://` URL → CosyVoice `create_voice` → 异步轮询直到 `OK`。引擎选择 SHALL 经配置(如 `CHAT_A_VOICE_CLONE_KIND=cosyvoice` 或 target_model 含 `cosyvoice`)决定;未选 CosyVoice 时复刻走现有 qwen 链路、行为不变。

#### Scenario: 本地文件 CosyVoice 复刻成功
- **WHEN** 用户在 CosyVoice 引擎下选择本地音频并触发复刻,上传/创建/轮询均成功
- **THEN** desktop 取得可用 voice_id,渲染层显示复刻成功

#### Scenario: 复刻任一步失败优雅降级
- **WHEN** 上传、创建或轮询任一步失败
- **THEN** desktop 显示清晰中文失败原因、不崩溃,文字对话功能不受影响

### Requirement: desktop 复刻成功持久化 CosyVoice 合成配置

CosyVoice 复刻成功后,desktop SHALL 把 `voice_id`、`target_model`(=合成所用 `cosyvoice-v3.5-flash`)、`CHAT_A_TTS_KIND=cosyvoice` 持久化到 `.env.local` 并即时设入进程 env,使复刻成功即可直接以复刻音色朗读、无需手动配模型。持久化 SHALL 同键幂等覆盖。

#### Scenario: 持久化后直接可朗读
- **WHEN** CosyVoice 复刻成功
- **THEN** `.env.local` 含一致的 voice_id + target_model + CHAT_A_TTS_KIND=cosyvoice,后续朗读以复刻音色合成

#### Scenario: 合成 model 与复刻 target_model 同串
- **WHEN** 持久化复刻结果
- **THEN** 写入的合成 model 与复刻 target_model 逐字一致(满足 CosyVoice 一致性硬约束)

### Requirement: 复刻轮询期进度反馈

CosyVoice 复刻含异步轮询(可达数分钟);desktop SHALL 在轮询期向渲染层报告进行中状态,避免用户误以为卡死。

#### Scenario: 轮询期显示进行中
- **WHEN** 复刻处于异步部署轮询阶段
- **THEN** 渲染层显示"复刻处理中"一类进度状态,直至成功或失败
