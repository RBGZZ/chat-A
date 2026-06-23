import { describe, it, expect } from 'vitest';
import { parseDotEnv, applyDotEnv } from '../src/env-file';

/**
 * .env.local 解析/应用纯逻辑测试(对齐 start.bat 语义:eol=#、tokens=1,*、真实 env 优先)。
 */
describe('client/parseDotEnv', () => {
  it('解析 KEY=VALUE 基本行', () => {
    const parsed = parseDotEnv('CHAT_A_LLM_API_KEY=sk-abc\n');
    expect(parsed).toEqual({ CHAT_A_LLM_API_KEY: 'sk-abc' });
  });

  it('跳过注释行(# 开头)与空行', () => {
    const text = ['# 这是注释', '', '   ', 'A=1', '#B=2', 'C=3'].join('\n');
    expect(parseDotEnv(text)).toEqual({ A: '1', C: '3' });
  });

  it('只切第一个 =,value 中其余 = 完整保留', () => {
    const parsed = parseDotEnv('URL=https://x.y/z?a=1&b=2\n');
    expect(parsed['URL']).toBe('https://x.y/z?a=1&b=2');
  });

  it('去掉 key/value 首尾空白', () => {
    const parsed = parseDotEnv('  KEY  =  value  \n');
    expect(parsed).toEqual({ KEY: 'value' });
  });

  it('去掉 value 两侧成对引号(单/双)', () => {
    expect(parseDotEnv('A="hello world"\n')['A']).toBe('hello world');
    expect(parseDotEnv("B='hi'\n")['B']).toBe('hi');
    // 不成对的引号原样保留
    expect(parseDotEnv('C="oops\n')['C']).toBe('"oops');
  });

  it('忽略没有 = 的行与空 key', () => {
    expect(parseDotEnv('NOEQUALS\n=novalue\n')).toEqual({});
  });

  it('CRLF 行尾也能解析', () => {
    expect(parseDotEnv('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });
});

describe('client/applyDotEnv', () => {
  it('注入不存在的键', () => {
    const env: NodeJS.ProcessEnv = {};
    applyDotEnv({ A: '1', B: '2' }, env);
    expect(env['A']).toBe('1');
    expect(env['B']).toBe('2');
  });

  it('不覆盖已存在(非空)的真实环境变量', () => {
    const env: NodeJS.ProcessEnv = { A: 'real' };
    applyDotEnv({ A: 'fromfile', B: '2' }, env);
    expect(env['A']).toBe('real'); // 真实 env 优先
    expect(env['B']).toBe('2');
  });

  it('覆盖已存在但为空字符串的键', () => {
    const env: NodeJS.ProcessEnv = { A: '' };
    applyDotEnv({ A: 'fromfile' }, env);
    expect(env['A']).toBe('fromfile');
  });
});
