import { describe, it, expect } from 'vitest';
import { FakeLlm } from '@chat-a/providers';
import {
  Consolidator,
  InMemoryMemoryStore,
  SqliteMemoryStore,
  shouldConsolidate,
  DEFAULT_CONSOLIDATION_CONFIG,
  decayFactor,
  MS_PER_DAY,
} from '../src/index';
import type { ConsolidationInput, MemoryRecord, MemoryStore } from '../src/index';

const PARAMS = DEFAULT_CONSOLIDATION_CONFIG;

/** 固定时钟工厂(确定性测试)。 */
function fixedClock(t: number): () => number {
  return () => t;
}

/** 把 store 里某 id 的记忆读回(便于断言)。 */
function get(store: MemoryStore, id: number): MemoryRecord | undefined {
  return store.getMemoryById(id);
}

describe('memory/Consolidation 触发判定(纯函数 shouldConsolidate)', () => {
  it('enabled=off → 任何触发都 false', () => {
    const off = { ...PARAMS, enabled: 'off' as const };
    expect(shouldConsolidate({ kind: 'session-end', unit: 's:1' }, {}, 0, off)).toBe(false);
    expect(shouldConsolidate({ kind: 'daily', unit: 'd:1' }, {}, 0, off)).toBe(false);
    expect(shouldConsolidate({ kind: 'every-n-turns', unit: 't:1' }, { turnsSinceLast: 999 }, 0, off)).toBe(false);
  });

  it('session-end → 恒触发(幂等交给 run 兜底)', () => {
    expect(shouldConsolidate({ kind: 'session-end', unit: 's:1' }, {}, 12345, PARAMS)).toBe(true);
  });

  it('daily → 距上次≥1天才触发;从未巩固也触发', () => {
    const now = 10 * MS_PER_DAY;
    // 从未巩固。
    expect(shouldConsolidate({ kind: 'daily', unit: 'd' }, {}, now, PARAMS)).toBe(true);
    // 距上次 0.5 天 → 不触发。
    expect(
      shouldConsolidate({ kind: 'daily', unit: 'd' }, { lastConsolidatedAtMs: now - 0.5 * MS_PER_DAY }, now, PARAMS),
    ).toBe(false);
    // 距上次 1 天整 → 触发。
    expect(
      shouldConsolidate({ kind: 'daily', unit: 'd' }, { lastConsolidatedAtMs: now - 1 * MS_PER_DAY }, now, PARAMS),
    ).toBe(true);
  });

  it('every-n-turns → 轮数≥N 才触发', () => {
    const p = { ...PARAMS, everyNTurns: 5 };
    expect(shouldConsolidate({ kind: 'every-n-turns', unit: 't' }, { turnsSinceLast: 4 }, 0, p)).toBe(false);
    expect(shouldConsolidate({ kind: 'every-n-turns', unit: 't' }, { turnsSinceLast: 5 }, 0, p)).toBe(true);
    expect(shouldConsolidate({ kind: 'every-n-turns', unit: 't' }, {}, 0, p)).toBe(false); // 未知=0
  });

  it('shouldRun 实例封装用编排器时钟+配置', () => {
    const store = new InMemoryMemoryStore();
    const c = new Consolidator({ provider: new FakeLlm(), store, now: fixedClock(3 * MS_PER_DAY) });
    expect(c.shouldRun({ kind: 'daily', unit: 'd' }, { lastConsolidatedAtMs: 0 })).toBe(true);
  });
});

/** 构造两个 store(InMemory + SQLite 内存库),跑同一断言保证两后端零漂移。 */
function bothStores(): { name: string; make: (now: () => number) => MemoryStore }[] {
  return [
    { name: 'InMemory', make: (now) => new InMemoryMemoryStore({ now }) },
    { name: 'SQLite', make: (now) => new SqliteMemoryStore({ path: ':memory:', now }) },
  ];
}

