import { describe, it, expect } from 'vitest';
import { createUnitConvertAction } from '../src/index';

const conv = createUnitConvertAction();

describe('interaction/unit_convert', () => {
  it('长度同量纲换算', async () => {
    const r = await conv.perform({ value: 1000, from: 'm', to: 'km' });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('= 1 km');
  });

  it('质量同量纲换算', async () => {
    const r = await conv.perform({ value: 2, from: 'kg', to: 'g' });
    expect(r.content).toContain('= 2000 g');
  });

  it('温度换算(华氏→摄氏)', async () => {
    const r = await conv.perform({ value: 212, from: 'f', to: 'c' });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('= 100 c');
  });

  it('单位大小写不敏感', async () => {
    const r = await conv.perform({ value: 1, from: 'KM', to: 'M' });
    expect(r.content).toContain('= 1000 m');
  });

  it('未知单位 → isError', async () => {
    const r = await conv.perform({ value: 1, from: 'furlong', to: 'm' });
    expect(r.isError).toBe(true);
  });

  it('跨量纲 → isError', async () => {
    const r = await conv.perform({ value: 1, from: 'm', to: 'kg' });
    expect(r.isError).toBe(true);
  });

  it('value 非数字 → isError', async () => {
    const r = await conv.perform({ value: 'x', from: 'm', to: 'km' });
    expect(r.isError).toBe(true);
  });
});
