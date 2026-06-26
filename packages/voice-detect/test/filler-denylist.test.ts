import { describe, it, expect } from 'vitest';
import {
  isDenylistedFiller,
  normalizeForDenylist,
  DEFAULT_FILLER_DENYLIST,
} from '@chat-a/voice-detect';

describe('voice-detect/normalizeForDenylist', () => {
  it('trim + 小写 + 去标点空白 + 全角转半角', () => {
    expect(normalizeForDenylist('  Thank you.  ')).toBe('thankyou');
    expect(normalizeForDenylist('嗯，')).toBe('嗯'); // 全角逗号去除
    expect(normalizeForDenylist('ＯＫ')).toBe('ok'); // 全角字母转半角 + 小写
    expect(normalizeForDenylist('')).toBe('');
  });
});

describe('voice-detect/isDenylistedFiller', () => {
  it('zh 单字/短填充词 → true', () => {
    expect(isDenylistedFiller('嗯')).toBe(true);
    expect(isDenylistedFiller('嗯嗯')).toBe(true);
    expect(isDenylistedFiller('谢谢')).toBe(true);
    expect(isDenylistedFiller('谢谢观看')).toBe(true); // 4 字仍精确命中
    expect(isDenylistedFiller('谢谢大家')).toBe(true);
  });

  it('en 短填充词(含标点/大小写归一)→ true', () => {
    expect(isDenylistedFiller('thank you.')).toBe(true);
    expect(isDenylistedFiller('Thanks')).toBe(true);
    expect(isDenylistedFiller('okay')).toBe(true);
    expect(isDenylistedFiller('OK')).toBe(true);
    expect(isDenylistedFiller('you')).toBe(true);
  });

  it('ja 短填充词 → true', () => {
    expect(isDenylistedFiller('ありがとう')).toBe(true);
    expect(isDenylistedFiller('はい')).toBe(true);
    expect(isDenylistedFiller('うん')).toBe(true);
  });

  it('真实长语句(仅含填充词为子串)→ false(精确匹配,不误杀)', () => {
    expect(isDenylistedFiller('thank you very much for everything')).toBe(false);
    expect(isDenylistedFiller('你好小雪今天天气不错')).toBe(false);
    expect(isDenylistedFiller('谢谢你帮我做这件事')).toBe(false); // 含「谢谢」但非精确命中
  });

  it('空文本 → false(空文本另有专门处理)', () => {
    expect(isDenylistedFiller('')).toBe(false);
    expect(isDenylistedFiller('   ')).toBe(false);
  });

  it('lang 子集过滤:仅 zh 名单时 en 填充词不命中', () => {
    expect(isDenylistedFiller('thank you', DEFAULT_FILLER_DENYLIST, ['zh'])).toBe(false);
    expect(isDenylistedFiller('嗯', DEFAULT_FILLER_DENYLIST, ['zh'])).toBe(true);
  });
});
