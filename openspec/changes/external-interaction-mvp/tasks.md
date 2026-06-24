## 1. 感知框架(§12.1)

- [ ] 1.1 `PerceptionSource` 接口(id/modality{heard,sighted,felt,temporal,system}/start(emit)/stop/health)+ raw 事件类型加到 `protocol`(`raw:<modality>:<kind>`,与 BusEvent 同构)
- [ ] 1.2 三层去抖管线:源内边沿 latch(有状态)→ 滑窗 detector(**纯函数**,阈值走 config)→ 0.3s 聚合窗 → fire `signal:*{description,metadata,confidence}`
- [ ] 1.3 `PerceptionHub`:注册/启停多源、聚合窗合并、经 A 层总线发布 signal(带 correlationId)
- [ ] 1.4 内置源:`system.tick`(可注入 clock)、系统通知;麦克风源留接入点(从语音管线供给)

## 2. MCP client(§12.3)

- [ ] 2.1 决策并落地:优先 `@modelcontextprotocol/sdk`(client + stdio transport);若引入受阻则自写最小 client(initialize/tools.list/tools.call/notifications)。接口对消费者一致
- [ ] 2.2 initialize + protocolVersion 协商;`tools/list`(分页);`tools/call{name,arguments}` → 解析 `content[]`(text/image/audio/resource)+ `isError`
- [ ] 2.3 `notifications/tools/list_changed` → 重拉 tools/list(动态 register/unregister)
- [ ] 2.4 错误双轨归因:JSON-RPC 错误→`fault:system`;`isError:true`→`fault:tool`(映射 protocol Fault)
- [ ] 2.5 传输:stdio(本地)实装;Streamable HTTP 留接缝(不实装)

## 3. CapabilityRegistry + 边界翻译(§12.3/接缝3)

- [ ] 3.1 `CapabilityRegistry`:归集 MCP 工具 + 终端能力声明;`mcp_server.tool` 命名空间防同名覆盖
- [ ] 3.2 边界翻译:MCP 工具 → Anthropic tool 定义(对接现有 interaction 工具通道)
- [ ] 3.3 接缝 3 终端能力声明(我有麦/扬/屏)统一进 registry

## 4. ProcessSupervisor(§12.3)

- [ ] 4.1 拉起/探活(health 周期轮询)/崩溃自愈(指数退避 + jitter)
- [ ] 4.2 核心能力强制监督;可选能力可降级**不阻塞启动**(承优雅降级)
- [ ] 4.3 LIFO 优雅关闭

## 5. TaskExecutor(§12.2)

- [ ] 5.1 复用既有 `ActionRegistry`;新增 `TaskExecutor`:经 A 层总线发 `action:started/completed/failed`(correlationId)
- [ ] 5.2 单飞行 + 取消(打断回滚,承 §4 AbortSignal);结果回灌下回合 context
- [ ] 5.3 `action:*` 事件类型加到 `protocol`

## 6. 测试(注入 mock,不依赖真实进程/网络)

- [ ] 6.1 感知:fake source + fake clock → 三层去抖输出确定;聚合窗合并多源;detector golden test
- [ ] 6.2 MCP client:mock stdio transport + fake/echo MCP server → list/call/list_changed/错误双轨
- [ ] 6.3 CapabilityRegistry:同名命名空间隔离;终端能力声明归集
- [ ] 6.4 ProcessSupervisor:崩溃→退避重启;可选能力崩溃不阻塞;LIFO 关闭
- [ ] 6.5 TaskExecutor:started/completed/failed 总线序列;取消回滚
- [ ] 6.6 优雅降级:任一源/能力崩溃主对话不受影响

## 7. 收尾

- [ ] 7.1 worktree 根 `pnpm -r typecheck` 全绿
- [ ] 7.2 worktree 根 `npx vitest run` 全绿(新增 + 回归)
- [ ] 7.3 自检:§12 只采集/执行不决策(只发总线)、§3.2 优雅降级、§3.3 错误归因、命名空间防覆盖;commit 到 worktree 分支(中文),不 push、不动 master
- [ ] 7.4 简报注明:仅 §12.4 MVP;Streamable HTTP/真实外部能力/直播游戏为演进未做;真实 stdio 子进程行为待真机验证
