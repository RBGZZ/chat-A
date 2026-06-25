import { describe, it, expect } from 'vitest';
import {
  padToVoiceInstruction,
  padToEmotion,
  VOICE_INSTRUCTION_MAX_LEN,
  type Pad,
} from '../src/index';

// 各情绪象限的代表 PAD(阈值见 padToEmotion:pleasure±0.35 / arousal 0.25)。
const JOYFUL: Pad = { pleasure: 0.6, arousal: 0.5, dominance: 0 }; // 高愉悦高唤醒
const CONTENT: Pad = { pleasure: 0.6, arousal: 0.0, dominance: 0 }; // 高愉悦低唤醒
const NEUTRAL: Pad = { pleasure: 0, arousal: 0, dominance: 0 };
const DOWN: Pad = { pleasure: -0.6, arousal: 0.0, dominance: 0 }; // 低落低唤醒
const IRRITATED: Pad = { pleasure: -0.6, arousal: 0.5, dominance: 0 }; // 负面高唤醒

describe('padToVoiceInstruction(PAD → 语音情绪指令,确定性 golden)', () => {
  it('愉悦象限:joyful 上扬/雀跃,content 温柔/暖', () => {
    expect(padToEmotion(JOYFUL)).toBe('joyful');
    expect(padToVoiceInstruction(JOYFUL)).toContain('上扬');
    expect(padToEmotion(CONTENT)).toBe('content');
    expect(padToVoiceInstruction(CONTENT)).toContain('温柔');
  });

  it('中性 → 空串(不强加情绪)', () => {
    expect(padToEmotion(NEUTRAL)).toBe('neutral');
    expect(padToVoiceInstruction(NEUTRAL)).toBe('');
  });

  it('低落 → 低沉/低落', () => {
    expect(padToEmotion(DOWN)).toBe('down');
    expect(padToVoiceInstruction(DOWN)).toContain('低沉');
  });

  it('负面高唤醒 → 不耐烦/紧绷', () => {
    expect(padToEmotion(IRRITATED)).toBe('irritated');
    expect(padToVoiceInstruction(IRRITATED)).toContain('不耐烦');
  });

  it('与 padToEmotion 同分类(单一权威,不引第二套阈值)', () => {
    for (const pad of [JOYFUL, CONTENT, NEUTRAL, DOWN, IRRITATED]) {
      // 同一 PAD,emotion 决定指令;neutral 唯一空串。
      const instr = padToVoiceInstruction(pad);
      expect(padToEmotion(pad) === 'neutral' ? instr === '' : instr.length > 0).toBe(true);
    }
  });

  it('确定性:同输入同输出', () => {
    expect(padToVoiceInstruction(DOWN)).toBe(padToVoiceInstruction(DOWN));
    expect(padToVoiceInstruction(JOYFUL)).toBe(padToVoiceInstruction({ ...JOYFUL }));
  });

  it('不含语速维度(语速归 TTS rate,避免与之打架)', () => {
    for (const pad of [JOYFUL, CONTENT, DOWN, IRRITATED]) {
      const instr = padToVoiceInstruction(pad);
      expect(instr).not.toMatch(/语速|快|慢/);
    }
  });

  it('长度 ≤ 上限(CosyVoice instruction 字符上限保护)', () => {
    for (const pad of [JOYFUL, CONTENT, NEUTRAL, DOWN, IRRITATED]) {
      expect(padToVoiceInstruction(pad).length).toBeLessThanOrEqual(VOICE_INSTRUCTION_MAX_LEN);
    }
  });
});
