import { describe, it, expect } from 'vitest';
import { tolerantJsonParse, FakeLlm } from '../src/index';

describe('providers/tolerantJsonParse', () => {
  it('直接合法 JSON', () => {
    expect(tolerantJsonParse('{"a":1}')).toEqual({ a: 1 });
  });
  it('剥 ```json 围栏```', () => {
    expect(tolerantJsonParse('好的:\n```json\n{"p":-0.5}\n```\n')).toEqual({ p: -0.5 });
  });
  it('前后夹带文字时截取首个平衡对象', () => {
    expect(tolerantJsonParse('这是评估 {"pleasure": 0.3, "s": "}"} 完毕')).toEqual({ pleasure: 0.3, s: '}' });
  });
  it('数组也能截取', () => {
    expect(tolerantJsonParse('结果:[{"text":"爱猫"}]')).toEqual([{ text: '爱猫' }]);
  });
  it('纯非法返回 null', () => {
    expect(tolerantJsonParse('完全不是 JSON')).toBeNull();
  });
});

describe('providers/FakeLlm.complete', () => {
  it('罐装返回 + 默认回声', async () => {
    const canned = new FakeLlm('fake-1', { complete: '{"ok":true}' });
    expect(await canned.complete({ system: '', messages: [] })).toBe('{"ok":true}');
    const echo = new FakeLlm();
    expect(await echo.complete({ system: '', messages: [{ role: 'user', content: '你好' }] })).toContain('你好');
  });
});