describe('memory/Consolidation 双 Pass 调和(两后端)', () => {
  for (const { name, make } of bothStores()) {
    describe(name, () => {
      it('矛盾 → update 整块重写既有(临时整数 ID 回映真 id)', async () => {
        const t = 1_000_000;
        const store = make(fixedClock(t));
        // 既有:用户喜欢咖啡。
        const oldId = store.addMemory({ text: '用户喜欢咖啡', memoryKind: 'semantic' });
        // LLM 调和:ref 1(临时编号)→ 改写为喜欢茶。
        const provider = new FakeLlm('fake', {
          complete: JSON.stringify({
            ops: [{ action: 'update', ref: 1, text: '用户现在喜欢茶', reason: '旧记忆被推翻' }],
          }),
        });
        const c = new Consolidator({ provider, store, now: fixedClock(t) });
        const input: ConsolidationInput = { candidates: [], existing: [get(store, oldId)!] };
        const res = await c.run('session:s1', input);
        expect(res.ran).toBe(true);
        expect(res.updated).toBe(1);
        // 真 id 被整块重写(非新增矛盾条目)。
        expect(get(store, oldId)?.text).toBe('用户现在喜欢茶');
        store.close();
      });

      it('幻觉编号(越界 ref)被丢弃 → 不误改', async () => {
        const t = 2_000_000;
        const store = make(fixedClock(t));
        const id = store.addMemory({ text: '用户叫小明', memoryKind: 'semantic' });
        const provider = new FakeLlm('fake', {
          complete: JSON.stringify({ ops: [{ action: 'discard', ref: 99, reason: '乱引' }] }),
        });
        const c = new Consolidator({ provider, store, now: fixedClock(t) });
        const res = await c.run('s', { candidates: [], existing: [get(store, id)!] });
        expect(res.discarded).toBe(0); // 越界编号被丢弃。
        store.close();
      });

      it('delete 保守 = discard(加速衰减,非物理删);记忆仍在但强度趋近 0', async () => {
        const t = 1_750_000_000_000; // 现实 2025 时间戳(够远古回推 600 天不被夹到 0)。
        const store = make(fixedClock(t));
        const id = store.addMemory({ text: '用户说今天天气不错', memoryKind: 'semantic' });
        const provider = new FakeLlm('fake', {
          complete: JSON.stringify({ ops: [{ action: 'delete', ref: 1, reason: '过时闲聊' }] }),
        });
        const c = new Consolidator({ provider, store, now: fixedClock(t) });
        const res = await c.run('s', { candidates: [], existing: [get(store, id)!] });
        expect(res.discarded).toBe(1);
        // 记忆未物理删(仍可按 id 取回)。
        const rec = get(store, id);
        expect(rec).toBeDefined();
        // 加速衰减:last_seen 被推到远古 → 单一权威 decay 趋近 0。
        const decay = decayFactor(rec!.lastSeenAtMs, t, false, { halfLifeDays: 30 });
        expect(decay).toBeLessThan(1e-4);
        store.close();
      });

      it('core/pinned 豁免:update/discard 都不动它', async () => {
        const t = 4_000_000;
        const store = make(fixedClock(t));
        const coreId = store.addMemory({ text: '用户对花生过敏', memoryKind: 'core' });
        const pinnedId = store.addMemory({ text: '小雪的根本设定', pinned: true, memoryKind: 'semantic' });
        const before = get(store, coreId)!.text;
        const provider = new FakeLlm('fake', {
          complete: JSON.stringify({
            ops: [
              { action: 'update', ref: 1, text: '篡改核心', reason: 'x' },
              { action: 'discard', ref: 2, reason: 'x' },
            ],
          }),
        });
        const c = new Consolidator({ provider, store, now: fixedClock(t) });
        const res = await c.run('s', { candidates: [], existing: [get(store, coreId)!, get(store, pinnedId)!] });
        expect(res.updated).toBe(0);
        expect(res.discarded).toBe(0);
        expect(get(store, coreId)!.text).toBe(before); // core 未被改。
        // pinned 仍免衰减(markDiscarded 被豁免,decay 恒 1)。
        const p = get(store, pinnedId)!;
        expect(decayFactor(p.lastSeenAtMs, t + 365 * MS_PER_DAY, p.pinned === true, { halfLifeDays: 30 })).toBe(1);
        store.close();
      });

      it('add → 走既有 ADD(落语义,可召回)', async () => {
        const t = 5_000_000;
        const store = make(fixedClock(t));
        const provider = new FakeLlm('fake', {
          complete: JSON.stringify({ ops: [{ action: 'add', text: '用户养了一只猫叫团子', reason: '全新事实' }] }),
        });
        const c = new Consolidator({ provider, store, now: fixedClock(t) });
        // 给一条候选(否则无候选无既有会短路不调 LLM,见专门用例)。
        const seedId = store.addMemory({ text: '用户提到养了宠物', memoryKind: 'episodic' });
        const res = await c.run('s', { candidates: [get(store, seedId)!], existing: [] });
        expect(res.added).toBe(1);
        expect(store.recall('团子').length).toBe(1);
        store.close();
      });

      it('无候选无既有 → 不调 LLM(省成本)', async () => {
        const t = 6_000_000;
        const store = make(fixedClock(t));
        let calls = 0;
        const provider = new FakeLlm('fake', {
          complete: () => {
            calls += 1;
            return '{}';
          },
        });
        const c = new Consolidator({ provider, store, now: fixedClock(t) });
        await c.run('s', { candidates: [], existing: [] });
        expect(calls).toBe(0);
        store.close();
      });
    });
  }
});

