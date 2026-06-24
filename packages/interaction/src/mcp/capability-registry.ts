import type { LlmToolDef } from '@chat-a/providers';
import type { McpCallResult, McpClient, McpToolDef } from './types';

/**
 * 终端能力声明(接缝 3,task 3.3):终端"我有麦/扬/屏"等设备能力,与 MCP 工具同归 registry。
 * 非工具(无 inputSchema/不可 call),仅作能力清单供能力门/调度参考。
 */
export interface TerminalCapability {
  /** 能力标签(如 'mic'/'speaker'/'screen')。 */
  readonly id: string;
  readonly description: string;
}

/** registry 内一条工具记录:命名空间全名 + 出处 server + 原始定义。 */
export interface RegisteredTool {
  /** 命名空间全名:`<serverName>.<toolName>`(防同名静默覆盖,决策 4)。 */
  readonly qualifiedName: string;
  readonly serverName: string;
  readonly tool: McpToolDef;
}

/**
 * 能力归集中枢(§12.3 / 接缝 3,task 3.1/3.2/3.3)。
 *
 * - 归集多个 MCP server 的工具,**强制 `mcp_server.tool` 命名空间**——两个 server 同名工具
 *   以 `serverA.foo` / `serverB.foo` 区分,**不静默覆盖**(决策 4)。
 * - 边界翻译:`toolDefs()` 把工具适配成 Anthropic tool 定义(`LlmToolDef`),对接现有 interaction
 *   工具通道;喂模型的 name = 命名空间全名。
 * - `callTool(qualifiedName, args)` 解析命名空间 → 路由到对应 server 的 McpClient(task 3.2)。
 * - 终端能力声明(我有麦/扬/屏)统一进同一 registry(task 3.3)。
 *
 * **只归集/路由,不决策**(§12):是否调用由模型/cognition 决定。
 */
export class CapabilityRegistry {
  /** serverName → client。 */
  readonly #clients = new Map<string, McpClient>();
  /** qualifiedName → 工具记录。 */
  readonly #tools = new Map<string, RegisteredTool>();
  /** id → 终端能力声明。 */
  readonly #terminalCaps = new Map<string, TerminalCapability>();

  /**
   * 接入一个 MCP server 的工具(全替换该 server 名下旧工具,支持 list_changed 后重灌)。
   * 已存在的**其它 server** 同名工具不受影响(命名空间隔离)。
   */
  ingestServerTools(serverName: string, tools: readonly McpToolDef[]): this {
    // 先清掉该 server 名下旧工具(动态增删,task 2.3)。
    for (const [qn, rec] of [...this.#tools]) {
      if (rec.serverName === serverName) this.#tools.delete(qn);
    }
    for (const tool of tools) {
      const qualifiedName = `${serverName}.${tool.name}`;
      this.#tools.set(qualifiedName, { qualifiedName, serverName, tool });
    }
    return this;
  }

  /** 注册一个 server 的 client(供 callTool 路由)。 */
  registerClient(client: McpClient): this {
    this.#clients.set(client.serverName, client);
    return this;
  }

  /** 注册终端能力声明(接缝 3)。 */
  declareTerminalCapability(cap: TerminalCapability): this {
    this.#terminalCaps.set(cap.id, cap);
    return this;
  }

  get terminalCapabilities(): readonly TerminalCapability[] {
    return [...this.#terminalCaps.values()];
  }

  /** 全部工具记录(命名空间全名)。 */
  get tools(): readonly RegisteredTool[] {
    return [...this.#tools.values()];
  }

  /**
   * 边界翻译(task 3.2):MCP 工具 → Anthropic tool 定义(`LlmToolDef`)。
   * name 用命名空间全名喂模型,description/inputSchema 透传。
   */
  toolDefs(): LlmToolDef[] {
    return this.tools.map((rec) => ({
      name: rec.qualifiedName,
      description: rec.tool.description,
      inputSchema: rec.tool.inputSchema,
    }));
  }

  /**
   * 据命名空间全名调用工具:解析 `<server>.<tool>` → 路由到对应 client。
   * 未知工具/未注册 client 抛错(由上层 TaskExecutor 收敛)。
   */
  async callTool(
    qualifiedName: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<McpCallResult> {
    const rec = this.#tools.get(qualifiedName);
    if (rec === undefined) {
      throw new Error(`未知工具:${qualifiedName}`);
    }
    const client = this.#clients.get(rec.serverName);
    if (client === undefined) {
      throw new Error(`server 未注册 client:${rec.serverName}`);
    }
    return client.callTool(rec.tool.name, args);
  }
}
