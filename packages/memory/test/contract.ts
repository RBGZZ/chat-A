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

    // —— 主语 + 人物归属(承 §5.3 / §5.3b)——

    it('写入默认归 person 主语 + 主用户(承 §5.3)', () => {
      const s = make();
      s.addMemory({ text: '我喜欢喝咖啡' });
      const r = s.recall('咖啡');
      expect(r.length).toBe(1);
      expect(r[0]?.subject).toBe('person');
      // 默认主用户 id 为内置默认 'primary'(行为即配置,§3.2)。
      expect(r[0]?.personId).toBe('primary');
      s.close();
    });

    it('显式 agent / shared 主语写入与召回(承 §5.3)', () => {
      const s = make();
      s.addMemory({ text: '小雪喜欢下雪天', subject: 'agent' });
      s.addMemory({ text: '我们一起看过烟花', subject: 'shared' });
      const agent = s.recall('小雪');
      expect(agent[0]?.subject).toBe('agent');
      // agent 主语不关联人物(§5.3b)。
      expect(agent[0]?.personId).toBeUndefined();
      const shared = s.recall('烟花');
      expect(shared[0]?.subject).toBe('shared');
      // shared 默认归主用户。
      expect(shared[0]?.personId).toBe('primary');
      s.close();
    });

    it('一次召回跨三类主语,各带正确 subject 标签(承 §5.3 末条)', () => {
      let t = 0;
      const s = make({ now: () => ++t });
      // 三条都命中关键词「记忆」,分属 person / agent / shared。
      s.addMemory({ text: '关于我的记忆A', subject: 'person' });
      s.addMemory({ text: '关于小雪自己的记忆B', subject: 'agent' });
      s.addMemory({ text: '我们共同的记忆C', subject: 'shared' });
      const r = s.recall('记忆', 10);
      const subjects = r.map((x) => x.subject).sort();
      expect(subjects).toEqual(['agent', 'person', 'shared']);
      // 不因主语被过滤:三类齐全。
      expect(r.length).toBe(3);
      s.close();
    });

    it('显式 personId 写入被保留;agent 忽略 personId(承 §5.3b)', () => {
      const s = make();
      s.addMemory({ text: '访客阿强的事', subject: 'person', personId: 'guest-1' });
      s.addMemory({ text: '小雪的自我设定', subject: 'agent', personId: 'guest-1' });
      expect(s.recall('阿强')[0]?.personId).toBe('guest-1');
      // agent 主语无视传入 personId,恒不关联人。
      expect(s.recall('自我设定')[0]?.personId).toBeUndefined();
      s.close();
    });
  });
}