describe('memory/Consolidation 惊奇门控编码', () => {
  it('只蒸馏 prediction gap 入语义', async () => {
    const t = 7_000_000;
    const store = new InMemoryMemoryStore({ now: fixedClock(t) });
    const provider = new FakeLlm('fake', {
      complete: (req) => {
        // 调和返回空;惊奇返回 gap。
        const content = req.messages[0]?.content ?? '';
        if (content.includes('惊奇门控')) {
          return JSON.stringify({ gaps: ['小雪第一次得知用户对花生过敏'] });
        }
        return JSON.stringify({ ops: [] });
      },
    });
    const c = new Consolidator({ provider, store, now: fixedClock(t) });
    const res = await c.run('s', {
      candidates: [],
      existing: [],
      episodeText: '用户：我对花生过敏。小雪：好的我记住了。',
      existingSemantic: [],
    });
    expect(res.surpriseDistilled).toBe(1);
    expect(store.recall('过敏').length).toBe(1);
  });

  it('门控失败 → 降级为不门控,整段情景落 episodic(不崩溃)', async () => {
    const t = 8_000_000;
    const store = new InMemoryMemoryStore({ now: fixedClock(t) });
    let errored: unknown;
    const provider = new FakeLlm('fake', {
      complete: (req) => {
        const content = req.messages[0]?.content ?? '';
        if (content.includes('惊奇门控')) throw new Error('surprise boom');
        return JSON.stringify({ ops: [] });
      },
    });
    const c = new Consolidator({ provider, store, now: fixedClock(t), onError: (e) => (errored = e) });
    const res = await c.run('s', { candidates: [], existing: [], episodeText: '用户：今天聊点别的。' });
    expect(errored).toBeInstanceOf(Error);
    expect(res.ran).toBe(true); // 降级不影响整体成功。
    expect(res.surpriseDistilled).toBe(1); // 整段情景作为 episodic 落库。
    expect(store.recall('聊点别的').length).toBe(1);
  });

  it('无情景原文 → 跳过惊奇门控', async () => {
    const t = 9_000_000;
    const store = new InMemoryMemoryStore({ now: fixedClock(t) });
    const provider = new FakeLlm('fake', { complete: JSON.stringify({ ops: [] }) });
    const c = new Consolidator({ provider, store, now: fixedClock(t) });
    const res = await c.run('s', { candidates: [], existing: [] });
    expect(res.surpriseDistilled).toBe(0);
  });
});

describe('memory/Consolidation 幂等 + 失败仅告警', () => {
  it('同 unit 二次 run → 跳过、不再调 LLM、不增行', async () => {
    const t = 10_000_000;
    const store = new InMemoryMemoryStore({ now: fixedClock(t) });
    let calls = 0;
    const provider = new FakeLlm('fake', {
      complete: () => {
        calls += 1;
        return JSON.stringify({ ops: [{ action: 'add', text: '用户喜欢爬山' }] });
      },
    });
    const c = new Consolidator({ provider, store, now: fixedClock(t) });
    const r1 = await c.run('daily:2026-06-24', { candidates: [], existing: [{ id: 1, text: 'x', kind: undefined, createdAtMs: t, lastSeenAtMs: t, hits: 1, subject: 'person', personId: 'primary' }] });
    expect(r1.ran).toBe(true);
    const after1 = store.recall('爬山').length;
    const r2 = await c.run('daily:2026-06-24', { candidates: [], existing: [{ id: 1, text: 'x', kind: undefined, createdAtMs: t, lastSeenAtMs: t, hits: 1, subject: 'person', personId: 'primary' }] });
    expect(r2.ran).toBe(false);
    expect(calls).toBe(1);
    expect(store.recall('爬山').length).toBe(after1);
  });

  it('LLM 失败 → 不抛、不打幂等标记(允许重试)', async () => {
    const t = 11_000_000;
    const store = new InMemoryMemoryStore({ now: fixedClock(t) });
    let errored: unknown;
    const provider = new FakeLlm('fake', {
      complete: () => {
        throw new Error('reconcile boom');
      },
    });
    const c = new Consolidator({ provider, store, now: fixedClock(t), onError: (e) => (errored = e) });
    const fakeExisting: MemoryRecord = { id: 1, text: 'x', kind: undefined, createdAtMs: t, lastSeenAtMs: t, hits: 1, subject: 'person', personId: 'primary' };
    const res = await c.run('s', { candidates: [], existing: [fakeExisting] });
    expect(errored).toBeInstanceOf(Error);
    expect(res.ran).toBe(false);
    // 未打幂等标记 → 下次可重试。
    expect(store.getState('consolidation_s')).toBeUndefined();
  });

  it("enabled='off' → 直接跳过", async () => {
    const store = new InMemoryMemoryStore();
    let calls = 0;
    const provider = new FakeLlm('fake', {
      complete: () => {
        calls += 1;
        return '{}';
      },
    });
    const c = new Consolidator({ provider, store, config: { enabled: 'off' } });
    const res = await c.run('s', { candidates: [], existing: [] });
    expect(res.ran).toBe(false);
    expect(calls).toBe(0);
  });
});

