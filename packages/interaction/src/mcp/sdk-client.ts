import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  McpProtocolError,
  type McpCallResult,
  type McpClient,
  type McpContentBlock,
  type McpToolDef,
} from './types';

export interface SdkMcpClientOptions {
  /** 服务器逻辑名(命名空间前缀)。 */
  readonly serverName: string;
  /**
   * 传输工厂(注入):真机 = `new StdioClientTransport({command,args})`;
   * 测试 = `InMemoryTransport.createLinkedPair()[0]`。**Streamable HTTP 留接缝**:换工厂即可,
   * client 代码零改动(决策 1 / task 2.5)。
   */
  readonly transport: () => Transport;
  /** client 自报名/版本(供 server 端 trace)。 */
  readonly clientInfo?: { readonly name: string; readonly version: string };
}

/**
 * 官方 SDK(`@modelcontextprotocol/sdk`)实现的 MCP client(决策 1,task 2.1)。
 * 大脑=client、能力进程=server。封装 initialize/版本协商 → tools/list(分页)→ tools/call,
 * content[] 归一 + isError 解析 + JSON-RPC 错误→McpProtocolError(fault:system,§3.3)。
 *
 * 消费者只见 `McpClient` 接口;若日后降级自写最小 client,换实现不动消费者(task 2.1)。
 */
export class SdkMcpClient implements McpClient {
  readonly serverName: string;
  readonly #transportFactory: () => Transport;
  readonly #client: Client;
  #connected = false;
  readonly #listChangedHandlers = new Set<() => void>();

  constructor(opts: SdkMcpClientOptions) {
    this.serverName = opts.serverName;
    this.#transportFactory = opts.transport;
    this.#client = new Client(
      opts.clientInfo ?? { name: 'chat-a', version: '0.1.0' },
      { capabilities: {} },
    );
    // tools/list_changed:server 增删工具时触发,转交我方监听者(由 CapabilityRegistry 重拉)。
    this.#client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      for (const h of this.#listChangedHandlers) {
        try {
          h();
        } catch {
          // 监听者自身错误不回灌 server;吞掉保子系统稳定。
        }
      }
    });
  }

  async connect(): Promise<void> {
    if (this.#connected) return;
    try {
      await this.#client.connect(this.#transportFactory());
      this.#connected = true;
    } catch (err) {
      throw new McpProtocolError(`initialize 失败:${msg(err)}`);
    }
  }

  protocolVersion(): string | undefined {
    // SDK 在 initialize 后记录;经 getServerVersion 不含 protocolVersion,故用 server capabilities 存在性近似 +
    // 真协议版本由 SDK 内部协商。这里返回 SDK 暴露的 server 版本串作可观测信息。
    return this.#client.getServerVersion()?.version;
  }

  async listTools(): Promise<readonly McpToolDef[]> {
    this.#assertConnected();
    const out: McpToolDef[] = [];
    let cursor: string | undefined;
    // 分页(task 2.2):跟随 nextCursor 直到取尽。
    do {
      let page;
      try {
        page = await this.#client.listTools(cursor !== undefined ? { cursor } : {});
      } catch (err) {
        throw new McpProtocolError(`tools/list 失败:${msg(err)}`);
      }
      for (const t of page.tools) {
        out.push({
          name: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema as Readonly<Record<string, unknown>>,
        });
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return out;
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<McpCallResult> {
    this.#assertConnected();
    let raw;
    try {
      raw = await this.#client.callTool({ name, arguments: { ...args } });
    } catch (err) {
      // JSON-RPC 协议错误(方法不存在/连接断/超时)→ fault:system。
      throw new McpProtocolError(`tools/call(${name}) 失败:${msg(err)}`);
    }
    return parseCallResult(raw);
  }

  onToolListChanged(handler: () => void): () => void {
    this.#listChangedHandlers.add(handler);
    return () => this.#listChangedHandlers.delete(handler);
  }

  async close(): Promise<void> {
    if (!this.#connected) return;
    this.#connected = false;
    try {
      await this.#client.close();
    } catch {
      // 关闭尽力而为。
    }
  }

  #assertConnected(): void {
    if (!this.#connected) throw new McpProtocolError('client 未连接');
  }
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** content[] 各块归一为可读文本 + 结构化块 + isError(task 2.2)。 */
export function parseCallResult(raw: unknown): McpCallResult {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const isError = obj['isError'] === true;
  const rawBlocks = Array.isArray(obj['content']) ? (obj['content'] as unknown[]) : [];
  const blocks: McpContentBlock[] = [];
  const textParts: string[] = [];
  for (const b of rawBlocks) {
    const block = (b ?? {}) as Record<string, unknown>;
    switch (block['type']) {
      case 'text': {
        const text = typeof block['text'] === 'string' ? block['text'] : '';
        blocks.push({ type: 'text', text });
        textParts.push(text);
        break;
      }
      case 'image': {
        const mimeType = typeof block['mimeType'] === 'string' ? block['mimeType'] : 'image/*';
        blocks.push({ type: 'image', mimeType });
        textParts.push(`[图片:${mimeType}]`);
        break;
      }
      case 'audio': {
        const mimeType = typeof block['mimeType'] === 'string' ? block['mimeType'] : 'audio/*';
        blocks.push({ type: 'audio', mimeType });
        textParts.push(`[音频:${mimeType}]`);
        break;
      }
      case 'resource': {
        const res = (block['resource'] ?? {}) as Record<string, unknown>;
        const uri = typeof res['uri'] === 'string' ? res['uri'] : '';
        blocks.push({ type: 'resource', uri });
        // 内嵌资源若带 text 一并纳入。
        if (typeof res['text'] === 'string') textParts.push(res['text']);
        else textParts.push(`[资源:${uri}]`);
        break;
      }
      case 'resource_link': {
        const uri = typeof block['uri'] === 'string' ? block['uri'] : '';
        const name = typeof block['name'] === 'string' ? block['name'] : '';
        blocks.push({ type: 'resource_link', uri, name });
        textParts.push(`[资源链接:${name} ${uri}]`);
        break;
      }
      default:
        blocks.push({ type: 'unknown' });
    }
  }
  return { content: textParts.join('\n'), blocks, isError };
}
