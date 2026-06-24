import { describe, it, expect } from 'vitest';
import {
  CapabilityRegistry,
  type McpClient,
  type McpCallResult,
  type McpToolDef,
} from '../src/index';

/** mock McpClient:记录 callTool 路由。 */
function makeMockClient(serverName: string): McpClient & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    serverName,
    calls,
    connect: () => Promise.resolve(),
    listTools: () => Promise.resolve([]),
    callTool: (name, args): Promise<McpCallResult> => {
      calls.push([name, args]);
      return Promise.resolve({
        content: `${serverName}:${name}`,
        blocks: [{ type: 'text', text: `${serverName}:${name}` }],
        isError: false,
      });
    },
    onToolListChanged: () => () => {},
    close: () => Promise.resolve(),
    protocolVersion: () => '1.0',
  };
}

const tool = (name: string): McpToolDef => ({
  name,
  description: `工具 ${name}`,
  inputSchema: { type: 'object', properties: {} },
});

describe('mcp/CapabilityRegistry 命名空间 + 边界翻译', () => {
  it('两 server 同名工具不静默覆盖(mcp_server.tool 命名空间)', () => {
    const reg = new CapabilityRegistry();
    reg.ingestServerTools('weather', [tool('forecast')]);
    reg.ingestServerTools('calendar', [tool('forecast')]); // 同名!
    const names = reg.tools.map((t) => t.qualifiedName).sort();
    expect(names).toEqual(['calendar.forecast', 'weather.forecast']);
  });

  it('toolDefs 适配成 Anthropic tool 定义(name=命名空间全名)', () => {
    const reg = new CapabilityRegistry();
    reg.ingestServerTools('weather', [tool('forecast')]);
    const defs = reg.toolDefs();
    expect(defs).toEqual([
      {
        name: 'weather.forecast',
        description: '工具 forecast',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);
  });

  it('callTool 据命名空间路由到对应 client 的原始工具名', async () => {
    const reg = new CapabilityRegistry();
    const weather = makeMockClient('weather');
    const calendar = makeMockClient('calendar');
    reg.registerClient(weather).registerClient(calendar);
    reg.ingestServerTools('weather', [tool('forecast')]);
    reg.ingestServerTools('calendar', [tool('forecast')]);

    const r1 = await reg.callTool('weather.forecast', { city: '北京' });
    expect(r1.content).toBe('weather:forecast');
    expect(weather.calls).toEqual([['forecast', { city: '北京' }]]);
    expect(calendar.calls).toHaveLength(0);

    await reg.callTool('calendar.forecast', {});
    expect(calendar.calls).toEqual([['forecast', {}]]);
  });

  it('list_changed 后 ingest 重灌:只替换该 server 工具,不影响他 server', () => {
    const reg = new CapabilityRegistry();
    reg.ingestServerTools('weather', [tool('forecast'), tool('alerts')]);
    reg.ingestServerTools('calendar', [tool('events')]);
    // weather 动态增删:只剩 forecast。
    reg.ingestServerTools('weather', [tool('forecast')]);
    const names = reg.tools.map((t) => t.qualifiedName).sort();
    expect(names).toEqual(['calendar.events', 'weather.forecast']);
  });

  it('未知工具 / 未注册 client → 抛错(由上层收敛)', async () => {
    const reg = new CapabilityRegistry();
    await expect(reg.callTool('ghost.x', {})).rejects.toThrow('未知工具');
    reg.ingestServerTools('weather', [tool('forecast')]); // 有工具但无 client
    await expect(reg.callTool('weather.forecast', {})).rejects.toThrow('未注册 client');
  });

  it('终端能力声明(我有麦/扬/屏)归入同一 registry(接缝 3)', () => {
    const reg = new CapabilityRegistry();
    reg
      .declareTerminalCapability({ id: 'mic', description: '麦克风' })
      .declareTerminalCapability({ id: 'speaker', description: '扬声器' })
      .declareTerminalCapability({ id: 'screen', description: '屏幕' });
    expect(reg.terminalCapabilities.map((c) => c.id).sort()).toEqual(['mic', 'screen', 'speaker']);
  });
});