describe('memory/Consolidation 可回放 trace(§8.1)', () => {
  for (const { name, make } of bothStores()) {
    it(`${name}:update/discard/add/surprise 决策落 trace,可按 unit 重建`, async () => {
      const t = 12_000_000_000;
      const store = make(fixedClock(t));
      const updId = store.addMemory({ text: '用户喜欢咖啡', memoryKind: 'semantic' });
      const delId = store.addMemory({ text: '过时闲聊', memoryKind: 'semantic' });
      const provider = new FakeLlm('fake', {
        complete: (req) => {
          const content = req.messages[0]?.content ?? '';
          if (content.includes('惊奇门控')) return JSON.stringify({ gaps: ['新意外'] });
          return JSON.stringify({
            ops: [
              { action: 'update', ref: 1, text: '用户喜欢茶', reason: '矛盾' },
              { action: 'discard', ref: 2, reason: '过时' },
              { action: 'add', text: '用户养猫', reason: '新事实' },
            ],
          });
        },
      });
      const c = new Consolidator({ provider, store, now: fixedClock(t) });
      await c.run('unit-x', {
        candidates: [],
        existing: [get(store, updId)!, get(store, delId)!],
        episodeText: '用户：有件意外的事。',
      });
      const traces = store.consolidationTraces('unit-x');
      const kinds = traces.map((tr) => tr.kind).sort();
      expect(kinds).toEqual(['add', 'discard', 'surprise', 'update']);
      // update trace 含真 memoryId + 理由(可重建"为什么改")。
      const upd = traces.find((tr) => tr.kind === 'update')!;
      expect(upd.memoryId).toBe(updId);
      expect(upd.reason).toContain('矛盾');
      // 按 unit 过滤精确(别的 unit 不混入)。
      expect(store.consolidationTraces('other-unit')).toEqual([]);
      store.close();
    });
  }
});

describe('memory/Consolidation 硬回归线:巩固不扰动无关记忆的热路径召回', () => {
  for (const { name, make } of bothStores()) {
    it(`${name}:discard 某条后,无关记忆的 recall 顺序/强度逐字不变`, async () => {
      const t = 1_750_000_000_000;
      const store = make(fixedClock(t));
      // 三条无关记忆 + 一条将被 discard 的。
      store.addMemory({ text: '关键词甲 苹果', memoryKind: 'semantic' });
      store.addMemory({ text: '关键词甲 香蕉', memoryKind: 'semantic' });
      store.addMemory({ text: '关键词甲 橙子', memoryKind: 'semantic' });
      const before = store.recall('关键词甲', 10).map((r) => r.id);

      const toDiscardId = store.addMemory({ text: '完全无关的待删条目', memoryKind: 'semantic' });
      const provider = new FakeLlm('fake', {
        complete: JSON.stringify({ ops: [{ action: 'discard', ref: 1, reason: '删它' }] }),
      });
      const c = new Consolidator({ provider, store, now: fixedClock(t) });
      await c.run('s', { candidates: [], existing: [get(store, toDiscardId)!] });

      // 无关记忆召回顺序逐字不变(discard 走加速衰减,不碰 recall 热路径)。
      const after = store.recall('关键词甲', 10).map((r) => r.id);
      expect(after).toEqual(before);
      store.close();
    });
  }
});

describe('memory/Consolidation 整块重写改文本 → 召回随之改(联想/去重索引重建)', () => {
  for (const { name, make } of bothStores()) {
    it(`${name}:重写后旧词召回不到、新词召回得到`, async () => {
      const t = 13_000_000;
      const store = make(fixedClock(t));
      const id = store.addMemory({ text: '用户住在北京', memoryKind: 'semantic' });
      const provider = new FakeLlm('fake', {
        complete: JSON.stringify({ ops: [{ action: 'update', ref: 1, text: '用户搬到上海了', reason: '搬家' }] }),
      });
      const c = new Consolidator({ provider, store, now: fixedClock(t) });
      await c.run('s', { candidates: [], existing: [get(store, id)!] });
      // 整块重写:旧文本召回不到,新文本召回得到(规范化/去重/联想索引随之重建)。
      expect(store.recall('北京').length).toBe(0);
      expect(store.recall('上海').length).toBe(1);
      store.close();
    });
  }
});
