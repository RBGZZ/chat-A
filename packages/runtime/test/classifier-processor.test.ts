import { describe, it, expect } from 'vitest';
import { classifyText, ClassifierProcessor } from '../src/classifier-processor';

describe('runtime/ClassifierProcessor(§4.2 三层过滤分流)', () => {
  it('剥情绪标签 → emotionTags,口语不含标签', () => {
    const r = classifyText('[微笑]你好呀,(开心)今天真不错');
    expect(r.emotionTags).toEqual(['微笑', '开心']);
    expect(r.spokenText).toBe('你好呀,今天真不错');
    // display 也剥情绪标签
    expect(r.displayText).toBe('你好呀,今天真不错');
  });

  it('剥工具调用片段:既不显示也不朗读', () => {
    const r = classifyText('我帮你查一下<tool name="weather">{"city":"上海"}</tool>好的');
    expect(r.spokenText).toBe('我帮你查一下好的');
    expect(r.displayText).toBe('我帮你查一下好的');
    expect(r.emotionTags).toEqual([]);
  });

  it('舞台指示:从口语剥离,但保留进 displayText', () => {
    const r = classifyText('（小声说）我有个秘密。');
    expect(r.spokenText).toBe('我有个秘密。'); // 不朗读舞台指示
    expect(r.displayText).toContain('小声说'); // 字幕保留动作语境
    expect(r.displayText).toContain('我有个秘密。');
  });

  it('emoji 提取为情绪标签,不朗读不显示', () => {
    const r = classifyText('太好了😄真开心');
    expect(r.emotionTags).toContain('😄');
    expect(r.spokenText).toBe('太好了真开心');
    expect(r.displayText).toBe('太好了真开心');
  });

  it('情绪标签去重保序', () => {
    const r = classifyText('[微笑]啊[微笑]哈[害羞]');
    expect(r.emotionTags).toEqual(['微笑', '害羞']);
  });

  it('纯函数:同输入同输出(golden)', () => {
    const input = '*叹气*算了吧,<tool>x</tool>（停顿）我懂了😔';
    const a = classifyText(input);
    const b = classifyText(input);
    expect(a).toEqual(b);
    // golden 快照
    expect(a).toEqual({
      spokenText: '算了吧,我懂了',
      displayText: '算了吧,（停顿）我懂了',
      emotionTags: ['叹气', '停顿', '😔'],
    });
  });

  it('类封装与纯函数语义一致', () => {
    const proc = new ClassifierProcessor();
    const input = '[开心]走啦!';
    expect(proc.classify(input)).toEqual(classifyText(input));
  });

  it('无标签纯口语:原样进 spoken/display,无 emotionTags', () => {
    const r = classifyText('这是一句普通的话。');
    expect(r.spokenText).toBe('这是一句普通的话。');
    expect(r.displayText).toBe('这是一句普通的话。');
    expect(r.emotionTags).toEqual([]);
  });
});
