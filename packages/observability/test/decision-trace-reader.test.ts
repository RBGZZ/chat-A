import { describe, it, expect, afterEach, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SqliteDecisionTraceSink,
  DecisionTraceReader,
  type DecisionTrace,
} from '../src/index';

const BASE: DecisionTrace = {
  correlationId: 's1/t1/0',
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  sessionId: 's1',
  turnId: 't1',
  createdAtMs: 1000,
  latencyMs: 42,
  userText: '速溶咖啡更好',
  recalled: [{ text: '用户喜欢猫', subject: 'person', hits: 2, kind: 'user_profile' }],
  emotion: 'content',
  pad: { pleasure: 0.3, arousal: 0.1, dominance: 0 },
  assertiveness: 0.8,
  stanceNotions: ['手冲比速溶值得。'],
  system: '[骨架]...\n\n[立场]...',
  messages: [{ role: 'user', content: '速溶咖啡更好' }],
  provider: 'fake',
  model: 'fake-1',
  reply: '我倒觉得手冲更值得。',
};

const tmpFiles: string[] = [];
function tmpDb(name: string): string {
  const p = join(tmpdir(), `chat-a-trace-reader-${process.pid}-${name}.db`);
  tmpFiles.push(p);
  return p;
}
afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(f + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
});

/** 写入若干 trace 后关闭 sink(WAL 落盘),供只读 reader 读取。 */
function seed(path: string, traces: DecisionTrace[]): void {
  const sink = new SqliteDecisionTraceSink({ path });
  for (const t of traces) sink.record(t);
  sink.close();
}

describe('DecisionTraceReader.listRecent', () => {
  it('写入几条后能查回,按时间倒序,limit 生效', () => {
    const path = tmpDb('list');
    seed(path, [
      { ...BASE, turnId: 't1', correlationId: 's1/t1/0', createdAtMs: 1000 },
      { ...BASE, turnId: 't2', correlationId: 's1/t2/0', createdAtMs: 2000 },
      { ...BASE, turnId: 't3', correlationId: 's1/t3/0', createdAtMs: 3000 },
    ]);
    const reader = new DecisionTraceReader({ path });
    const all = reader.listRecent();
    expect(all.map((r) => r.turnId)).toEqual(['t3', 't2', 't1']); // 倒序
    const limited = reader.listRecent({ limit: 2 });
    expect(limited.map((r) => r.turnId)).toEqual(['t3', 't2']);
    // 摘要含缝合键。
    expect(limited[0]?.correlationId).toBe('s1/t3/0');
    expect(limited[0]?.traceId).toBe('a'.repeat(32));
    reader.close();
  });

  it('按 sessionId 过滤只返回该会话', () => {
    const path = tmpDb('filter');
    seed(path, [
      { ...BASE, sessionId: 's1', turnId: 't1', correlationId: 's1/t1/0' },
      { ...BASE, sessionId: 's2', turnId: 't2', correlationId: 's2/t2/0' },
    ]);
    const reader = new DecisionTraceReader({ path });
    const s2 = reader.listRecent({ sessionId: 's2' });
    expect(s2.map((r) => r.turnId)).toEqual(['t2']);
    expect(s2.every((r) => r.sessionId === 's2')).toBe(true);
    reader.close();
  });

  it('userText/reply 超长被截断为摘要', () => {
    const path = tmpDb('summary');
    const long = '咖'.repeat(100);
    seed(path, [{ ...BASE, userText: long, reply: long }]);
    const reader = new DecisionTraceReader({ path });
    const [row] = reader.listRecent({ summaryChars: 10 });
    expect(row?.userTextSummary.endsWith('…')).toBe(true);
    expect(row?.userTextSummary.length).toBeLessThanOrEqual(11); // 10 + 省略号
    reader.close();
  });
});

