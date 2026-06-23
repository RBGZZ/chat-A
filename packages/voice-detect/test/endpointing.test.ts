import { describe, it, expect } from 'vitest';
import {
  decideEndpointing,
  targetDelayFor,
  DynamicEndpointing,
  Ema,
  thresholdsForLang,
  DEFAULT_ENDPOINTING_CONFIG,
  type EndpointingConfig,
} from '../src/index';

const CFG = DEFAULT_ENDPOINTING_CONFIG;

describe('voice-detect/动态 endpointing 纯函数', () => {
  it('高 EOU 概率 → 目标窗趋向 minDelay(早接话)', () => {
    const en = thresholdsForLang(CFG, 'en'); // min 400 / max 4000 / 阈 0.4
    const target = targetDelayFor(1.0, en);
    expect(target).toBe(en.minEndpointingDelayMs); // prob=1 → 正好 min
  });

  it('低 EOU 概率(低于阈值)→ 目标窗钳在 maxDelay(多等)', () => {
    const en = thresholdsForLang(CFG, 'en');
    const target = targetDelayFor(0.1, en); // < 0.4
    expect(target).toBe(en.maxEndpointingDelayMs);
  });

  it('概率在阈值处 → 目标窗 = maxDelay;阈值与 1 之间单调递减到 min', () => {
    const en = thresholdsForLang(CFG, 'en');
    const atThreshold = targetDelayFor(en.unlikelyThreshold, en);
    const mid = targetDelayFor((en.unlikelyThreshold + 1) / 2, en);
    expect(atThreshold).toBe(en.maxEndpointingDelayMs);
    expect(mid).toBeLessThan(en.maxEndpointingDelayMs);
    expect(mid).toBeGreaterThan(en.minEndpointingDelayMs);
  });

  it('静音超过目标窗 → Finished(该接话);不足 → Unfinished(等)', () => {
    // 英文、prob=1 → 目标窗 = 400ms。
    const finished = decideEndpointing({ eouProb: 1, silenceMs: 500, lang: 'en' }, CFG);
    expect(finished.shouldEndpoint).toBe(true);
    expect(finished.state).toBe('Finished');

    const waiting = decideEndpointing({ eouProb: 1, silenceMs: 100, lang: 'en' }, CFG);
    expect(waiting.shouldEndpoint).toBe(false);
    expect(waiting.state).toBe('Unfinished');
  });

  it('per-language 阈值生效:同 (prob, silence) 下中文更耐心(英文已接、中文还在等)', () => {
    // prob=0.5、silence=450ms。
    // 英文阈 0.4 → 0.5≥阈 → 目标窗在 [400,4000] 间(<450 区域可达)→ 倾向接话;
    // 中文阈 0.7 → 0.5<阈 → 目标窗钳 max(6000)→ 必等。
    const enDec = decideEndpointing({ eouProb: 0.5, silenceMs: 450, lang: 'en' }, CFG);
    const zhDec = decideEndpointing({ eouProb: 0.5, silenceMs: 450, lang: 'zh' }, CFG);
    expect(zhDec.targetDelayMs).toBeGreaterThan(enDec.targetDelayMs);
    expect(zhDec.shouldEndpoint).toBe(false); // 中文多等
  });

  it('未知语种回落 default 阈值', () => {
    const dec = decideEndpointing({ eouProb: 0.1, silenceMs: 0, lang: 'ja' }, CFG);
    expect(dec.targetDelayMs).toBe(CFG.default.maxEndpointingDelayMs);
  });

  it('forceWait → 直接 Wait(不接话,目标窗 0)', () => {
    const dec = decideEndpointing({ eouProb: 1, silenceMs: 99999, lang: 'en', forceWait: true }, CFG);
    expect(dec.state).toBe('Wait');
    expect(dec.shouldEndpoint).toBe(false);
  });

  it('TEN 3 态完整覆盖:Finished / Unfinished / Wait 均可达', () => {
    const states = new Set([
      decideEndpointing({ eouProb: 1, silenceMs: 9999, lang: 'en' }, CFG).state,
      decideEndpointing({ eouProb: 1, silenceMs: 0, lang: 'en' }, CFG).state,
      decideEndpointing({ eouProb: 1, silenceMs: 0, lang: 'en', forceWait: true }, CFG).state,
    ]);
    expect(states).toEqual(new Set(['Finished', 'Unfinished', 'Wait']));
  });
});

describe('voice-detect/EMA 学习停顿', () => {
  it('首样本作初值,后续按 α 平滑', () => {
    const ema = new Ema(0.9);
    expect(ema.current).toBeUndefined();
    expect(ema.update(100)).toBe(100); // 首样本 = 初值
    // next = 0.9*200 + 0.1*100 = 190
    expect(ema.update(200)).toBeCloseTo(190, 6);
  });

  it('DynamicEndpointing 学轮间停顿,自校准抬高目标窗下限', () => {
    const dyn = new DynamicEndpointing(CFG);
    // 英文 prob=1 → 原始目标窗 400ms;但学到的轮间停顿 ~1000ms。
    dyn.observeTurnGap(1000);
    dyn.observeTurnGap(1000);
    const gap = dyn.learnedTurnGapMs!;
    expect(gap).toBeGreaterThan(400);
    const dec = dyn.decide({ eouProb: 1, silenceMs: 500, lang: 'en' });
    // 目标窗被抬到学到的 gap(>500)→ 500ms 静音还不够 → Unfinished。
    expect(dec.targetDelayMs).toBeCloseTo(gap, 6);
    expect(dec.shouldEndpoint).toBe(false);
  });

  it('自校准不超过 maxDelay 兜底', () => {
    const dyn = new DynamicEndpointing(CFG);
    dyn.observeTurnGap(999999); // 远超 max
    const dec = dyn.decide({ eouProb: 1, silenceMs: 0, lang: 'en' });
    expect(dec.targetDelayMs).toBe(thresholdsForLang(CFG, 'en').maxEndpointingDelayMs);
  });

  it('句内/轮间两个 EMA 独立学习', () => {
    const dyn = new DynamicEndpointing(CFG);
    dyn.observeIntraPause(50);
    dyn.observeTurnGap(800);
    expect(dyn.learnedIntraPauseMs).toBe(50);
    expect(dyn.learnedTurnGapMs).toBe(800);
  });

  it('reset 清空两个 EMA', () => {
    const dyn = new DynamicEndpointing(CFG);
    dyn.observeIntraPause(50);
    dyn.observeTurnGap(800);
    dyn.reset();
    expect(dyn.learnedIntraPauseMs).toBeUndefined();
    expect(dyn.learnedTurnGapMs).toBeUndefined();
  });

  it('α 来自 config,非 magic number(替换 config 改变平滑行为)', () => {
    const slow: EndpointingConfig = { ...CFG, emaAlpha: 0.1 };
    const dyn = new DynamicEndpointing(slow);
    dyn.observeTurnGap(1000);
    // next = 0.1*0 ... 这里用第二样本验证 α 生效:0.1*2000 + 0.9*1000 = 1100
    expect(dyn.observeTurnGap(2000)).toBeCloseTo(1100, 6);
  });
});
