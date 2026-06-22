import { describe, it, expect } from 'vitest';
import type { MemoryStore } from '../src/index';

/** 工厂:可注入时钟以做确定性排序断言。 */
export type MakeStore = (opts?: { now?: () => number }) => MemoryStore;

/**
 * MemoryStore 契约套件(§3.1):内存实现与 SQLite 实现跑同一套,重写实现用它验收。
 */
export function runMemoryStoreContract(name: string, make: MakeStore): void {
  describe(`MemoryStore 契约: ${name}`, () => {
    it('snapshot 返回最近 N 条消息(按时序)', () => {
      const s = make();
      for (let i = 1; i <= 5; i++) {
        s.appendMessage({
          sessionId: 's',
          turnId: `t${i}`,
          role: i % 2 === 1 ? 'user' : 'assistant',
          content: `m${i}`,
          createdAtMs: i,
        });
      }
      expect(s.snapshot(3).map((m) => m.content)).toEqual(['m3', 'm4', 'm5']);
      s.close();
    });

    it('addMemory 去重:等价文本只留一条并累加命中', () => {
      const s = make();
      s.addMemory({ text: '我叫小明' });
      s.addMemory({ text: '我叫小明' });
      s.addMemory({ text: '我爱猫' });
      const r = s.recall('小明');
      expect(r.length).toBe(1);
      expect(r[0]?.text).toBe('我叫小明');
      expect(r[0]?.hits).toBe(2);
      s.close();
    });

    it('recall 只返回命中关键词的记忆', () => {
      const s = make();
      s.addMemory({ text: '我喜欢喝咖啡' });
      s.addMemory({ text: '我养了一只狗' });
      expect(s.recall('咖啡').map((x) => x.text)).toEqual(['我喜欢喝咖啡']);
      s.close();
    });

    it('recall 受上限约束并按近因排序', () => {
      let t = 0;
      const s = make({ now: () => ++t });
      s.addMemory({ text: '猫A' });
      s.addMemory({ text: '猫B' });
      s.addMemory({ text: '猫C' });
      const r = s.recall('猫', 2);
      expect(r.length).toBe(2);
      expect(r.map((x) => x.text)).toEqual(['猫C', '猫B']);
      s.close();
    });

    it('空查询召回为空', () => {
      const s = make();
      s.addMemory({ text: '随便' });
      expect(s.recall('')).toEqual([]);
      s.close();
    });

    it('KV 读写:写入可读、同 key 覆盖、缺失为 undefined', () => {
      const s = make();
      expect(s.getState('k')).toBeUndefined();
      s.setState('k', 'v1');
      expect(s.getState('k')).toBe('v1');
      s.setState('k', 'v2');
      expect(s.getState('k')).toBe('v2');
      s.close();
    });
  });
}
