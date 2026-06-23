import { describe, it, expect } from 'vitest';
import type { ToolCall } from '@chat-a/protocol';
import {
  ActionRegistry,
  buildDefaultRegistry,
  createCurrentTimeAction,
  createDateDiffAction,
  type Action,
} from '../src/index';

const call = (name: string, input: unknown = {}, id = 'c1'): ToolCall => ({ id, name, input });

describe('interaction/current_time', () => {
  it('注入时钟 → 确定性 ISO', async () => {
    const fixed = new Date('2026-06-23T08:00:00.000Z');
    const r = await createCurrentTimeAction(() => fixed).perform({});
    expect(r.content).toBe('2026-06-23T08:00:00.000Z');
    expect(r.isError).toBeUndefined();
  });
});

describe('interaction/ActionRegistry 容错执行', () => {
  it('已知工具成功 → toolCallId 对齐、非 error', async () => {
    const reg = new ActionRegistry().register({
      name: 'ping',
      description: 'p',
      inputSchema: { type: 'object', properties: {}, required: [] },
      perform: () => Promise.resolve({ content: 'pong' }),
    });
    const res = await reg.execute(call('ping', {}, 'x1'));
    expect(res).toEqual({ toolCallId: 'x1', content: 'pong' });
  });

  it('未知工具 → isError 不抛', async () => {
    const res = await new ActionRegistry().execute(call('nope'));
    expect(res.isError).toBe(true);
    expect(res.toolCallId).toBe('c1');
  });

  it('perform 抛错 → 收敛为 isError 不抛', async () => {
    const boom: Action = {
      name: 'boom',
      description: 'b',
      inputSchema: { type: 'object', properties: {}, required: [] },
      perform: () => Promise.reject(new Error('炸了')),
    };
    const res = await new ActionRegistry().register(boom).execute(call('boom'));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('炸了');
  });

  it('缺必填字段 → isError(轻量校验)', async () => {
    const reg = new ActionRegistry().register({
      name: 'greet',
      description: 'g',
      inputSchema: { type: 'object', properties: { who: { type: 'string' } }, required: ['who'] },
      perform: (i) => Promise.resolve({ content: `hi ${(i as { who: string }).who}` }),
    });
    const res = await reg.execute(call('greet', {}));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('who');
  });

  it('字段类型不符 → isError', async () => {
    const reg = new ActionRegistry().register({
      name: 'n',
      description: 'n',
      inputSchema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
      perform: () => Promise.resolve({ content: 'ok' }),
    });
    const res = await reg.execute(call('n', { x: 'not-a-number' }));
    expect(res.isError).toBe(true);
  });

  it('toolDefs 形态 + size(含全部内置动作)', () => {
    const reg = buildDefaultRegistry();
    expect(reg.size).toBe(8);
    const names = reg.toolDefs().map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'current_time',
        'calculate',
        'set_reminder',
        'unit_convert',
        'date_diff',
        'list_reminders',
        'recall_fact',
        'countdown',
      ]),
    );
    expect(reg.toolDefs()[0]?.inputSchema).toBeDefined();
  });
});

describe('interaction/buildDefaultRegistry 能力标注 + 能力门(§12.2)', () => {
  it('list_reminders 与 set_reminder 共享 store:写入后可读', async () => {
    const reg = buildDefaultRegistry();
    await reg.execute(call('set_reminder', { text: '买菜' }, 's1'));
    const res = await reg.execute(call('list_reminders', {}, 'l1'));
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain('买菜');
  });

  it('注入 factLookup 经 recall_fact 命中', async () => {
    const reg = buildDefaultRegistry({ factLookup: (q) => (q === 'k' ? 'v' : undefined) });
    const res = await reg.execute(call('recall_fact', { query: 'k' }, 'r1'));
    expect(res.content).toBe('v');
  });

  it('空能力集 new Set():仅纯计算动作可见(时间域被隐藏)', () => {
    const reg = buildDefaultRegistry().withCapabilities(new Set<string>());
    const names = reg.toolDefs().map((d) => d.name).sort();
    expect(names).toEqual(['calculate', 'date_diff', 'recall_fact', 'unit_convert'].sort());
    expect(names).not.toContain('current_time');
    expect(names).not.toContain('list_reminders');
    expect(names).not.toContain('countdown');
  });

  it('能力集 {time}:时间域动作恢复可见', () => {
    const reg = buildDefaultRegistry().withCapabilities(new Set(['time']));
    const names = reg.toolDefs().map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining(['current_time', 'set_reminder', 'list_reminders', 'countdown']),
    );
  });
});

