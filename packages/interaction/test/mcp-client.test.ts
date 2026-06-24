import { describe, it, expect } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { SdkMcpClient, McpProtocolError, parseCallResult } from '../src/index';

/**
 * 测试用 fake/echo MCP server(in-memory transport,**不起真进程/网络**)。
 * 支持:tools/list(可分页)、tools/call(echo)、动态增删 + tools/list_changed。
 */
function makeFakeServer(opts: {
  paged?: boolean;
} = {}) {
  let tools = [
    {
      name: 'echo',
      description: '回显输入',
      inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } } },
    },
    {
      name: 'boom',
      description: '总是业务失败',
      inputSchema: { type: 'object' as const, properties: {} },
    },
  ];

  const server = new Server(
    { name: 'fake', version: '9.9.9' },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, (req) => {
    if (opts.paged === true) {
      // 两页:无 cursor → 第一个工具 + nextCursor;cursor='p2' → 其余。
      const cursor = req.params?.cursor;
      if (cursor === undefined) {
        return { tools: [tools[0]!], nextCursor: 'p2' };
      }
      return { tools: tools.slice(1) };
    }
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, (req) => {
    const { name, arguments: args } = req.params;
    if (name === 'boom') {
      return { content: [{ type: 'text', text: '工具内部失败' }], isError: true };
    }
    if (name === 'echo') {
      return { content: [{ type: 'text', text: `echo:${JSON.stringify(args ?? {})}` }] };
    }
    // 未知工具 → 抛错(走 JSON-RPC 错误,client 侧应转 McpProtocolError)。
    throw new Error(`no such tool ${name}`);
  });

  const setTools = (next: typeof tools): void => {
    tools = next;
  };
  return { server, setTools };
}

/** 把 SdkMcpClient 与 fake server 经 in-memory transport 对接,返回已连 client。 */
async function connectPair(fake: ReturnType<typeof makeFakeServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await fake.server.connect(serverTransport);
  const client = new SdkMcpClient({
    serverName: 'weather',
    transport: (): Transport => clientTransport,
  });
  await client.connect();
  return client;
}

describe('mcp/SdkMcpClient(官方 SDK + in-memory transport)', () => {
  it('initialize + tools/list + tools/call(echo)', async () => {
    const fake = makeFakeServer();
    const client = await connectPair(fake);

    const tools = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['boom', 'echo']);

    const res = await client.callTool('echo', { text: 'hi' });
    expect(res.isError).toBe(false);
    expect(res.content).toContain('echo:');
    expect(res.blocks[0]).toMatchObject({ type: 'text' });

    await client.close();
  });

  it('tools/list 分页:跟随 nextCursor 取尽', async () => {
    const fake = makeFakeServer({ paged: true });
    const client = await connectPair(fake);
    const tools = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['boom', 'echo']);
    await client.close();
  });

  it('错误双轨:isError:true → 结果 isError(fault:tool 由消费者判定),不抛', async () => {
    const fake = makeFakeServer();
    const client = await connectPair(fake);
    const res = await client.callTool('boom', {});
    expect(res.isError).toBe(true);
    expect(res.content).toContain('工具内部失败');
    await client.close();
  });

  it('错误双轨:JSON-RPC 协议错误 → McpProtocolError(fault:system)', async () => {
    const fake = makeFakeServer();
    const client = await connectPair(fake);
    await expect(client.callTool('ghost', {})).rejects.toBeInstanceOf(McpProtocolError);
    try {
      await client.callTool('ghost', {});
    } catch (e) {
      expect((e as McpProtocolError).fault).toBe('system');
    }
    await client.close();
  });

  it('tools/list_changed → 触发监听者(动态增删)', async () => {
    const fake = makeFakeServer();
    const client = await connectPair(fake);
    let fired = 0;
    client.onToolListChanged(() => {
      fired += 1;
    });
    // server 增删工具并通知。
    fake.setTools([
      { name: 'newtool', description: 'n', inputSchema: { type: 'object', properties: {} } },
    ]);
    await fake.server.sendToolListChanged();
    // 等待 in-memory transport 投递通知。
    await new Promise((r) => setTimeout(r, 10));
    expect(fired).toBeGreaterThanOrEqual(1);
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['newtool']);
    await client.close();
  });

  it('未连接 callTool → McpProtocolError', async () => {
    const client = new SdkMcpClient({
      serverName: 's',
      transport: (): Transport => InMemoryTransport.createLinkedPair()[0],
    });
    await expect(client.callTool('x', {})).rejects.toBeInstanceOf(McpProtocolError);
  });
});

describe('mcp/parseCallResult 归一 content[](text/image/audio/resource)', () => {
  it('各块归一为可读文本 + 保留结构化块', () => {
    const r = parseCallResult({
      content: [
        { type: 'text', text: '一段文字' },
        { type: 'image', mimeType: 'image/png', data: 'AAA' },
        { type: 'audio', mimeType: 'audio/wav', data: 'BBB' },
        { type: 'resource', resource: { uri: 'file://x', text: '资源正文' } },
        { type: 'resource_link', uri: 'http://y', name: '链接' },
      ],
    });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('一段文字');
    expect(r.content).toContain('[图片:image/png]');
    expect(r.content).toContain('[音频:audio/wav]');
    expect(r.content).toContain('资源正文');
    expect(r.content).toContain('链接');
    expect(r.blocks).toHaveLength(5);
  });

  it('isError:true 透传', () => {
    expect(parseCallResult({ content: [], isError: true }).isError).toBe(true);
  });
});
