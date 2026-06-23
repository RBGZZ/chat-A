import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeLlm } from '@chat-a/providers';
import { InMemoryMemoryStore } from '@chat-a/memory';
import {
  DefaultStanceDetector,
  LlmStanceDetector,
  parsePersonaCard,
  seedPersonaMemories,
  XIAOXUE_SEED,
  type SelfNotion,
  type StanceDetector,
} from '../src/index';

const NOTIONS: readonly SelfNotion[] = [
  { topic: ['咖啡', 'coffee'], position: '手冲比速溶值得。' },
  { topic: ['熬夜', '晚睡'], position: '熬夜伤身，早睡更好。' },
  { topic: ['猫'], position: '猫比狗更适合独居。' },
];

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

describe('DefaultStanceDetector: 话题命中 + assertiveness 门槛', () => {
  it('话题命中 → 返回该观点', async () => {
    const r = await new DefaultStanceDetector().detect({
      userText: '我觉得速溶咖啡挺好喝的',
      selfNotions: NOTIONS,
      assertiveness: 0.5,
    });
    expect(r.notions).toHaveLength(1);
    expect(r.notions[0]?.position).toContain('手冲');
  });

  it('不相关 → 空', async () => {
    const r = await new DefaultStanceDetector().detect({
      userText: '今天天气不错',
      selfNotions: NOTIONS,
      assertiveness: 0.5,
    });
    expect(r.notions).toHaveLength(0);
  });

  it('assertiveness 低于门槛 → 沉默(即便命中)', async () => {
    const r = await new DefaultStanceDetector().detect({
      userText: '说说咖啡',
      selfNotions: NOTIONS,
      assertiveness: 0.1, // < STANCE_FLOOR(0.2)
    });
    expect(r.notions).toHaveLength(0);
  });

  it('多命中按相关度截断到 maxNotions', async () => {
    const r = await new DefaultStanceDetector({ maxNotions: 2 }).detect({
      userText: '咖啡、熬夜、猫我都想聊',
      selfNotions: NOTIONS,
      assertiveness: 0.9,
    });
    expect(r.notions).toHaveLength(2);
  });
});

describe('XIAOXUE_SEED.selfNotions: 默认种子自带非空观点,可被命中(§7#3)', () => {
  it('默认种子有 3 条以上观点', () => {
    expect((XIAOXUE_SEED.selfNotions ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('命中"熬夜"话题 → 返回相关立场', async () => {
    const r = await new DefaultStanceDetector().detect({
      userText: '我今天又要熬夜赶工了',
      selfNotions: XIAOXUE_SEED.selfNotions ?? [],
      assertiveness: 0.5,
    });
    expect(r.notions.length).toBeGreaterThan(0);
    expect(r.notions[0]?.position).toContain('熬夜');
  });

  it('命中"咖啡"话题 → 返回手冲立场', async () => {
    const r = await new DefaultStanceDetector().detect({
      userText: '速溶咖啡又快又省事',
      selfNotions: XIAOXUE_SEED.selfNotions ?? [],
      assertiveness: 0.5,
    });
    expect(r.notions[0]?.position).toContain('手冲');
  });

  it('无关话题 → 空命中', async () => {
    const r = await new DefaultStanceDetector().detect({
      userText: '明天会下雨吗',
      selfNotions: XIAOXUE_SEED.selfNotions ?? [],
      assertiveness: 0.5,
    });
    expect(r.notions).toHaveLength(0);
  });
});

describe('LlmStanceDetector: 下标命中 + 失败降级', () => {
  it('合规下标 JSON → 对应观点', async () => {
    const provider = new FakeLlm('fake', { complete: '命中:\n```json\n[0]\n```' });
    const r = await new LlmStanceDetector({ provider }).detect({
      userText: '速溶咖啡更方便',
      selfNotions: NOTIONS,
      assertiveness: 0.7,
    });
    expect(r.notions[0]?.position).toContain('手冲');
  });

  it('乱码 → 回退注入的 fallback', async () => {
    const provider = new FakeLlm('fake', { complete: '我不会输出 JSON' });
    const sentinel: StanceDetector = {
      detect: () => Promise.resolve({ notions: [{ topic: ['x'], position: 'SENTINEL' }] }),
    };
    const r = await new LlmStanceDetector({ provider, fallback: sentinel }).detect({
      userText: '随便',
      selfNotions: NOTIONS,
      assertiveness: 0.7,
    });
    expect(r.notions[0]?.position).toBe('SENTINEL');
  });

  it('温和顺从档不调 LLM,直接走 fallback(空)', async () => {
    let called = false;
    const provider = new FakeLlm('fake', { complete: '[0]' });
    const fallback: StanceDetector = {
      detect: () => {
        called = false; // fallback 是确定性,assertiveness 低→空
        return Promise.resolve({ notions: [] });
      },
    };
    const r = await new LlmStanceDetector({ provider, fallback }).detect({
      userText: '咖啡',
      selfNotions: NOTIONS,
      assertiveness: 0.1,
    });
    expect(r.notions).toHaveLength(0);
    expect(called).toBe(false);
  });
});

describe('card-loader: self_notions 解析 + 容错', () => {
  it('合法 self_notions → seed + loaded 都带', () => {
    const { seed, selfNotions } = parsePersonaCard(`
selfNotions:
  - topic: [咖啡, coffee]
    position: 手冲比速溶值得。
  - topic: 猫
    position: 猫更适合独居。
`);
    expect(selfNotions).toHaveLength(2);
    expect(selfNotions[0]).toEqual({ topic: ['咖啡', 'coffee'], position: '手冲比速溶值得。' });
    expect(selfNotions[1]?.topic).toEqual(['猫']); // 单字符串 topic 归一为数组
    expect(seed.selfNotions).toHaveLength(2);
  });

  it('非法条目丢弃(缺 position / 缺 topic / 空 topic)', () => {
    const { selfNotions } = parsePersonaCard(`
selfNotions:
  - topic: [有效]
    position: 留下我。
  - position: 没有 topic 丢弃
  - topic: [没有 position 丢弃]
  - topic: []
    position: 空 topic 丢弃
`);
    expect(selfNotions).toHaveLength(1);
    expect(selfNotions[0]?.position).toBe('留下我。');
  });

  it('无 self_notions → 空', () => {
    expect(parsePersonaCard('name: 小雪').selfNotions).toEqual([]);
  });
});

describe('seed-memories: self_notions → subject=agent 幂等', () => {
  it('观点写 subject=agent/kind=self_notion 且幂等', () => {
    const store = new InMemoryMemoryStore({ now: () => 1000 });
    const loaded = { lore: [], userProfile: [], selfNotions: NOTIONS };
    const r = seedPersonaMemories(store, loaded);
    expect(r.selfNotions).toBe(3);

    const hit = store.recall('手冲');
    expect(hit[0]?.subject).toBe('agent');
    expect(hit[0]?.kind).toBe('self_notion');
    expect(hit[0]?.personId).toBeUndefined();

    seedPersonaMemories(store, loaded); // 重复
    const again = store.recall('手冲');
    expect(again).toHaveLength(1);
    expect(again[0]?.hits).toBe(2);
  });
});