describe('DecisionTraceReader.getBy*', () => {
  it('按 turnId 取回完整链,JSON 列解析正确、标量一致', () => {
    const path = tmpDb('get-turn');
    seed(path, [BASE]);
    const reader = new DecisionTraceReader({ path });
    const t = reader.getByTurnId('t1');
    expect(t).toBeDefined();
    expect(t?.correlationId).toBe('s1/t1/0');
    expect(t?.traceId).toBe('a'.repeat(32));
    expect(t?.spanId).toBe('b'.repeat(16));
    expect(t?.assertiveness).toBe(0.8);
    expect(t?.latencyMs).toBe(42);
    expect(t?.reply).toBe('我倒觉得手冲更值得。');
    // JSON 列解析回对象。
    expect(t?.recalled).toEqual([
      { text: '用户喜欢猫', subject: 'person', hits: 2, kind: 'user_profile' },
    ]);
    expect(t?.messages).toEqual([{ role: 'user', content: '速溶咖啡更好' }]);
    expect(t?.pad).toEqual({ pleasure: 0.3, arousal: 0.1, dominance: 0 });
    expect(t?.stanceNotions).toEqual(['手冲比速溶值得。']);
    reader.close();
  });

  it('按 correlationId / trace_id 也能取回同一回合', () => {
    const path = tmpDb('get-corr');
    seed(path, [BASE]);
    const reader = new DecisionTraceReader({ path });
    expect(reader.getByCorrelationId('s1/t1/0')?.turnId).toBe('t1');
    expect(reader.getByTraceId('a'.repeat(32))?.turnId).toBe('t1');
    reader.close();
  });

  it('未命中返回 undefined', () => {
    const path = tmpDb('miss');
    seed(path, [BASE]);
    const reader = new DecisionTraceReader({ path });
    expect(reader.getByTurnId('nope')).toBeUndefined();
    expect(reader.getByCorrelationId('nope')).toBeUndefined();
    reader.close();
  });

  it('可空列(无 traceId/spanId/pad/posture)还原时按条件展开省略', () => {
    const path = tmpDb('optional');
    const { traceId: _t, spanId: _s, pad: _p, ...rest } = BASE;
    void _t;
    void _s;
    void _p;
    seed(path, [{ ...rest, turnId: 'bare' }]);
    const reader = new DecisionTraceReader({ path });
    const t = reader.getByTurnId('bare');
    expect(t).toBeDefined();
    expect('traceId' in (t as object)).toBe(false);
    expect('spanId' in (t as object)).toBe(false);
    expect('pad' in (t as object)).toBe(false);
    expect('posture' in (t as object)).toBe(false);
    reader.close();
  });

  it('posture 往返:有则含,无则省略', () => {
    const path = tmpDb('posture');
    seed(path, [
      { ...BASE, turnId: 'sulk', posture: 'sulking' },
      { ...BASE, turnId: 'calm' },
    ]);
    const reader = new DecisionTraceReader({ path });
    expect(reader.getByTurnId('sulk')?.posture).toBe('sulking');
    const calm = reader.getByTurnId('calm');
    expect('posture' in (calm as object)).toBe(false);
    reader.close();
  });
});

describe('DecisionTraceReader 优雅降级', () => {
  it('库不存在:listRecent 返回 [],getBy* 返回 undefined,告警被调用', () => {
    const path = tmpDb('absent'); // 从不创建
    const onWarn = vi.fn();
    const reader = new DecisionTraceReader({ path, onWarn });
    expect(reader.listRecent()).toEqual([]);
    expect(reader.getByTurnId('t1')).toBeUndefined();
    expect(onWarn).toHaveBeenCalled(); // 至少打开失败时告警一次
    reader.close();
  });

  it('损坏库文件:不抛,降级为空 + 告警', () => {
    const path = tmpDb('corrupt');
    // 写入非 SQLite 内容制造损坏。
    writeFileSync(path, 'not a sqlite database at all');
    const onWarn = vi.fn();
    const reader = new DecisionTraceReader({ path, onWarn });
    expect(() => reader.listRecent()).not.toThrow();
    expect(reader.listRecent()).toEqual([]);
    expect(reader.getByTurnId('x')).toBeUndefined();
    expect(onWarn).toHaveBeenCalled();
    reader.close();
  });

  it('close 幂等,二次调用不抛', () => {
    const path = tmpDb('close');
    seed(path, [BASE]);
    const reader = new DecisionTraceReader({ path });
    reader.close();
    expect(() => reader.close()).not.toThrow();
  });
});
