import type { Fault } from '@chat-a/protocol';

/**
 * MCP 工具(经 `tools/list` 取得;name/description/inputSchema 映射 Anthropic tool 三要素)。
 */
export interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/**
 * `tools/call` 解析后的结果(content[] 归一为可读文本 + 保留结构化块 + isError)。
 * `content` 已把 text/image/audio/resource 各块归一成可回灌模型的字符串摘要(图片/音频以占位标注),
 * `blocks` 保留原始结构供需要精确消费的下游。
 */
export interface McpCallResult {
  /** 归一后的可读文本(回灌模型/下回合 context)。 */
  readonly content: string;
  /** 原始 content 块(text/image/audio/resource/resource_link)。 */
  readonly blocks: readonly McpContentBlock[];
  /** MCP 工具业务错误标记(isError:true)→ 归因 fault:tool。 */
  readonly isError: boolean;
}

export type McpContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string }
  | { readonly type: 'audio'; readonly mimeType: string }
  | { readonly type: 'resource'; readonly uri: string }
  | { readonly type: 'resource_link'; readonly uri: string; readonly name: string }
  | { readonly type: 'unknown' };

/**
 * MCP 调用错误(双轨归因,§3.3 / 决策 7):
 *   - JSON-RPC 协议错误(连接断、方法不存在、超时)→ fault:'system'(基础设施)。
 *   - 工具业务错误(isError:true)**不**走此异常通道,而是 McpCallResult.isError=true(fault:tool 由消费者据此判定)。
 */
export class McpProtocolError extends Error {
  readonly fault: Fault = 'system';
  constructor(message: string) {
    super(message);
    this.name = 'McpProtocolError';
  }
}

/**
 * MCP client 消费者接口(§12.3 决策 1):**无论底层是官方 SDK 还是自写最小 client,此接口一致**。
 * 只暴露大脑侧需要的能力:连接/列工具/调工具/监听 list_changed/关闭。
 */
export interface McpClient {
  /** 服务器逻辑名(命名空间前缀,如 'weather' → 工具 'weather.get_forecast')。 */
  readonly serverName: string;
  /** 连接并完成 initialize + 版本协商。失败抛 McpProtocolError。 */
  connect(): Promise<void>;
  /** 拉取全部工具(内部处理分页 cursor)。 */
  listTools(): Promise<readonly McpToolDef[]>;
  /** 调用工具;协议错误抛 McpProtocolError,工具业务错误体现在结果 isError。 */
  callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<McpCallResult>;
  /** 注册 tools/list_changed 回调(server 增删工具时触发)。返回取消句柄。 */
  onToolListChanged(handler: () => void): () => void;
  /** 关闭连接(幂等)。 */
  close(): Promise<void>;
  /** 协商到的协议版本(connect 后可读)。 */
  protocolVersion(): string | undefined;
}
