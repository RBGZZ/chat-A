import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryMemoryStore } from '@chat-a/memory';
import {
  parsePersonaCard,
  loadPersonaCard,
  seedPersonaMemories,
  loadPersonaFromEnv,
  XIAOXUE_SEED,
} from '../src/index';

// card-loader 告警走 stderr;测试里静音以免刷屏。
beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('card-loader: 完整卡装配(golden)', () => {
  it('完整卡 → 种子各字段正确(含 OCEAN 五维)+ lore/userProfile 解析', () => {
    const yaml = `
name: 阿狸
identity: |
  你是阿狸，慵懒又毒舌。
ocean:
  openness: 0.9
  conscientiousness: 0.2
  extraversion: 0.3
  agreeableness: 0.4
  neuroticism: 0.8
dials:
  baselineWarmth: 0.3
  assertiveness: 0.9
greetings:
  - 哟
  - 又是你
lore:
  - 我在深山的狐族长大。
  - 最讨厌被当成宠物。
userProfile:
  - 用户叫小明，怕黑。
`;
    const { seed, lore, userProfile } = parsePersonaCard(yaml);
    expect(seed.name).toBe('阿狸');
    expect(seed.identity).toContain('慵懒');
    expect(seed.ocean).toEqual({
      openness: 0.9,
      conscientiousness: 0.2,
      extraversion: 0.3,
      agreeableness: 0.4,
      neuroticism: 0.8,
    });
    expect(seed.dials.baselineWarmth).toBe(0.3);
    expect(seed.dials.assertiveness).toBe(0.9);
    // 未在卡里写的旋钮回落默认。
    expect(seed.dials.proactivity).toBe(XIAOXUE_SEED.dials.proactivity);
    expect(seed.greetings).toEqual(['哟', '又是你']);
    expect(lore).toEqual(['我在深山的狐族长大。', '最讨厌被当成宠物。']);
    expect(userProfile).toEqual(['用户叫小明，怕黑。']);
  });

  it('部分卡 → 缺省字段回落默认种子', () => {
    const { seed, lore, userProfile } = parsePersonaCard('name: 仅改名字');
    expect(seed.name).toBe('仅改名字');
    expect(seed.identity).toBe(XIAOXUE_SEED.identity);
    expect(seed.ocean).toEqual(XIAOXUE_SEED.ocean);
    expect(lore).toEqual([]);
    expect(userProfile).toEqual([]);
  });
});

describe('card-loader: 容错(不抛 + 字段级回落)', () => {
  it('文件缺失 → 默认种子 + 空列表,不抛', () => {
    const r = loadPersonaCard('D:/不存在的卡-xxxxx.yaml');
    expect(r.seed).toEqual(XIAOXUE_SEED);
    expect(r.lore).toEqual([]);
    expect(r.userProfile).toEqual([]);
  });

  it('path 省略/空 → 默认种子', () => {
    expect(loadPersonaCard().seed).toEqual(XIAOXUE_SEED);
    expect(loadPersonaCard('   ').seed).toEqual(XIAOXUE_SEED);
  });

  it('非法 YAML → 默认种子,不抛', () => {
    const r = parsePersonaCard('::: not : valid : yaml : [');
    expect(r.seed).toEqual(XIAOXUE_SEED);
  });

  it('顶层非映射(数组/标量)→ 默认种子', () => {
    expect(parsePersonaCard('- a\n- b').seed).toEqual(XIAOXUE_SEED);
    expect(parsePersonaCard('就一句话').seed).toEqual(XIAOXUE_SEED);
    expect(parsePersonaCard('').seed).toEqual(XIAOXUE_SEED);
  });

  it('单字段越界只回落该字段,其余合法字段仍生效', () => {
    const { seed } = parsePersonaCard(`
name: 半对的卡
ocean:
  openness: 5
  extraversion: 0.8
dials:
  baselineWarmth: -1
  expressiveness: 0.9
`);
    expect(seed.name).toBe('半对的卡');
    // 越界回落默认,合法值生效。
    expect(seed.ocean.openness).toBe(XIAOXUE_SEED.ocean.openness);
    expect(seed.ocean.extraversion).toBe(0.8);
    expect(seed.dials.baselineWarmth).toBe(XIAOXUE_SEED.dials.baselineWarmth);
    expect(seed.dials.expressiveness).toBe(0.9);
  });

  it('空/布尔/null 字段回落默认(不被 Number 静默转成 0/1)', () => {
    // openness: 留空(→null)、neuroticism: 布尔、conscientiousness: 空串 —— 都该回落默认。
    const { seed } = parsePersonaCard(`
ocean:
  openness:
  neuroticism: true
  conscientiousness: ""
  extraversion: 0.33
`);
    expect(seed.ocean.openness).toBe(XIAOXUE_SEED.ocean.openness);
    expect(seed.ocean.neuroticism).toBe(XIAOXUE_SEED.ocean.neuroticism);
    expect(seed.ocean.conscientiousness).toBe(XIAOXUE_SEED.ocean.conscientiousness);
    expect(seed.ocean.extraversion).toBe(0.33); // 合法值仍生效
  });
});

