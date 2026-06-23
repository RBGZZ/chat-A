import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MEMORY_CONFIG,
  EMOTION_RESONANCE_MATRIX,
  cosineSimilarity,
  decodeEmbedding,
  defaultNormalize,
  emotionResonance,
  emotionSector,
  encodeEmbedding,
  entityKeys,
  hopDecay,
  inferMemoryKindForBackfill,
  keywordScore,
  memoryKindWeight,
  mixedRecallScore,
  normalizeAndFuse,
  personalizedPageRank,
  recallScore,
  reciprocalRankFusion,
  resolveMemoryConfig,
  resolveMemoryKind,
  type Pad,
  type PprEdge,
  type PprParams,
  type RawRecallSignals,
  type RecallSignal,
  type RecallSignalWeights,
} from '../src/index';

/** 构造一条候选的原始信号(测试便捷;缺省各路缺席)。 */
function rawSignals(p: Partial<RawRecallSignals>): RawRecallSignals {
  const off: RecallSignal = { present: false, value: 0 };
  return { keyword: off, strength: off, emotion: off, association: off, vector: off, ...p };
}
const EQUAL: RecallSignalWeights = {
  keyword: 1,
  strength: 1,
  emotion: 1,
  association: 1,
  vector: 1,
};

/**
 * §5.5 混合召回单一权威公式 golden:锁住关键词归一(自适应中点)、自适应分母混合、
 * 零信号门控、情感共振扇区矩阵。确定性内核,无 LLM(§3.2)。
 */
