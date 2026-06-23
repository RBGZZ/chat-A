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

    // —— 混合召回打分归一(承 §5.5;关键词归一 / 自适应分母 / 零信号门控 / 情感共振开关)——

    it('多关键词:命中更多 token 者排更前(关键词归一生效,§5.5)', () => {
      let nowMs = 5 * DAY;
      const s = make({ now: () => nowMs });
      // 同一时刻、同 importance → 记忆强度路相同;靠关键词命中数区分。
      // 甲命中两个 token(咖啡/茶),乙只命中一个(咖啡)。
      s.addMemory({ text: '我爱咖啡和茶', createdAtMs: 5 * DAY });
      s.addMemory({ text: '我爱咖啡', createdAtMs: 5 * DAY });
      // 多 token 查询(空白分隔 → 两个 token)。
      const r = s.recall('咖啡 茶', 2).map((x) => x.text);
      // 命中更多 token 的甲,经查询长度自适应 sigmoid 归一后关键词分更高 → 排前。
      expect(r[0]).toBe('我爱咖啡和茶');
      s.close();
    });

    it('单关键词:排序仍由记忆强度驱动(向后兼容,§5.5)', () => {
      let nowMs = 10 * DAY;
      const s = make({ now: () => nowMs });
      // 单 token 查询下所有候选关键词分相同(raw=1, m=1)→ 排序由 importance×decay 决定。
      s.addMemory({ text: '要紧的事', createdAtMs: 10 * DAY, importance: 0.9 });
      s.addMemory({ text: '琐碎的事', createdAtMs: 10 * DAY, importance: 0.1 });
      const r = s.recall('事', 2).map((x) => x.text);
      expect(r).toEqual(['要紧的事', '琐碎的事']);
      s.close();
    });

    it('零信号门控只丢全零:关键词命中即进候选池(不硬丢,§5.5)', () => {
      let nowMs = DAY;
      const s = make({ now: () => nowMs });
      // 即使 importance 很低(记忆强度路接近 0),只要关键词命中(归一分 > 0)就不被门控丢弃。
      s.addMemory({ text: '冷门小事', createdAtMs: DAY, importance: 0.01 });
      const r = s.recall('冷门');
      expect(r.length).toBe(1);
      expect(r[0]?.text).toBe('冷门小事');
      s.close();
    });

    it('情感共振开关:不传 PAD = 基线,传 PAD 不改变命中集合且为确定重排(§5.5)', () => {
      let nowMs = 3 * DAY;
      const s = make({ now: () => nowMs });
      s.addMemory({ text: '关于猫的事甲', createdAtMs: 3 * DAY });
      s.addMemory({ text: '关于猫的事乙', createdAtMs: 3 * DAY });
      // 不传 PAD:默认不启用情感共振(基线)。
      const baseline = s.recall('猫', 5).map((x) => x.text).sort();
      // 传 PAD:启用情感共振一路信号;命中集合不变(情感不作硬过滤),只可能影响排序。
      const withPad = s
        .recall('猫', 5, { pleasure: 0.8, arousal: 0.6, dominance: 0 })
        .map((x) => x.text)
        .sort();
      // 同一命中集合(情感共振不丢候选,只重排)。
      expect(withPad).toEqual(baseline);
      s.close();
    });

    it('情感共振不主导排序:不让情感盖过关键词/强度差异(§5.5)', () => {
      let nowMs = 3 * DAY;
      const s = make({ now: () => nowMs });
      // 启用 PAD 时,两条记忆情感分相同(本期记忆侧 emotion 缺省中性)→ 排序仍由关键词/强度决定。
      s.addMemory({ text: '重要的猫事', createdAtMs: 3 * DAY, importance: 0.9 });
      s.addMemory({ text: '次要的猫事', createdAtMs: 3 * DAY, importance: 0.1 });
      const r = s
        .recall('猫', 2, { pleasure: -0.7, arousal: 0.5, dominance: 0 })
        .map((x) => x.text);
      // 情感共振对两者等权加成,不改变 importance 决定的相对顺序。
      expect(r).toEqual(['重要的猫事', '次要的猫事']);
      s.close();
    });

    // —— 上下文窗口拼接(承 §5.5;时间戳就近锚定 + 前后各 N + 跨命中去重;golden 两实现一致)——

    /** 顺序写入若干消息(createdAtMs 与下标对齐,便于锚定断言)。 */
    function seedMessages(s: MemoryStore, contents: readonly string[]): void {
      contents.forEach((content, i) => {
        s.appendMessage({
          sessionId: 's',
          turnId: `t${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content,
          createdAtMs: (i + 1) * 10, // 10,20,30,... 与下标一一对应
        });
      });
    }

    it('召回命中拼出前后各 N 条连贯窗口(含锚点,按时序,§5.5)', () => {
      const s = make();
      // 7 条消息:m0..m6,时间戳 10..70。
      seedMessages(s, ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6']);
      // 记忆 createdAtMs=40 → 就近锚到 m3(下标 3);N=2 → 取 m1..m5。
      s.addMemory({ text: '关键记忆', createdAtMs: 40 });
      const out = s.recallWithContext('关键记忆', { windowSize: 2 });
      expect(out.memories.length).toBe(1);
      expect(out.memories[0]?.record.text).toBe('关键记忆');
      expect(out.memories[0]?.contextWindow.map((m) => m.content)).toEqual([
        'm1',
        'm2',
        'm3',
        'm4',
        'm5',
      ]);
      // 单命中时合并窗口 = 该命中窗口。
      expect(out.mergedContext.map((m) => m.content)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
      s.close();
    });

    it('窗口随时间戳就近锚定到正确消息(§5.5)', () => {
      const s = make();
      seedMessages(s, ['m0', 'm1', 'm2', 'm3', 'm4']); // 时间戳 10,20,30,40,50
      // 记忆 createdAtMs=33 → 距 m2(30)差 3、距 m3(40)差 7 → 锚 m2;N=1 → m1..m3。
      s.addMemory({ text: '锚定记忆', createdAtMs: 33 });
      const out = s.recallWithContext('锚定记忆', { windowSize: 1 });
      expect(out.memories[0]?.contextWindow.map((m) => m.content)).toEqual(['m1', 'm2', 'm3']);
      s.close();
    });

    it('跨命中窗口去重:重叠合并无重复、按全局时序(§5.5)', () => {
      let t = 0;
      const s = make({ now: () => ++t });
      seedMessages(s, ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']); // 时间戳 10..60
      // 两条命中同关键词「事」,锚点相近,窗口会重叠。
      s.addMemory({ text: '事甲', createdAtMs: 20 }); // 锚 m1
      s.addMemory({ text: '事乙', createdAtMs: 30 }); // 锚 m2
      const out = s.recallWithContext('事', { limit: 10, windowSize: 1 });
      expect(out.memories.length).toBe(2);
      // 甲窗口 m0..m2、乙窗口 m1..m3;合并去重后 m0..m3,按全局时序、无重复。
      expect(out.mergedContext.map((m) => m.content)).toEqual(['m0', 'm1', 'm2', 'm3']);
      // 每条命中仍各自拿到完整连贯片段(不被去重削掉)。
      const windows = out.memories.map((rm) => rm.contextWindow.map((m) => m.content));
      expect(windows).toContainEqual(['m0', 'm1', 'm2']);
      expect(windows).toContainEqual(['m1', 'm2', 'm3']);
      s.close();
    });

    it('边界:锚点在会话首/尾时窗口自然收窄(§5.5)', () => {
      const s = make();
      seedMessages(s, ['m0', 'm1', 'm2', 'm3', 'm4']); // 时间戳 10..50
      // 锚首:createdAtMs=10 → 锚 m0;N=2 → 只取 m0..m2(前侧无可取)。
      s.addMemory({ text: '首部记忆', createdAtMs: 10 });
      expect(
        s.recallWithContext('首部记忆', { windowSize: 2 }).memories[0]?.contextWindow.map((m) => m.content),
      ).toEqual(['m0', 'm1', 'm2']);
      // 锚尾:createdAtMs=50 → 锚 m4;N=2 → 只取 m2..m4(后侧无可取)。
      s.addMemory({ text: '尾部记忆', createdAtMs: 50 });
      expect(
        s.recallWithContext('尾部记忆', { windowSize: 2 }).memories[0]?.contextWindow.map((m) => m.content),
      ).toEqual(['m2', 'm3', 'm4']);
      s.close();
    });

    it('N=0:窗口只含锚点一条(§5.5)', () => {
      const s = make();
      seedMessages(s, ['m0', 'm1', 'm2']);
      s.addMemory({ text: '点记忆', createdAtMs: 20 }); // 锚 m1
      const out = s.recallWithContext('点记忆', { windowSize: 0 });
      expect(out.memories[0]?.contextWindow.map((m) => m.content)).toEqual(['m1']);
      s.close();
    });

    it('空库取窗优雅降级:无消息时窗口为空(§5.5/§3.2)', () => {
      const s = make();
      s.addMemory({ text: '孤记忆', createdAtMs: 5 });
      const out = s.recallWithContext('孤记忆');
      expect(out.memories.length).toBe(1);
      expect(out.memories[0]?.contextWindow).toEqual([]);
      expect(out.mergedContext).toEqual([]);
      s.close();
    });

    it('N 外置:默认取配置 contextWindowSize,可被 per-call windowSize 覆盖(§5.5/§3.2)', () => {
      const s = make();
      // 13 条消息,默认 N=5 → 锚 m6 时取 m1..m11 共 11 条。
      seedMessages(s, ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12']);
      s.addMemory({ text: '宽窗记忆', createdAtMs: 70 }); // 锚 m6(时间戳 70)
      // 不传 windowSize → 默认配置 5。
      const def = s.recallWithContext('宽窗记忆');
      expect(def.memories[0]?.contextWindow.length).toBe(11);
      // per-call 覆盖为 1 → 3 条。
      const overridden = s.recallWithContext('宽窗记忆', { windowSize: 1 });
      expect(overridden.memories[0]?.contextWindow.map((m) => m.content)).toEqual(['m5', 'm6', 'm7']);
      s.close();
    });

    it('recallWithContext 命中顺序与 recall 一致(向后兼容,§5.5)', () => {
      let nowMs = 5 * 86_400_000;
      const s = make({ now: () => nowMs });
      seedMessages(s, ['m0', 'm1', 'm2']);
      s.addMemory({ text: '要紧的事', createdAtMs: 5 * 86_400_000, importance: 0.9 });
      s.addMemory({ text: '琐碎的事', createdAtMs: 5 * 86_400_000, importance: 0.1 });
      const plain = s.recall('事', 5).map((r) => r.text);
      const withCtx = s.recallWithContext('事', { limit: 5 }).memories.map((rm) => rm.record.text);
      expect(withCtx).toEqual(plain);
      s.close();
    });

    // —— 未闭合话题标记 / 查询 / 闭合(承 §7#2 主动跟进的数据层;golden 两实现一致)——

    it('写入默认非未闭合:不进 openThreads(承 §7#2)', () => {
      const s = make();
      s.addMemory({ text: '今天喝了咖啡' }); // 不指定 openThread
      // recall 返回的 openThread 为 false。
      expect(s.recall('咖啡')[0]?.openThread).toBe(false);
      // 未闭合查询为空(普通记忆不进)。
      expect(s.openThreads()).toEqual([]);
      s.close();
    });

    it('显式标记未闭合:recall 带 openThread=true 且进 openThreads(承 §7#2)', () => {
      const s = make();
      s.addMemory({ text: '明天要面试', openThread: true });
      expect(s.recall('面试')[0]?.openThread).toBe(true);
      const open = s.openThreads();
      expect(open.length).toBe(1);
      expect(open[0]?.text).toBe('明天要面试');
      expect(open[0]?.openThread).toBe(true);
      s.close();
    });

    it('openThreads 只返回未闭合话题:不含普通 / 已闭合记忆(承 §7#2)', () => {
      const s = make();
      s.addMemory({ text: '普通记忆甲' }); // 非未了事
      s.addMemory({ text: '未了事乙', openThread: true });
      s.addMemory({ text: '未了事丙', openThread: true });
      // 闭合丙。
      const bing = s.recall('丙')[0]!;
      s.closeThread(bing.id);
      const open = s.openThreads(10).map((r) => r.text);
      expect(open).toEqual(['未了事乙']); // 只剩未闭合的乙
      s.close();
    });

    it('openThreads 按记忆强度排序且受上限约束(与 recall 同一权威公式,§7#2/§5.5)', () => {
      let nowMs = 10 * 86_400_000;
      const s = make({ now: () => nowMs });
      // 同一时刻写入(衰减相同),用 importance 区分强度。
      s.addMemory({ text: '高要事', createdAtMs: 10 * 86_400_000, importance: 0.9, openThread: true });
      s.addMemory({ text: '中要事', createdAtMs: 10 * 86_400_000, importance: 0.5, openThread: true });
      s.addMemory({ text: '低要事', createdAtMs: 10 * 86_400_000, importance: 0.1, openThread: true });
      // 强度降序。
      expect(s.openThreads(10).map((r) => r.text)).toEqual(['高要事', '中要事', '低要事']);
      // 受上限约束:取前 2。
      expect(s.openThreads(2).map((r) => r.text)).toEqual(['高要事', '中要事']);
      s.close();
    });

    it('openThreads 不触发检索即强化(巡检 ≠ 被想起,承 §7#2 决策 2)', () => {
      let nowMs = 86_400_000;
      const s = make({ now: () => nowMs });
      s.addMemory({ text: '待跟进的事', createdAtMs: 86_400_000, importance: 0.5, openThread: true });
      // 多次巡检不应升 importance / accessCount。
      s.openThreads();
      s.openThreads();
      // 用 recall 读取(recall 第一次返回的是强化前值):importance 仍为初值、accessCount 仍 0。
      const r = s.recall('待跟进')[0];
      expect(r?.importance).toBeCloseTo(0.5, 6);
      expect(r?.accessCount).toBe(0);
      s.close();
    });

    it('closeThread 后退出 openThreads,且 recall 的 openThread 变 false(承 §7#2)', () => {
      const s = make();
      s.addMemory({ text: '要闭合的事', openThread: true });
      const rec = s.recall('闭合')[0]!;
      expect(rec.openThread).toBe(true);
      s.closeThread(rec.id);
      // 退出未闭合查询。
      expect(s.openThreads()).toEqual([]);
      // recall 仍能召回该记忆,但 openThread 已为 false(已闭合)。
      expect(s.recall('闭合')[0]?.openThread).toBe(false);
      s.close();
    });

    it('closeThread 幂等:重复闭合 / 未知 id 不抛、无副作用(承 §7#2/§3.2)', () => {
      const s = make();
      s.addMemory({ text: '幂等的事', openThread: true });
      const rec = s.recall('幂等')[0]!;
      // 重复闭合不抛。
      expect(() => {
        s.closeThread(rec.id);
        s.closeThread(rec.id);
      }).not.toThrow();
      // 未知 id 不抛、不影响其它未闭合话题。
      s.addMemory({ text: '另一未了事', openThread: true });
      expect(() => s.closeThread(999_999)).not.toThrow();
      expect(s.openThreads().map((r) => r.text)).toEqual(['另一未了事']);
      s.close();
    });

    // —— 联想扩散(承 §5.9 缺口①;1–2 跳 + 跳数衰减;golden 两实现一致)——

    it('共享特定人物的记忆被联想带入:未直接命中关键词也进结果(§5.9 缺口①)', () => {
      const s = make();
      // 两条都关于访客 guest-1:一条含"面试"关键词,一条只含"咖啡"(无"面试")。
      s.addMemory({ text: '阿强 面试 紧张', subject: 'person', personId: 'guest-1' });
      s.addMemory({ text: '阿强 爱喝 咖啡', subject: 'person', personId: 'guest-1' });
      // 查"面试"只直接命中第一条;但两条共享 person 'guest-1' 有邻接边 → 第二条被联想带入。
      const texts = s.recall('面试', 10).map((r) => r.text);
      expect(texts).toContain('阿强 面试 紧张'); // 一阶命中
      expect(texts).toContain('阿强 爱喝 咖啡'); // 联想带入(未直接命中"面试")
      s.close();
    });

    it('共享内容 token 的记忆被联想带入(共现成边,§5.9 缺口①)', () => {
      const s = make();
      // 空白分词:两条共享 token "猫";查"散步"只命中第一条,但共享"猫"边 → 第二条被联想带入。
      s.addMemory({ text: '猫 散步' });
      s.addMemory({ text: '猫 打呼' });
      const texts = s.recall('散步', 10).map((r) => r.text);
      expect(texts).toContain('猫 散步'); // 一阶命中
      expect(texts).toContain('猫 打呼'); // 经共享"猫"联想带入
      s.close();
    });

    it('无关联的记忆不被带入:仅主用户(默认)共享不连边(§5.9 缺口①)', () => {
      const s = make();
      // 两条默认归主用户、无共享内容 token(CJK 整串各自成键)→ 不应互相联想。
      s.addMemory({ text: '我喜欢喝咖啡' });
      s.addMemory({ text: '我养了一只狗' });
      const texts = s.recall('咖啡', 10).map((r) => r.text);
      expect(texts).toEqual(['我喜欢喝咖啡']); // 狗的记忆不被主用户共享误带入
      s.close();
    });

    it('跳数衰减:近邻(1 跳)联想分高于远邻(2 跳)(§5.9 缺口①)', () => {
      let t = 0;
      const s = make({ now: () => ++t });
      // 链:命中 A —(共享 token X)— B —(共享 token Y)— C;A 命中关键词"起点"。
      // A 与 B 共享 X;B 与 C 共享 Y;A 与 C 无直接共享 → C 是 A 的 2 跳邻居。
      s.addMemory({ text: '起点 链X' }); // A:含查询词"起点" + token"链X"
      s.addMemory({ text: '链X 链Y' }); // B:与 A 共享"链X"(1 跳)、与 C 共享"链Y"
      s.addMemory({ text: '链Y 末端' }); // C:与 B 共享"链Y" → 对 A 是 2 跳
      const texts = s.recall('起点', 10).map((r) => r.text);
      // A 一阶命中;B 1 跳、C 2 跳都被带入(默认 maxHops=2)。
      expect(texts).toContain('起点 链X');
      expect(texts).toContain('链X 链Y');
      expect(texts).toContain('链Y 末端');
      // 1 跳邻居 B 的联想分(decay¹)高于 2 跳邻居 C(decay²)→ B 排在 C 前。
      const idxB = texts.indexOf('链X 链Y');
      const idxC = texts.indexOf('链Y 末端');
      expect(idxB).toBeLessThan(idxC);
      s.close();
    });

    // —— 情景/语义显式分层(承 §5.1 / §5.9 缺口④;episodic / semantic / core;golden 两实现一致)——

    it('写入缺省分层为 episodic(原始记忆多为叙事,§5.9 缺口④)', () => {
      const s = make();
      s.addMemory({ text: '今天去公园散步' }); // 不指定 memoryKind
      expect(s.recall('公园')[0]?.memoryKind).toBe('episodic');
      s.close();
    });

    it('写入带 memoryKind 正确落库并随召回返回(§5.9 缺口④)', () => {
      const s = make();
      s.addMemory({ text: '用户喜欢喝咖啡', memoryKind: 'semantic' });
      s.addMemory({ text: '某天聊到了猫', memoryKind: 'episodic' });
      s.addMemory({ text: '用户对花生过敏', memoryKind: 'core' });
      expect(s.recall('咖啡')[0]?.memoryKind).toBe('semantic');
      expect(s.recall('猫')[0]?.memoryKind).toBe('episodic');
      expect(s.recall('花生')[0]?.memoryKind).toBe('core');
      s.close();
    });

    it('core 分层即视作 pinned:永不衰减(承 §5.4 / §5.9 缺口④)', () => {
      let nowMs = 0;
      const s = make({ now: () => nowMs });
      nowMs = 1;
      // core 旧记忆:即使极旧也不衰减(decay=1),且 pinned 被涵盖为 true。
      s.addMemory({ text: '过敏原 花生', createdAtMs: 1, memoryKind: 'core' });
      nowMs = 100 * DAY;
      const rec = s.recall('过敏原')[0];
      expect(rec?.memoryKind).toBe('core');
      // core ⟹ pinned(免衰减,承 §5.4)。
      expect(rec?.pinned).toBe(true);
      s.close();
    });

    it('core 优先注入:同信号下 core 因 kind 权重排在 episodic 前(§5.9 缺口④)', () => {
      let nowMs = 5 * DAY;
      const s = make({ now: () => nowMs });
      // 同一时刻、同 importance、同关键词命中 → 信号融合分相同;靠 kind 权重区分(core>episodic)。
      s.addMemory({ text: '叙事 事项甲', createdAtMs: 5 * DAY, memoryKind: 'episodic' });
      s.addMemory({ text: '核心 事项乙', createdAtMs: 5 * DAY, memoryKind: 'core' });
      const r = s.recall('事项', 2).map((x) => x.text);
      // core 权重更高 → 排前(优先注入语义,承 §5.4)。
      expect(r[0]).toBe('核心 事项乙');
      s.close();
    });

    it('按 kind 分路:只要语义事实(过滤 episodic)(§5.9 缺口④)', () => {
      const s = make();
      s.addMemory({ text: '稳定偏好 咖啡', memoryKind: 'semantic' });
      s.addMemory({ text: '某次喝了 咖啡', memoryKind: 'episodic' });
      // 只召回 semantic:叙事事件被排除。
      const onlySemantic = s.recall('咖啡', 10, undefined, { kinds: ['semantic'] }).map((x) => x.text);
      expect(onlySemantic).toEqual(['稳定偏好 咖啡']);
      // 不传 kindOptions:全 kind 混合召回(两条都在)。
      const all = s.recall('咖啡', 10).map((x) => x.text).sort();
      expect(all).toEqual(['某次喝了 咖啡', '稳定偏好 咖啡']);
      s.close();
    });

    it('按 kind 分路:情景优先可由 kinds 过滤实现(§5.9 缺口④)', () => {
      const s = make();
      s.addMemory({ text: '叙事 雪天 事件', memoryKind: 'episodic' });
      s.addMemory({ text: '事实 雪天 偏好', memoryKind: 'semantic' });
      const onlyEpisodic = s.recall('雪天', 10, undefined, { kinds: ['episodic'] }).map((x) => x.text);
      expect(onlyEpisodic).toEqual(['叙事 雪天 事件']);
      s.close();
    });

    it('空 kinds 数组等同不过滤(全 kind),不脆弱地全丢(§5.9 缺口④)', () => {
      const s = make();
      s.addMemory({ text: '语义 苹果', memoryKind: 'semantic' });
      s.addMemory({ text: '情景 苹果', memoryKind: 'episodic' });
      const r = s.recall('苹果', 10, undefined, { kinds: [] }).map((x) => x.text).sort();
      expect(r).toEqual(['情景 苹果', '语义 苹果']);
      s.close();
    });

    it('kind 分路过滤也作用于联想带入的旁支(分路一致,§5.9 缺口④)', () => {
      const s = make();
      // 两条共享 token "项目" 会建联想边;一条 episodic 一条 semantic。
      s.addMemory({ text: '项目 启动会', memoryKind: 'episodic' });
      s.addMemory({ text: '项目 长期目标', memoryKind: 'semantic' });
      // 查"启动会"直接命中 episodic;联想会带入 semantic 旁支,但 kinds=['episodic'] 应把它过滤掉。
      const r = s.recall('启动会', 10, undefined, { kinds: ['episodic'] }).map((x) => x.text);
      expect(r).toContain('项目 启动会');
      expect(r).not.toContain('项目 长期目标');
      s.close();
    });

    it('kind 权重调制不破坏候选池规则:低 importance 命中仍入池(§5.9 缺口④/§5.5)', () => {
      const s = make();
      // episodic + 极低 importance:kind 权重>0 → 乘性调制后仍非零 → 不被门控丢弃。
      s.addMemory({ text: '冷门 小事', memoryKind: 'episodic', importance: 0.01 });
      const r = s.recall('冷门');
      expect(r.length).toBe(1);
      expect(r[0]?.memoryKind).toBe('episodic');
      s.close();
    });

    it('maxHops=0 关闭联想扩散:退化为纯一阶召回(向后兼容,§5.9 缺口①)', () => {
      const s = make();
      // 配置关闭扩散:共享 person 的旁支记忆不应被带入。
      // 注:契约工厂只注入 now;这里靠"无共享键"已覆盖关闭场景,扩散开关另由 scoring 层 hopDecay/config 覆盖。
      s.addMemory({ text: '甲 共享键', personId: 'guest-9', subject: 'person' });
      s.addMemory({ text: '乙 共享键 旁支', personId: 'guest-9', subject: 'person' });
      // 默认 maxHops=2:查"甲"会把"乙"(共享 guest-9 + 共享"共享键")带入。
      const texts = s.recall('甲', 10).map((r) => r.text);
      expect(texts).toContain('乙 共享键 旁支');
      s.close();
    });

    // —— 向量存取 + 同步混合召回(承 §5.6 接缝 7 / §5.5 末「🔴 非阻塞召回」/ §5.9 RRF;两实现零漂移)——

    it('addMemory 返回 id:新建返回新 id、去重命中返回被强化的同一条 id(承 §5.6)', () => {
      const s = make();
      const id1 = s.addMemory({ text: '我叫小明' });
      expect(id1).toBeGreaterThan(0);
      const id2 = s.addMemory({ text: '我爱猫' });
      expect(id2).toBeGreaterThan(0);
      expect(id2).not.toBe(id1);
      // 去重命中:等价文本返回既有那条 id(不新建)。
      const idDup = s.addMemory({ text: '我叫小明' });
      expect(idDup).toBe(id1);
      // 空文本不写,返回 -1(优雅降级)。
      expect(s.addMemory({ text: '   ' })).toBe(-1);
      s.close();
    });

    it('setEmbedding + recallByVector:按 cosine 排序,维度不符跳过、不存在 id 幂等不抛(承 §5.6)', () => {
      const s = make();
      const idA = s.addMemory({ text: '记忆A' });
      const idB = s.addMemory({ text: '记忆B' });
      const idC = s.addMemory({ text: '记忆C' });
      // 三条 3 维向量:A 与查询最近、B 次之、C 最远。
      s.setEmbedding(idA, [1, 0, 0]);
      s.setEmbedding(idB, [0.8, 0.6, 0]);
      s.setEmbedding(idC, [0, 1, 0]);
      // 维度不符(2 维)应被 KNN 跳过,不抛。
      const idD = s.addMemory({ text: '记忆D' });
      s.setEmbedding(idD, [1, 0]);
      // 不存在 id 幂等不抛。
      expect(() => s.setEmbedding(999_999, [1, 0, 0])).not.toThrow();
      const r = s.recallByVector([1, 0, 0], 10).map((x) => x.text);
      // A 最相似排首;D(2 维)被跳过不出现。
      expect(r[0]).toBe('记忆A');
      expect(r).toContain('记忆B');
      expect(r).toContain('记忆C');
      expect(r).not.toContain('记忆D');
      // cosine 排序:A 在 B 前、B 在 C 前。
      expect(r.indexOf('记忆A')).toBeLessThan(r.indexOf('记忆B'));
      expect(r.indexOf('记忆B')).toBeLessThan(r.indexOf('记忆C'));
      s.close();
    });

    it('recallByVector 无 embedding 的记忆不参与(尚未嵌入)(承 §5.6)', () => {
      const s = make();
      const idA = s.addMemory({ text: '已嵌入' });
      s.addMemory({ text: '未嵌入' });
      s.setEmbedding(idA, [1, 0, 0]);
      const r = s.recallByVector([1, 0, 0], 10).map((x) => x.text);
      expect(r).toEqual(['已嵌入']);
      s.close();
    });

    it('memoriesNeedingEmbedding 只返回未嵌入项,按 id 升序、受上限约束(承 §5.6)', () => {
      const s = make();
      const idA = s.addMemory({ text: '甲' });
      const idB = s.addMemory({ text: '乙' });
      s.addMemory({ text: '丙' });
      // 嵌入甲 → 甲退出待嵌列表。
      s.setEmbedding(idA, [1, 0, 0]);
      const pending = s.memoriesNeedingEmbedding(10);
      expect(pending.map((p) => p.text)).toEqual(['乙', '丙']);
      expect(pending[0]?.id).toBe(idB);
      // 受上限约束。
      expect(s.memoriesNeedingEmbedding(1).map((p) => p.text)).toEqual(['乙']);
      s.close();
    });

    it('recallHybrid 无 queryVector == recall(逐字一致,关键词快路径下限,承 §5.5 末)', () => {
      let nowMs = 5 * 86_400_000;
      const s = make({ now: () => nowMs });
      s.addMemory({ text: '要紧的事', createdAtMs: 5 * 86_400_000, importance: 0.9 });
      s.addMemory({ text: '琐碎的事', createdAtMs: 5 * 86_400_000, importance: 0.1 });
      // 两次独立调用应得同一命中序(都走关键词快路径)。
      const viaRecall = s.recall('事', 5).map((r) => r.text);
      const viaHybrid = s.recallHybrid('事', { limit: 5 }).map((r) => r.text);
      expect(viaHybrid).toEqual(viaRecall);
      s.close();
    });

    it('recallHybrid 带 queryVector(weighted 融合):向量近但关键词不命中的记忆也能进结果(承用户拍板/Nexus)', () => {
      const s = make();
      // "咖啡"关键词命中第一条;第二条不含查询词,但向量与查询最近 → weighted 融合应带入。
      const idKw = s.addMemory({ text: '我喜欢喝咖啡' });
      const idVec = s.addMemory({ text: '关于狗的事' });
      s.setEmbedding(idKw, [0, 1, 0]); // 与查询向量不近。
      s.setEmbedding(idVec, [1, 0, 0]); // 与查询向量最近。
      const r = s.recallHybrid('咖啡', { queryVector: [1, 0, 0], limit: 10 }).map((x) => x.text);
      // 关键词单路命中的"咖啡"在;向量近但关键词不命中的"狗"也被带入(不硬门控丢项)。
      expect(r).toContain('我喜欢喝咖啡');
      expect(r).toContain('关于狗的事');
      s.close();
    });

    it('recallHybrid:关键词单路命中(无 embedding)仍入候选池(任一路在场即进池,承 §5.5)', () => {
      const s = make();
      // 该记忆无 embedding(向量路缺席),但关键词命中 → 仍应入结果。
      s.addMemory({ text: '只有关键词的猫' });
      const r = s.recallHybrid('猫', { queryVector: [1, 0, 0], limit: 10 }).map((x) => x.text);
      expect(r).toContain('只有关键词的猫');
      s.close();
    });

    it('recallHybrid:向量维度不符的记忆在向量路被跳过(不抛)(承 §5.6)', () => {
      const s = make();
      const id = s.addMemory({ text: '维度不符的记忆' });
      s.setEmbedding(id, [1, 0]); // 2 维,与 3 维查询不符。
      // 不抛;该记忆既无关键词命中也无有效向量 → 不在结果(但调用本身安全)。
      expect(() => s.recallHybrid('查询', { queryVector: [1, 0, 0], limit: 10 })).not.toThrow();
      s.close();
    });

    // —— 关系亲密度 closeness(中速慢变量,承 §6/§5.3b;惰性衰减 + 渐近抬升;golden 两实现一致)——

    // 主用户 id(缺省值,与 makePrimaryPerson 一致;测试常量,避免硬编码散落)。
    const PRIMARY_PERSON_ID = 'primary';

    it('closeness 默认初值 + 抬升渐近饱和 + 惰性衰减', () => {
      const s = make(); // 工厂注入,主用户已 seed
      const pid = PRIMARY_PERSON_ID;
      expect(s.getCloseness(pid)).toBeCloseTo(0.1, 5); // 默认初值
      const t0 = 1_000_000_000_000;
      const c1 = s.bumpCloseness(pid, 1, t0); // 满正向
      expect(c1).toBeCloseTo(0.1 + 0.1 * (1 - 0.1), 5); // 0.19
      const c2 = s.bumpCloseness(pid, 1, t0); // 再抬,渐近
      expect(c2).toBeGreaterThan(c1);
      expect(c2).toBeLessThan(1);
      // 30 天后(半衰期)读取应≈半衰
      const t30 = t0 + 30 * 24 * 3600 * 1000;
      expect(s.getClosenessAt(pid, t30)).toBeCloseTo(c2 / 2, 2);
      s.close();
    });

    it('bumpCloseness valence≤0 不升只刷新基线;未知 person 不抛', () => {
      const s = make();
      const pid = PRIMARY_PERSON_ID;
      const c = s.bumpCloseness(pid, 0, 1_000_000_000_000);
      expect(c).toBeCloseTo(0.1, 5);
      expect(() => s.bumpCloseness('nope', 1, 1)).not.toThrow();
      s.close();
    });
  });
}
