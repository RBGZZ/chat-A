import { describe, it, expect } from 'vitest';
import {
  OMNI_USER_EMOTION_DIRECTIVE,
  USER_EMOTION_LABELS,
  stripUserEmotionTag,
  splitSafeTextForTag,
} from '../src/user-emotion-tag';

/**
 * omni 路「情感→PAD」显式标签链路的纯函数单测(TDD 先行)。
 * 覆盖:尾部解析 / 无标签 / 畸形 / 多标签取最后 / intensity→confidence / 流式 hold-back。
 */

describe('OMNI_USER_EMOTION_DIRECTIVE', () => {
  it('含 7 类标签名与标签格式键(供模型遵从)', () => {
    for (const label of USER_EMOTION_LABELS) {
      expect(OMNI_USER_EMOTION_DIRECTIVE).toContain(label);
    }
    expect(OMNI_USER_EMOTION_DIRECTIVE).toContain('user_emotion');
  });

  it('是非空字符串', () => {
    expect(OMNI_USER_EMOTION_DIRECTIVE.trim().length).toBeGreaterThan(0);
  });
});

describe('stripUserEmotionTag', () => {
  it('尾部标签:剥离并解析出 label + confidence(intensity/10)', () => {
    const r = stripUserEmotionTag('你今天听起来有点累。[user_emotion:sad-7]');
    expect(r.cleanText).toBe('你今天听起来有点累。');
    expect(r.emotion).toEqual({ label: 'sad', confidence: 0.7 });
  });

  it('无标签:cleanText 原样、emotion 缺席', () => {
    const r = stripUserEmotionTag('就是普通的一句话！');
    expect(r.cleanText).toBe('就是普通的一句话！');
    expect(r.emotion).toBeUndefined();
  });

  it('畸形 label(不在 7 类内):剥除标签但 emotion 缺席', () => {
    const r = stripUserEmotionTag('好的。[user_emotion:excited-5]');
    expect(r.cleanText).toBe('好的。');
    expect(r.emotion).toBeUndefined();
  });

  it('畸形 intensity(越界/0):按零情绪处理(emotion 缺席),仍剥除标签', () => {
    const r = stripUserEmotionTag('嗯。[user_emotion:happy-0]');
    expect(r.cleanText).toBe('嗯。');
    expect(r.emotion).toBeUndefined();
    const r2 = stripUserEmotionTag('嗯。[user_emotion:happy-99]');
    expect(r2.cleanText).toBe('嗯。');
    expect(r2.emotion).toBeUndefined();
  });

  it('多标签:取最后一个,所有标签均剥除', () => {
    const r = stripUserEmotionTag('a[user_emotion:happy-3]b[user_emotion:angry-8]');
    expect(r.cleanText).toBe('ab');
    expect(r.emotion).toEqual({ label: 'angry', confidence: 0.8 });
  });

  it('大小写不敏感', () => {
    const r = stripUserEmotionTag('累了。[USER_EMOTION:Sad-6]');
    expect(r.cleanText).toBe('累了。');
    expect(r.emotion).toEqual({ label: 'sad', confidence: 0.6 });
  });

  it('neutral 标签:解析为 neutral(prosodyToPadPull 自会零拉力)', () => {
    const r = stripUserEmotionTag('好。[user_emotion:neutral-5]');
    expect(r.cleanText).toBe('好。');
    expect(r.emotion).toEqual({ label: 'neutral', confidence: 0.5 });
  });

  it('intensity=10 → confidence=1', () => {
    const r = stripUserEmotionTag('太好了！[user_emotion:happy-10]');
    expect(r.emotion).toEqual({ label: 'happy', confidence: 1 });
  });
});

describe('splitSafeTextForTag', () => {
  it('无标签前缀:全部 emit、hold 为空', () => {
    const r = splitSafeTextForTag('你好世界');
    expect(r.emit).toBe('你好世界');
    expect(r.hold).toBe('');
  });

  it('末尾是半截标签前缀:emit 安全部分、hold 住可疑尾巴', () => {
    const r = splitSafeTextForTag('正文[user_emo');
    expect(r.emit).toBe('正文');
    expect(r.hold).toBe('[user_emo');
  });

  it('单独一个 [ 在末尾:hold 住(可能是标签开头)', () => {
    const r = splitSafeTextForTag('在说话[');
    expect(r.emit).toBe('在说话');
    expect(r.hold).toBe('[');
  });

  it('完整标签在末尾:整体 hold(交给 strip 处理,不 emit)', () => {
    const r = splitSafeTextForTag('正文[user_emotion:sad-7]');
    expect(r.emit).toBe('正文');
    expect(r.hold).toBe('[user_emotion:sad-7]');
  });

  it('[ 后跟不可能属于标签的字符:不 hold,照常 emit', () => {
    // "[abc" 不是 user_emotion 前缀 → 不视作半截标签
    const r = splitSafeTextForTag('看这个[abc]');
    expect(r.emit).toBe('看这个[abc]');
    expect(r.hold).toBe('');
  });

  it('emit + hold 拼接 = 原文(无损)', () => {
    const input = '一些字[user_e';
    const r = splitSafeTextForTag(input);
    expect(r.emit + r.hold).toBe(input);
  });
});