describe('config-loader: 装配优先级 默认 < 卡 < env', () => {
  it('无卡无 env = 默认种子', () => {
    expect(loadPersonaFromEnv({}).seed).toEqual(XIAOXUE_SEED);
  });

  it('有 env 无卡 = env 覆盖默认(等价旧行为)', () => {
    const { seed } = loadPersonaFromEnv({
      CHAT_A_PERSONA_NAME: '环境名',
      CHAT_A_DIAL_WARMTH: '0.1',
    });
    expect(seed.name).toBe('环境名');
    expect(seed.dials.baselineWarmth).toBe(0.1);
    expect(seed.identity).toBe(XIAOXUE_SEED.identity);
  });

  it('有卡 + env = env 逐字段覆盖卡,其余取卡', () => {
    // 用真临时文件验证卡+env 合成。
    const os = require('node:os') as typeof import('node:os');
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const file = path.join(os.tmpdir(), `persona-card-test-${process.pid}.yaml`);
    fs.writeFileSync(file, 'name: 卡名\nidentity: 卡身份\ndials:\n  baselineWarmth: 0.8\n', 'utf8');
    try {
      const { seed } = loadPersonaFromEnv({
        CHAT_A_PERSONA_CARD: file,
        CHAT_A_PERSONA_NAME: '环境名覆盖',
      });
      expect(seed.name).toBe('环境名覆盖'); // env 盖卡
      expect(seed.identity).toBe('卡身份'); // 卡生效(env 未设)
      expect(seed.dials.baselineWarmth).toBe(0.8); // 卡生效
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe('seed-memories: 种子化主语 + 幂等', () => {
  it('lore→agent、画像→person,重复 seed 不新建(命中去重)', () => {
    const store = new InMemoryMemoryStore({ now: () => 1000 });
    const loaded = { lore: ['我来自海边小城。'], userProfile: ['用户叫阿明，是程序员。'], selfNotions: [] };
    const r1 = seedPersonaMemories(store, loaded, '用户怕冷。');
    expect(r1).toEqual({ lore: 1, userProfile: 2, selfNotions: 0 }); // 画像 = 卡1 + legacy1

    const lore = store.recall('海边');
    expect(lore).toHaveLength(1);
    expect(lore[0]?.subject).toBe('agent');
    expect(lore[0]?.kind).toBe('self_lore');
    expect(lore[0]?.personId).toBeUndefined();

    const prof = store.recall('程序员');
    expect(prof[0]?.subject).toBe('person');
    expect(prof[0]?.personId).toBeDefined(); // 归属主用户
    expect(prof[0]?.kind).toBe('user_profile');

    // 同卡重复 seed → 命中去重(hits 自增,不新建)。
    seedPersonaMemories(store, loaded, '用户怕冷。');
    const loreAgain = store.recall('海边');
    expect(loreAgain).toHaveLength(1);
    expect(loreAgain[0]?.hits).toBe(2);
  });

  it('legacyProfile 空/缺省时不写入', () => {
    const store = new InMemoryMemoryStore();
    const r = seedPersonaMemories(store, { lore: [], userProfile: ['仅卡画像'], selfNotions: [] }, '   ');
    expect(r.userProfile).toBe(1);
    expect(store.recall('仅卡画像')).toHaveLength(1);
  });
});
