import { describe, it, expect } from 'vitest';
import { HashEmbedder } from '../src/index';

describe('HashEmbedder(确定性 Hash 兜底)', () => {
  it('同输入 → 同向量(确定性,可复现)', async () => {
    const e = new HashEmbedder();
    const [a] = await e.embed(['小雪你好,今天天气真好']);
    const [b] = await e.embed(['小雪你好,今天天气真好']);
    expect(a).toEqual(b);
  });

  it('维度正确(默认 384,且每个向量长度 == dimension)', async () => {
    const e = new HashEmbedder();
    expect(e.dimension).toBe(384);
    const vecs = await e.embed(['一', '二', '三']);
    expect(vecs).toHaveLength(3);
    for (const v of vecs) expect(v).toHaveLength(384);
  });

  it('维度可配', async () => {
    const e = new HashEmbedder({ dimension: 64 });
    expect(e.dimension).toBe(64);
    const [v] = await e.embed(['hello world']);
    expect(v).toHaveLength(64);
  });

  it('不同输入 → 不同向量', async () => {
    const e = new HashEmbedder({ dimension: 128 });
    const [a] = await e.embed(['今天去公园散步']);
    const [b] = await e.embed(['明天要交项目报告']);
    expect(a).not.toEqual(b);
  });

  it('输出 L2 归一化(范数 ≈ 1),空文本退化为零向量', async () => {
    const e = new HashEmbedder({ dimension: 32 });
    const [v, zero] = await e.embed(['有内容的文本', '']);
    const norm = Math.sqrt(v!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
    // 空文本无 token → 零向量(归一化不除零)。
    expect(zero!.every((x) => x === 0)).toBe(true);
  });

  it('空输入 → 空数组', async () => {
    const e = new HashEmbedder();
    expect(await e.embed([])).toEqual([]);
  });

  it('非法维度抛错', () => {
    expect(() => new HashEmbedder({ dimension: 0 })).toThrow();
    expect(() => new HashEmbedder({ dimension: -4 })).toThrow();
    expect(() => new HashEmbedder({ dimension: 1.5 })).toThrow();
  });

  it('id/name 为 trace 标识', () => {
    const e = new HashEmbedder();
    expect(e.id).toBe('hash');
    expect(e.name).toBe('local-hash-v1');
  });
});