describe('§5.5 混合召回打分归一(单一权威公式 golden)', () => {
  const cfg = DEFAULT_MEMORY_CONFIG;

  describe('keywordScore:查询长度自适应 sigmoid 归一', () => {
    it('值落在 (0,1) 开区间', () => {
      expect(keywordScore(1, 1, cfg)).toBeGreaterThan(0);
      expect(keywordScore(1, 1, cfg)).toBeLessThan(1);
      expect(keywordScore(5, 5, cfg)).toBeLessThan(1);
    });

    it('单 token 查询:命中即过中点(raw=1,m=1 → 0.5)', () => {
      // m = clamp(ceil(1·0.5),1,1) = 1;raw-m=0 → sigmoid(0)=0.5,与陡度无关。
      expect(keywordScore(1, 1, cfg)).toBeCloseTo(0.5, 6);
    });

    it('命中更多 token → 分更高(单调)', () => {
      const one = keywordScore(1, 3, cfg);
      const two = keywordScore(2, 3, cfg);
      const three = keywordScore(3, 3, cfg);
      expect(two).toBeGreaterThan(one);
      expect(three).toBeGreaterThan(two);
    });

    it('中点随查询长度自适应:长查询要求命中更多才过半分', () => {
      // 4-token 查询 m=clamp(ceil(4·0.5),1,4)=2;命中 1 个 < 中点 → <0.5,命中 2 个 = 中点 → =0.5。
      expect(keywordScore(1, 4, cfg)).toBeLessThan(0.5);
      expect(keywordScore(2, 4, cfg)).toBeCloseTo(0.5, 6);
    });

    it('陡度可配置(行为即配置,无 magic number)', () => {
      const steep = resolveMemoryConfig({ keywordSigmoidSteepness: 10 });
      const flat = resolveMemoryConfig({ keywordSigmoidSteepness: 0.5 });
      // 同 raw 偏离中点时,陡度大的更接近极值。
      expect(keywordScore(3, 3, steep)).toBeGreaterThan(keywordScore(3, 3, flat));
    });

    it('queryTokenCount<=0 → 0(防御)', () => {
      expect(keywordScore(0, 0, cfg)).toBe(0);
    });
  });

  describe('mixedRecallScore:自适应分母 + 零信号门控', () => {
    it('两路在场:取平均(自适应分母=2)', () => {
      const signals: RecallSignal[] = [
        { present: true, value: 0.8 },
        { present: true, value: 0.4 },
      ];
      expect(mixedRecallScore(signals)).toBeCloseTo(0.6, 6);
    });

    it('缺席信号不计入分母(不稀释)', () => {
      // 同样两个在场值 0.8/0.4,但额外挂一个缺席信号 → 仍 /2,不被稀释为 /3。
      const signals: RecallSignal[] = [
        { present: true, value: 0.8 },
        { present: true, value: 0.4 },
        { present: false, value: 0 }, // 缺席:不进分子也不进分母。
      ];
      expect(mixedRecallScore(signals)).toBeCloseTo(0.6, 6);
    });

    it('三路在场:分母自动扩到 3', () => {
      const signals: RecallSignal[] = [
        { present: true, value: 0.9 },
        { present: true, value: 0.6 },
        { present: true, value: 0.3 },
      ];
      expect(mixedRecallScore(signals)).toBeCloseTo(0.6, 6);
    });

    it('零信号门控:无在场信号 → 0', () => {
      expect(mixedRecallScore([{ present: false, value: 0.9 }])).toBe(0);
      expect(mixedRecallScore([])).toBe(0);
    });

    it('零信号门控:全部在场信号为 0 → 0(可被调用方丢弃)', () => {
      expect(
        mixedRecallScore([
          { present: true, value: 0 },
          { present: true, value: 0 },
        ]),
      ).toBe(0);
    });

    it('单路非零即非零(不学 mem0 硬丢)', () => {
      // 关键词为 0 但情感共振非零 → 仍得正分,不被门控丢。
      const score = mixedRecallScore([
        { present: true, value: 0 },
        { present: true, value: 0.7 },
      ]);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeCloseTo(0.35, 6);
    });

    it('min(·,1) 防御性封顶', () => {
      expect(
        mixedRecallScore([
          { present: true, value: 1 },
          { present: true, value: 1 },
        ]),
      ).toBe(1);
    });
  });

  describe('emotionSector / emotionResonance:Russell 扇区常量矩阵 O(1)', () => {
    it('近中性 / 低唤起归中性扇区 0', () => {
      expect(emotionSector({ pleasure: 0.05, arousal: 0.05 })).toBe(0);
      expect(emotionSector({ pleasure: 0.9, arousal: 0.05 })).toBe(0); // 低唤起 → 中性。
    });

    it('四象限映射(高兴/平静/愤怒/低落)', () => {
      expect(emotionSector({ pleasure: 0.8, arousal: 0.8 })).toBe(1); // +V+A 高兴
      expect(emotionSector({ pleasure: 0.8, arousal: -0.8 })).toBe(2); // +V-A 平静
      expect(emotionSector({ pleasure: -0.8, arousal: 0.8 })).toBe(3); // -V+A 愤怒
      expect(emotionSector({ pleasure: -0.8, arousal: -0.8 })).toBe(4); // -V-A 低落
    });

    it('矩阵对角线(同扇区)最高,值确定查表', () => {
      const happy: Pad = { pleasure: 0.8, arousal: 0.8, dominance: 0 };
      // 记忆侧也高兴 → 对角线 1.0。
      expect(emotionResonance(happy, { pleasure: 0.8, arousal: 0.8 })).toBeCloseTo(1.0, 6);
      // 记忆侧低落(对立)→ 矩阵[1][4]=0.2。
      expect(emotionResonance(happy, { pleasure: -0.8, arousal: -0.8 })).toBeCloseTo(0.2, 6);
    });

    it('记忆侧情感缺省 → 中性列(恒 0.5,本期 emotion_snapshot 未落库)', () => {
      const pad: Pad = { pleasure: -0.7, arousal: 0.6, dominance: 0 };
      // 记忆侧 emotion 缺省 → 扇区 0(中性列),矩阵任一行的第 0 列均 0.5。
      expect(emotionResonance(pad)).toBeCloseTo(0.5, 6);
    });

    it('矩阵形状 5×5、值域 [0,1]、对称对角线为 1', () => {
      expect(EMOTION_RESONANCE_MATRIX.length).toBe(5);
      for (let i = 0; i < 5; i++) {
        const row = EMOTION_RESONANCE_MATRIX[i]!;
        expect(row.length).toBe(5);
        for (const v of row) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
      // 非中性扇区对角线=1(同扇区最强共振)。
      for (let i = 1; i < 5; i++) expect(EMOTION_RESONANCE_MATRIX[i]![i]).toBe(1);
    });
  });

  describe('recallScore 仍是单一权威记忆强度路(未被改写)', () => {
    it('= importance × decay', () => {
      expect(recallScore(0.6, 0.5)).toBeCloseTo(0.3, 6);
    });
  });
});

/**
 * §5.9 缺口③ 多信号 min-max 归一 + 可配权重融合(单一权威公式 golden)。
 * 锁住:候选集尺度归一、量纲可比、等权/可配权重、退化边界、不丢"仅某路强信号"项。
 */
describe('§5.9 缺口③ normalizeAndFuse(min-max 归一 + 权重融合)', () => {
  it('候选集内单路 min-max 归一:max→1、min→0(量纲可比)', () => {
    // 关键词原始命中数量纲(2 vs 1)与强度量纲(0.9 vs 0.1)各自归一到 [0,1]。
    const cands = [
      rawSignals({ keyword: { present: true, value: 2 }, strength: { present: true, value: 0.1 } }),
      rawSignals({ keyword: { present: true, value: 1 }, strength: { present: true, value: 0.9 } }),
    ];
    const out = normalizeAndFuse(cands, EQUAL);
    // A:(keyword 归一 1 + strength 归一 0)/2 = 0.5;B:(0 + 1)/2 = 0.5 → 量纲已可比、等权下打平。
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
  });

  it('量纲可比:不会因关键词原始数远大于强度而失真(归一前会失真)', () => {
    // 关键词原始命中数 100 远大于强度 1;若不归一,关键词会碾压。归一后两路同尺度。
    const cands = [
      rawSignals({ keyword: { present: true, value: 100 }, strength: { present: true, value: 0.0 } }),
      rawSignals({ keyword: { present: true, value: 0 }, strength: { present: true, value: 1.0 } }),
    ];
    const out = normalizeAndFuse(cands, EQUAL);
    // A:(1+0)/2;B:(0+1)/2 → 各 0.5,关键词大量纲未碾压强度(归一让其可比)。
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
  });

  it('退化:单候选 → span=0 该路归一为 1(不除零、等量贡献)', () => {
    const out = normalizeAndFuse(
      [rawSignals({ keyword: { present: true, value: 7 }, strength: { present: true, value: 0.3 } })],
      EQUAL,
    );
    expect(out[0]).toBeCloseTo(1, 6); // 两路皆退化为 1 → 融合 1。
  });

  it('退化:全相等列 → span=0 该列全归一为 1(不被无端压成 0)', () => {
    const cands = [
      rawSignals({ keyword: { present: true, value: 0.5 }, strength: { present: true, value: 0.5 } }),
      rawSignals({ keyword: { present: true, value: 0.5 }, strength: { present: true, value: 0.5 } }),
    ];
    const out = normalizeAndFuse(cands, EQUAL);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(1, 6);
  });

  it('缺席路不计入该候选的权重和(自适应分母,不被不存在信号稀释)', () => {
    // A 有 keyword+strength 两路;B 只有 strength 一路(keyword 缺席)。
    const cands = [
      rawSignals({ keyword: { present: true, value: 1 }, strength: { present: true, value: 0 } }),
      rawSignals({ strength: { present: true, value: 1 } }), // 仅 strength 在场
    ];
    const out = normalizeAndFuse(cands, EQUAL);
    // strength 列:A=0→归一0、B=1→归一1。keyword 列:仅 A 在场→A 归一1。
    // A:(1+0)/2=0.5;B:仅 strength 一路在场 → 1/1=1(不被缺席的 keyword 稀释)。
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(1, 6);
  });

  it('不丢"仅情感强共振"的项:无关键词但情感在场仍得正分(不硬门控,§5.5/§5.9)', () => {
    // A 仅关键词、B 仅情感共振(无关键词)。两者都应有正分(任一路在场即在候选池)。
    const cands = [
      rawSignals({ keyword: { present: true, value: 1 } }),
      rawSignals({ emotion: { present: true, value: 0.9 } }),
    ];
    const out = normalizeAndFuse(cands, EQUAL);
    expect(out[0]).toBeGreaterThan(0); // 仅关键词
    expect(out[1]).toBeGreaterThan(0); // 仅情感强共振 → 不被丢
  });

  it('可配权重:抬高某路权重改变融合占比(行为即配置)', () => {
    const cands = [
      rawSignals({ keyword: { present: true, value: 1 }, strength: { present: true, value: 0 } }),
      rawSignals({ keyword: { present: true, value: 0 }, strength: { present: true, value: 1 } }),
    ];
    // 关键词权重远高于强度 → 偏向关键词高的 A。
    const w: RecallSignalWeights = { keyword: 4, strength: 1, emotion: 1, association: 1, vector: 1 };
    const out = normalizeAndFuse(cands, w);
    expect(out[0]!).toBeGreaterThan(out[1]!);
  });

  it('权重 0 视作该路不参与(可关某路)', () => {
    const cands = [
      rawSignals({ keyword: { present: true, value: 1 }, strength: { present: true, value: 0 } }),
      rawSignals({ keyword: { present: true, value: 0 }, strength: { present: true, value: 1 } }),
    ];
    // 关掉 strength(权重 0)→ 只看 keyword,A 胜。
    const w: RecallSignalWeights = { keyword: 1, strength: 0, emotion: 1, association: 1, vector: 1 };
    const out = normalizeAndFuse(cands, w);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(0, 6);
  });

  it('空候选集 → 空数组', () => {
    expect(normalizeAndFuse([], EQUAL)).toEqual([]);
  });

  it('全路缺席的候选 → 0(可被零信号门控丢弃)', () => {
    const out = normalizeAndFuse([rawSignals({})], EQUAL);
    expect(out[0]).toBe(0);
  });
});

/** §5.9 缺口① 联想扩散纯函数 golden:实体键抽取(排除主用户)、跳数衰减。 */
describe('§5.9 缺口① entityKeys / hopDecay', () => {
  it('entityKeys:特定人物 + 规范化 token 都成键(带类型前缀)', () => {
    const keys = entityKeys('喜欢 咖啡', 'guest-1', defaultNormalize);
    expect(keys).toContain('p:guest-1');
    expect(keys).toContain('t:喜欢');
    expect(keys).toContain('t:咖啡');
  });

  it('entityKeys:主用户 person_id 被排除(防全图连成一团)', () => {
    const keys = entityKeys('随便', 'primary', defaultNormalize, 'primary');
    expect(keys).not.toContain('p:primary');
    expect(keys).toContain('t:随便');
  });

  it('entityKeys:无 person_id(如 agent 主语)只出 token 键', () => {
    expect(entityKeys('小雪喜欢下雪', undefined, defaultNormalize)).toEqual(['t:小雪喜欢下雪']);
  });

  it('hopDecay:hop=0→1、按跳数几何衰减(每跳 ×decay)', () => {
    expect(hopDecay(0, 0.5)).toBe(1);
    expect(hopDecay(1, 0.5)).toBeCloseTo(0.5, 6);
    expect(hopDecay(2, 0.5)).toBeCloseTo(0.25, 6);
    expect(hopDecay(2, 0.8)).toBeCloseTo(0.64, 6);
  });
});

/** §5.10 B1 Personalized PageRank(HippoRAG 式)纯函数 golden:稳态分单调合理、确定性、退化。 */
describe('§5.10 B1 personalizedPageRank', () => {
  const PARAMS: PprParams = {
    pprAlpha: DEFAULT_MEMORY_CONFIG.pprAlpha,
    pprIterations: DEFAULT_MEMORY_CONFIG.pprIterations,
    pprConvergenceEpsilon: DEFAULT_MEMORY_CONFIG.pprConvergenceEpsilon,
  };

  it('近 > 远:链 seed–B–C,1 跳 B 稳态分高于 2 跳 C(自然多跳衰减)', () => {
    // 链:1(seed)—2—3;均匀权重 → PPR 质量随跳数递减。
    const edges: PprEdge[] = [
      { a: 1, b: 2, weight: 1 },
      { a: 2, b: 3, weight: 1 },
    ];
    const r = personalizedPageRank([1], edges, PARAMS);
    expect(r.has(1)).toBe(false); // 种子不计入联想候选(同原 #spread)。
    expect(r.get(2)!).toBeGreaterThan(r.get(3)!); // 近 > 远。
  });

  it('强连接 > 弱连接:同距邻居,边权重者稳态分更高', () => {
    // seed=1 同时连 2(强边 w=3)与 3(弱边 w=1);两者都是 1 跳,但强边分得更多质量。
    const edges: PprEdge[] = [
      { a: 1, b: 2, weight: 3 },
      { a: 1, b: 3, weight: 1 },
    ];
    const r = personalizedPageRank([1], edges, PARAMS);
    expect(r.get(2)!).toBeGreaterThan(r.get(3)!); // 强连接 > 弱连接。
  });

  it('确定性:同输入多次调用结果完全一致', () => {
    const edges: PprEdge[] = [
      { a: 1, b: 2, weight: 2 },
      { a: 2, b: 3, weight: 1 },
      { a: 1, b: 3, weight: 1 },
    ];
    const a = personalizedPageRank([1], edges, PARAMS);
    const b = personalizedPageRank([1], edges, PARAMS);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('退化:空种子 / 空边 / 迭代数<=0 → 空 Map(优雅降级)', () => {
    const edges: PprEdge[] = [{ a: 1, b: 2, weight: 1 }];
    expect(personalizedPageRank([], edges, PARAMS).size).toBe(0);
    expect(personalizedPageRank([1], [], PARAMS).size).toBe(0);
    expect(personalizedPageRank([1], edges, { ...PARAMS, pprIterations: 0 }).size).toBe(0);
  });

  it('自环 / 非正权边被忽略,不污染稳态分', () => {
    const edges: PprEdge[] = [
      { a: 1, b: 1, weight: 5 }, // 自环:忽略。
      { a: 1, b: 2, weight: 0 }, // 零权:忽略 → 2 不可达。
      { a: 1, b: 3, weight: 1 }, // 唯一有效边。
    ];
    const r = personalizedPageRank([1], edges, PARAMS);
    expect(r.has(2)).toBe(false); // 零权边不可达。
    expect(r.get(3)!).toBeGreaterThan(0);
  });

  it('多种子均匀分布:对称图下两端等价节点稳态分相等', () => {
    // 种子 {1,4};1—2、4—3,结构对称 → 2 与 3 稳态分应相等。
    const edges: PprEdge[] = [
      { a: 1, b: 2, weight: 1 },
      { a: 4, b: 3, weight: 1 },
    ];
    const r = personalizedPageRank([1, 4], edges, PARAMS);
    expect(r.get(2)!).toBeCloseTo(r.get(3)!, 9);
  });
});

/**
 * §5.9 缺口④ 情景/语义分层纯函数 golden:写入归类(core⟹pinned)、迁移归类(pinned→core/else semantic)、
 * 召回 kind 权重调制。两 store 共用同一权威,锁住单点规则(§3.2)。
 */
describe('§5.9 缺口④ 情景/语义分层(单一权威纯函数 golden)', () => {
  it('resolveMemoryKind:缺省取配置 defaultMemoryKind(默认 episodic)', () => {
    expect(resolveMemoryKind({}, DEFAULT_MEMORY_CONFIG)).toEqual({
      memoryKind: 'episodic',
      pinned: false,
    });
    // 配置可改默认(行为即配置)。
    const cfg = resolveMemoryConfig({ defaultMemoryKind: 'semantic' });
    expect(resolveMemoryKind({}, cfg).memoryKind).toBe('semantic');
  });

  it('resolveMemoryKind:core ⟹ pinned(核心档永不衰减,承 §5.4)', () => {
    expect(resolveMemoryKind({ memoryKind: 'core' }, DEFAULT_MEMORY_CONFIG)).toEqual({
      memoryKind: 'core',
      pinned: true,
    });
  });

  it('resolveMemoryKind:显式 pinned 但非 core → 保留 kind、仅免衰(两概念正交可组合)', () => {
    expect(resolveMemoryKind({ memoryKind: 'episodic', pinned: true }, DEFAULT_MEMORY_CONFIG)).toEqual(
      { memoryKind: 'episodic', pinned: true },
    );
  });

  it('inferMemoryKindForBackfill:pinned→core、其余→semantic(保守默认),幂等', () => {
    expect(inferMemoryKindForBackfill(true)).toBe('core');
    expect(inferMemoryKindForBackfill(false)).toBe('semantic');
    // 纯函数幂等:同入参恒同出。
    expect(inferMemoryKindForBackfill(true)).toBe(inferMemoryKindForBackfill(true));
  });

  it('memoryKindWeight:取配置权重,缺省 core>semantic>episodic;undefined 兜底 episodic', () => {
    const w = DEFAULT_MEMORY_CONFIG.memoryKindWeights;
    expect(memoryKindWeight('episodic', w)).toBe(w.episodic);
    expect(memoryKindWeight('semantic', w)).toBe(w.semantic);
    expect(memoryKindWeight('core', w)).toBe(w.core);
    expect(memoryKindWeight('core', w)).toBeGreaterThan(memoryKindWeight('semantic', w));
    expect(memoryKindWeight('semantic', w)).toBeGreaterThan(memoryKindWeight('episodic', w));
    // undefined 兜底 episodic;负权重夹到 0(防御)。
    expect(memoryKindWeight(undefined, w)).toBe(w.episodic);
    expect(memoryKindWeight('semantic', { episodic: 1, semantic: -3, core: 1 })).toBe(0);
  });
});

/**
 * §5.6 接缝 7 / §5.9 RRF 向量存取纯函数 golden:Float32 BLOB 编解码往返、cosine、RRF 名次融合。
 * 两 store 共用同一权威,锁住单点规则(§3.2)。
 */
describe('§5.6 向量存取纯函数(单一权威 golden)', () => {
  it('encodeEmbedding/decodeEmbedding:Float32 往返保真(端侧不透明存储)', () => {
    const v = [1, 0.5, -0.25, 0];
    const bytes = encodeEmbedding(v);
    expect(bytes.length).toBe(v.length * 4); // Float32 每元素 4 字节。
    const back = decodeEmbedding(bytes);
    expect(back.length).toBe(v.length);
    for (let i = 0; i < v.length; i++) expect(back[i]).toBeCloseTo(v[i]!, 5);
  });

  it('decodeEmbedding:空 / 非 4 倍数字节 → 空数组(读列兜底,不抛)', () => {
    expect(decodeEmbedding(new Uint8Array(0))).toEqual([]);
    expect(decodeEmbedding(new Uint8Array([1, 2, 3]))).toEqual([]); // 3 字节非 Float32 边界。
  });

  it('cosineSimilarity:同向=1、正交=0、反向=-1;维度不符 / 零向量 → 0', () => {
    expect(cosineSimilarity([1, 0, 0], [2, 0, 0])).toBeCloseTo(1, 6); // 同向(模长无关)。
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6); // 正交。
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6); // 反向。
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0); // 维度不符。
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0); // 零向量。
  });

  it('reciprocalRankFusion:Σ1/(k+rank),两路共识者得分更高;某路缺席不丢项', () => {
    // 关键词路名次:A,B,C;向量路名次:B,A(C 不在向量路)。
    const rrf = reciprocalRankFusion(
      [
        [1, 2, 3],
        [2, 1],
      ],
      60,
    );
    // A:1/(60+1)+1/(60+2);B:1/(60+2)+1/(60+1);A 与 B 同分(两路一头一尾对称)。
    expect(rrf.get(1)).toBeCloseTo(1 / 61 + 1 / 62, 9);
    expect(rrf.get(2)).toBeCloseTo(1 / 62 + 1 / 61, 9);
    // C 只在关键词路 rank 3,仍有分(不硬门控丢项)。
    expect(rrf.get(3)).toBeCloseTo(1 / 63, 9);
    // 两路共识(A/B)高于单路(C)。
    expect(rrf.get(1)!).toBeGreaterThan(rrf.get(3)!);
  });
});
