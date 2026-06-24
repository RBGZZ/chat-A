import { describe, it, expect } from 'vitest';
import { SentenceAggregator } from '../src/sentence-aggregator';
import { SentenceSplitter } from '../src/sentence-splitter';

describe('runtime/SentenceAggregator(§4.2 句级聚合)', () => {
  it('token 流聚成句:句末标点处切出整句,残余留缓冲', () => {
    const agg = new SentenceAggregator();
    expect(agg.aggregate('你好')).toEqual([]); // 无句末标点,留缓冲
    expect(agg.aggregate('。')).toEqual(['你好。']); // 句末标点 → 切出
    expect(agg.aggregate('很高兴')).toEqual([]);
    expect(agg.aggregate('见到你！')).toEqual(['很高兴见到你！']);
  });

  it('首句尽快下发(多句一次喂入即返回多句)', () => {
    const agg = new SentenceAggregator();
    const out = agg.aggregate('第一句。第二句！');
    expect(out).toEqual(['第一句。', '第二句！']);
  });

  it('flush 吐出最后残余', () => {
    const agg = new SentenceAggregator();
    agg.aggregate('没有标点的尾巴');
    expect(agg.flush()).toBe('没有标点的尾巴');
    expect(agg.flush()).toBeNull(); // 清空后再 flush 为 null
  });

  it('与 SentenceSplitter 逐字等价(同输入同输出)', () => {
    const tokens = ['小雪', '你好', '。', '今天', '天气', '不错,', '我们', '出去', '走走', '吧?'];
    const agg = new SentenceAggregator();
    const split = new SentenceSplitter();
    const aggOut: string[] = [];
    const splitOut: string[] = [];
    for (const t of tokens) {
      aggOut.push(...agg.aggregate(t));
      splitOut.push(...split.push(t));
    }
    const aggTail = agg.flush();
    const splitTail = split.flush();
    expect(aggOut).toEqual(splitOut);
    expect(aggTail).toEqual(splitTail);
  });
});