describe('interaction/date_diff(确定性日期相差)', () => {
  it('正例:相差天数', async () => {
    const reg = new ActionRegistry().register(createDateDiffAction());
    const res = await reg.execute(call('date_diff', { from: '2026-06-20', to: '2026-06-23' }));
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain('3 天');
  });

  it('负差:to 早于 from', async () => {
    const res = await createDateDiffAction().perform({ from: '2026-06-23', to: '2026-06-20' });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain('-3 天');
  });

  it('反例:不可解析日期 → isError 不抛', async () => {
    const res = await createDateDiffAction().perform({ from: 'not-a-date', to: '2026-06-23' });
    expect(res.isError).toBe(true);
  });

  it('date_diff 不声明 capability(纯计算)', () => {
    expect(createDateDiffAction().capability).toBeUndefined();
  });
});

// 仅用于能力门测试:声明 audio 能力的动作。
const audioAction: Action = {
  name: 'play_sound',
  description: '播放声音',
  inputSchema: { type: 'object', properties: {}, required: [] },
  capability: 'audio',
  perform: () => Promise.resolve({ content: 'beep' }),
};

describe('interaction/ActionRegistry 能力门(§12.2)', () => {
  it('缺省(无能力集)= 全部可用:toolDefs 含需能力动作', () => {
    const reg = new ActionRegistry().register(createDateDiffAction()).register(audioAction);
    const names = reg.toolDefs().map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(['date_diff', 'play_sound']));
  });

  it('缺省下需能力动作正常执行(向后兼容)', async () => {
    const reg = new ActionRegistry().register(audioAction);
    const res = await reg.execute(call('play_sound', {}, 'a1'));
    expect(res).toEqual({ toolCallId: 'a1', content: 'beep' });
  });

  it('配能力集 {time}:toolDefs 隐藏未授权动作', () => {
    const reg = new ActionRegistry(new Set(['time']))
      .register(createDateDiffAction()) // 无 capability → 始终授权
      .register(audioAction); // 需 audio → 未授权
    const names = reg.toolDefs().map((d) => d.name);
    expect(names).toContain('date_diff');
    expect(names).not.toContain('play_sound');
  });

  it('未授权动作 execute → isError 不抛、不调 perform、toolCallId 对齐', async () => {
    let performed = false;
    const spyAudio: Action = {
      ...audioAction,
      perform: () => {
        performed = true;
        return Promise.resolve({ content: 'beep' });
      },
    };
    const reg = new ActionRegistry(new Set(['time'])).register(spyAudio);
    const res = await reg.execute(call('play_sound', {}, 'p1'));
    expect(res.isError).toBe(true);
    expect(res.toolCallId).toBe('p1');
    expect(res.content).toContain('audio'); // 错误说明含缺失能力,可追溯
    expect(performed).toBe(false); // perform 未被调用
  });

  it('授权动作(能力在集内)正常执行', async () => {
    const reg = new ActionRegistry(new Set(['audio'])).register(audioAction);
    const res = await reg.execute(call('play_sound', {}, 'ok1'));
    expect(res).toEqual({ toolCallId: 'ok1', content: 'beep' });
  });

  it('空能力集:仅无 capability 的动作可用', () => {
    const reg = new ActionRegistry(new Set<string>())
      .register(createDateDiffAction())
      .register(audioAction);
    const names = reg.toolDefs().map((d) => d.name);
    expect(names).toEqual(['date_diff']);
  });

  it('withCapabilities 更新能力集 → 过滤随之变化', async () => {
    const reg = new ActionRegistry(new Set(['time'])).register(audioAction);
    expect(reg.toolDefs().map((d) => d.name)).not.toContain('play_sound');
    reg.withCapabilities(new Set(['audio']));
    expect(reg.toolDefs().map((d) => d.name)).toContain('play_sound');
    const res = await reg.execute(call('play_sound', {}, 'w1'));
    expect(res).toEqual({ toolCallId: 'w1', content: 'beep' });
  });

  it('未知工具仍优先于未授权判定(可区分错误)', async () => {
    const reg = new ActionRegistry(new Set(['time']));
    const res = await reg.execute(call('ghost', {}, 'g1'));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('未知工具');
  });
});
