import { describe, it, expect } from 'vitest';
import { createCalculateAction } from '../src/index';

const calc = createCalculateAction();

describe('interaction/calculate', () => {
  it('expression 形态按优先级求值', async () => {
    const r = await calc.perform({ expression: '3 + 4 * 2' });
    expect(r.content).toBe('11');
    expect(r.isError).toBeUndefined();
  });

  it('expression 支持括号与负号', async () => {
    expect((await calc.perform({ expression: '(1 + 2) * 3' })).content).toBe('9');
    expect((await calc.perform({ expression: '-5 + 2' })).content).toBe('-3');
    expect((await calc.perform({ expression: '2.5 * 4' })).content).toBe('10');
  });

  it('结构化形态求值', async () => {
    expect((await calc.perform({ a: 6, op: '/', b: 3 })).content).toBe('2');
    expect((await calc.perform({ a: 7, op: '-', b: 10 })).content).toBe('-3');
  });

  it('除以零(表达式)→ isError 不抛', async () => {
    const r = await calc.perform({ expression: '5 / 0' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('除');
  });

  it('除以零(结构化)→ isError', async () => {
    const r = await calc.perform({ a: 1, op: '/', b: 0 });
    expect(r.isError).toBe(true);
  });

  it('非法表达式 → isError 不抛', async () => {
    expect((await calc.perform({ expression: '3 + ' })).isError).toBe(true);
    expect((await calc.perform({ expression: '3 # 4' })).isError).toBe(true);
    expect((await calc.perform({ expression: '(1 + 2' })).isError).toBe(true);
  });

  it('结构化 op 非法 → isError', async () => {
    const r = await calc.perform({ a: 1, op: '%', b: 2 });
    expect(r.isError).toBe(true);
  });

  it('两形态都不满足 → isError', async () => {
    const r = await calc.perform({});
    expect(r.isError).toBe(true);
  });
});
