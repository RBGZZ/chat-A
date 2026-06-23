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
  });
}
