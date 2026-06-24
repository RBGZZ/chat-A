import { describe, it, expect } from 'vitest';
import type { ToolCall } from '@chat-a/protocol';
import {
  ActionRegistry,
  TaskExecutor,
  CollectingPublisher,
  type Action,
} from '../src/index';

const call = (name: string, input: unknown = {}, id = 'c1'): ToolCall => ({ id, name, input });

const okAction = (name: string, content = 'done'): Action => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {}, required: [] },
  perform: () => Promise.resolve({ content }),
});

/** 可挂起的动作:perform 在外部 resolve 前不返回(测单飞行/取消)。 */
function makeGatedAction(name: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let started = 0;
  const action: Action = {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {}, required: [] },
    perform: async () => {
      started += 1;
      await gate;
      return { content: 'late' };
    },
  };
  return { action, release, startedCount: () => started };
}

describe('task-executor/总线序列', () => {
  it('成功:action:started → action:completed(带 content 回灌)', async () => {
    const pub = new CollectingPublisher('cid-1');
    const reg = new ActionRegistry().register(okAction('greet', 'hi'));
    const exec = new TaskExecutor(reg, { publisher: pub });
    const { result, cancelled } = await exec.execute(call('greet', {}, 'g1'));
    expect(cancelled).toBe(false);
    expect(result).toEqual({ toolCallId: 'g1', content: 'hi' });
    const actions = pub.events.map((e) => e.action);
    expect(actions).toEqual(['action:started', 'action:completed']);
    expect(pub.byAction('action:completed')[0]!.data).toMatchObject({
      name: 'greet',
      toolCallId: 'g1',
      content: 'hi',
    });
    expect(pub.events.every((e) => e.correlationId === 'cid-1')).toBe(true);
  });

  it('动作返回 isError → action:started → action:failed', async () => {
    const pub = new CollectingPublisher('cid-2');
    const reg = new ActionRegistry(); // 未注册 → execute 容错返回 isError
    const exec = new TaskExecutor(reg, { publisher: pub });
    const { result } = await exec.execute(call('nope', {}, 'n1'));
    expect(result.isError).toBe(true);
    expect(pub.events.map((e) => e.action)).toEqual(['action:started', 'action:failed']);
  });
});

describe('task-executor/单飞行', () => {
  it('同名动作在飞时第二次被拒绝(不抢占)', async () => {
    const pub = new CollectingPublisher();
    const gated = makeGatedAction('slow');
    const reg = new ActionRegistry().register(gated.action);
    const exec = new TaskExecutor(reg, { publisher: pub });

    const p1 = exec.execute(call('slow', {}, 'a'));
    expect(exec.isInflight('slow')).toBe(true);
    const r2 = await exec.execute(call('slow', {}, 'b')); // 第二次:拒绝
    expect(r2.result.isError).toBe(true);
    expect(r2.result.content).toContain('单飞行');

    gated.release();
    const r1 = await p1;
    expect(r1.result.content).toBe('late');
    expect(gated.startedCount()).toBe(1); // 第二次未真正 perform
    expect(exec.isInflight('slow')).toBe(false);
  });
});

describe('task-executor/取消(打断回滚,承 §4 AbortSignal)', () => {
  it('执行中 abort → 返回 cancelled、发 action:failed{cancelled}、不采纳动作结果', async () => {
    const pub = new CollectingPublisher('cid-x');
    const gated = makeGatedAction('long');
    const reg = new ActionRegistry().register(gated.action);
    const exec = new TaskExecutor(reg, { publisher: pub });

    const controller = new AbortController();
    const p = exec.execute(call('long', {}, 'L1'), controller.signal);
    controller.abort(); // 打断
    const { result, cancelled } = await p;
    expect(cancelled).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('打断');
    const failed = pub.byAction('action:failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.data).toMatchObject({ cancelled: true });
    // 释放底层(后台动作了结,不影响已回滚的回合)。
    gated.release();
  });

  it('cancel(name) 主动取消在飞动作', async () => {
    const pub = new CollectingPublisher();
    const gated = makeGatedAction('job');
    const reg = new ActionRegistry().register(gated.action);
    const exec = new TaskExecutor(reg, { publisher: pub });
    const p = exec.execute(call('job', {}, 'J1'));
    exec.cancel('job');
    const { cancelled } = await p;
    expect(cancelled).toBe(true);
    gated.release();
  });

  it('预先 aborted 的 signal → 立即取消', async () => {
    const reg = new ActionRegistry().register(okAction('x'));
    const exec = new TaskExecutor(reg);
    const { cancelled } = await exec.execute(call('x', {}, 'X1'), AbortSignal.abort());
    expect(cancelled).toBe(true);
  });
});

describe('task-executor/优雅降级:无 publisher 也能执行(standalone)', () => {
  it('不注入 publisher → 不抛、正常返回结果', async () => {
    const reg = new ActionRegistry().register(okAction('p', 'ok'));
    const exec = new TaskExecutor(reg);
    const { result } = await exec.execute(call('p', {}, 'p1'));
    expect(result.content).toBe('ok');
  });
});
