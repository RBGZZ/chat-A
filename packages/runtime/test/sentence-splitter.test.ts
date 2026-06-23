import { describe, it, expect } from 'vitest';
import { SentenceSplitter } from '../src/sentence-splitter';

describe('runtime/SentenceSplitter', () => {
  it('中英文标点切句,残余留缓冲', () => {
    const s = new SentenceSplitter();
    expect(s.push('你好。今天')).toEqual(['你好。']);
    expect(s.push('天气不错!')).toEqual(['今天天气不错!']);
    expect(s.flush()).toBeNull();
  });
  it('flush 吐残余', () => {
    const s = new SentenceSplitter();
    s.push('没有结束标点');
    expect(s.flush()).toBe('没有结束标点');
  });
  it('maxChars 超长强制切(防 TTS 溢出)', () => {
    const s = new SentenceSplitter({ maxChars: 5 });
    const out = s.push('一二三四五六七');
    expect(out[0]!.length).toBeLessThanOrEqual(5);
  });
});
