import { describe, it, expect } from 'vitest';
import { parseCommand, renderHelp, renderPersona, renderBanner } from '../src/commands';

/**
 * 斜杠命令解析 + 文案渲染纯逻辑测试。
 */
describe('client/parseCommand', () => {
  it('空输入(含纯空白)→ empty', () => {
    expect(parseCommand('').kind).toBe('empty');
    expect(parseCommand('   ').kind).toBe('empty');
    expect(parseCommand('\t').kind).toBe('empty');
  });

  it('非斜杠 → chat,并 trim 文本', () => {
    const r = parseCommand('  你好 小雪  ');
    expect(r).toEqual({ kind: 'chat', text: '你好 小雪' });
  });

  it('内建命令各自归类', () => {
    expect(parseCommand('/help').kind).toBe('help');
    expect(parseCommand('/quit').kind).toBe('quit');
    expect(parseCommand('/clear').kind).toBe('clear');
    expect(parseCommand('/persona').kind).toBe('persona');
    expect(parseCommand('/reset').kind).toBe('reset');
  });

  it('/exit 是 /quit 的别名', () => {
    expect(parseCommand('/exit').kind).toBe('quit');
  });

  it('命令大小写不敏感', () => {
    expect(parseCommand('/HELP').kind).toBe('help');
    expect(parseCommand('/Quit').kind).toBe('quit');
  });

  it('命令前后空白被容忍', () => {
    expect(parseCommand('  /help  ').kind).toBe('help');
  });

  it('未知 /xxx → unknown,带原始命令名', () => {
    const r = parseCommand('/foobar');
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.name).toBe('/foobar');
  });

  it('斜杠后带参数也按命令首词归类(命令本身无参时)', () => {
    // /help 后跟内容仍是 help(参数被忽略)
    expect(parseCommand('/help 我').kind).toBe('help');
  });
});

describe('client/renderHelp', () => {
  it('包含所有命令', () => {
    const h = renderHelp();
    for (const cmd of ['/help', '/quit', '/exit', '/clear', '/persona', '/reset']) {
      expect(h).toContain(cmd);
    }
  });
});

describe('client/renderPersona', () => {
  it('包含人格名与旋钮关键字段', () => {
    const out = renderPersona({
      name: '小雪',
      identity: '一个会陪你聊天的伙伴',
      warmth: 0.5,
      expressiveness: 0.5,
      volatility: 0.4,
      assertiveness: 0.3,
    });
    expect(out).toContain('小雪');
    expect(out).toContain('0.5');
    expect(out).toMatch(/暖|warmth/i);
  });
});

describe('client/renderBanner', () => {
  const base = {
    name: '小雪',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    memoryBackend: 'sqlite',
    warmth: 0.5,
    expressiveness: 0.5,
    volatility: 0.4,
    isFake: false,
  };

  it('含 provider/model/记忆/人格名与 /help 提示', () => {
    const b = renderBanner(base);
    expect(b).toContain('deepseek');
    expect(b).toContain('deepseek-v4-flash');
    expect(b).toContain('sqlite');
    expect(b).toContain('小雪');
    expect(b).toContain('/help');
  });

  it('真 provider 不含"配置真模型"引导', () => {
    const b = renderBanner(base);
    expect(b).not.toContain('.env.local');
  });

  it('fake provider 追加配置真模型引导', () => {
    const b = renderBanner({ ...base, provider: 'fake', model: 'fake-1', isFake: true });
    expect(b).toContain('.env.local');
    // 含切 Qwen 的引导线索
    expect(b.toLowerCase()).toContain('qwen');
  });
});
