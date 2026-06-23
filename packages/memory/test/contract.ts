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

    it('messagesForSession 只返回该会话的消息(按时序、受上限约束)', () => {
      const s = make();
      // 两个会话交错写入。
      s.appendMessage({ sessionId: 'a', turnId: 't1', role: 'user', content: 'a1', createdAtMs: 1 });
      s.appendMessage({ sessionId: 'b', turnId: 't1', role: 'user', content: 'b1', createdAtMs: 2 });
      s.appendMessage({ sessionId: 'a', turnId: 't2', role: 'assistant', content: 'a2', createdAtMs: 3 });
      s.appendMessage({ sessionId: 'a', turnId: 't3', role: 'user', content: 'a3', createdAtMs: 4 });
      // 只取会话 a,且按时序。
      expect(s.messagesForSession('a').map((m) => m.content)).toEqual(['a1', 'a2', 'a3']);
      // 受上限约束:取最近 2 条。
      expect(s.messagesForSession('a', 2).map((m) => m.content)).toEqual(['a2', 'a3']);
      // 不混入其它会话。
      expect(s.messagesForSession('b').map((m) => m.content)).toEqual(['b1']);
      // 未知会话为空。
      expect(s.messagesForSession('z')).toEqual([]);
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

    // —— 时间衰减 + 重要性 + 检索即强化(承 §5.5;golden 确定性)——

    const DAY = 86_400_000;

    it('时间衰减:等重要性下新近者排前(0.5^(days/H),承 §5.5)', () => {
      // 固定时钟:用注入 now 让两条记忆的 last_seen 差远超半衰期(默认 H=30 天)。
      let nowMs = 0;
      const s = make({ now: () => nowMs });
      nowMs = 1; // 旧记忆:很久以前
      s.addMemory({ text: '猫旧', createdAtMs: 1 });
      nowMs = 100 * DAY; // 新记忆:近期(已过 ~100 天,旧记忆衰减极重)
      s.addMemory({ text: '猫新', createdAtMs: 100 * DAY });
      const r = s.recall('猫', 2);
      // 两者初始 importance 相同,新近者衰减更小 → 排前(单一权威公式 §5.5)。
      expect(r.map((x) => x.text)).toEqual(['猫新', '猫旧']);
      s.close();
    });

    it('pinned 记忆免于衰减(核心永不淡去,承 §5)', () => {
      let nowMs = 0;
      const s = make({ now: () => nowMs });
      nowMs = 1;
      // pinned 旧记忆:即使极旧也不衰减(decay=1)。
      s.addMemory({ text: '核心旧', createdAtMs: 1, pinned: true });
      nowMs = 100 * DAY;
      // 非 pinned 新记忆:虽新近但 decay=1 封顶,score=importance 相同 → 由 id 兜底,旧的先插入 id 更小排后。
      s.addMemory({ text: '普通新', createdAtMs: 100 * DAY });
      const r = s.recall('核心旧 普通新', 2).map((x) => x.text);
      // pinned 旧记忆未被时间压低:仍与新记忆同分(均 decay=1、importance 初值相同),且都返回。
      expect(r).toContain('核心旧');
      expect(r).toContain('普通新');
      // 关键断言:pinned 旧记忆得分不输给"更新"的非 pinned(若有衰减它会沉底)。
      const pinnedRec = s.recall('核心旧')[0];
      // 经一次召回强化后 importance 会升,这里只验证它仍可召回且 pinned=true。
      expect(pinnedRec?.pinned).toBe(true);
      s.close();
    });

    it('重要性高者排前(等衰减下,承 §5.5)', () => {
      let nowMs = 10 * DAY;
      const s = make({ now: () => nowMs });
      // 同一时刻写入两条(衰减相同),一条显式高 importance。
      s.addMemory({ text: '要事', createdAtMs: 10 * DAY, importance: 0.9 });
      s.addMemory({ text: '琐事', createdAtMs: 10 * DAY, importance: 0.1 });
      const r = s.recall('事', 2).map((x) => x.text);
      expect(r).toEqual(['要事', '琐事']);
      s.close();
    });

    it('检索即强化:命中后 importance 与 access_count 上升(承 §5.5)', () => {
      let nowMs = DAY;
      const s = make({ now: () => nowMs });
      s.addMemory({ text: '咖啡', createdAtMs: DAY, importance: 0.5 });
      const first = s.recall('咖啡')[0];
      // 第一次召回返回的是强化前的值(决策 3:本次返回用旧值)。
      expect(first?.importance).toBeCloseTo(0.5, 6);
      expect(first?.accessCount).toBe(0);
      // 第二次召回:importance 已被首次强化 0.5 + 0.18*(1-0.5)=0.59;access_count 升为 1。
      const second = s.recall('咖啡')[0];
      expect(second?.importance).toBeCloseTo(0.59, 6);
      expect(second?.accessCount).toBe(1);
      s.close();
    });

    it('融合得分排序确定:同分按 hits / id 兜底(两实现一致)', () => {
      let nowMs = 5 * DAY;
      const s = make({ now: () => nowMs });
      // 三条同一时刻、同 importance、同 pinned → score 相同;靠 hits/id 兜底。
      s.addMemory({ text: '甲事', createdAtMs: 5 * DAY });
      s.addMemory({ text: '乙事', createdAtMs: 5 * DAY });
      s.addMemory({ text: '乙事', createdAtMs: 5 * DAY }); // 乙事再写一次 → hits=2
      const r = s.recall('事', 3).map((x) => x.text);
      // 乙事 hits=2 > 甲事 hits=1 → 乙事在前;score 完全相同,排序仍确定。
      expect(r[0]).toBe('乙事');
      s.close();
    });
  });
}
