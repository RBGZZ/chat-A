import { describe, it, expect } from 'vitest';
import { assembleApp } from '../src/assembly/app';

/**
 * `assembleApp()` 共享会话装配单测(承 desktop-electron-frontend §8):
 * FakeLLM(无 key)+ 内存 memory backend → 不触网、不落库,可在 CI 直接跑。
 * 验:发文字收流式 token + 非空 reply / reset 换 sessionId / cleanup 幂等。
 */
function fakeEnv(): NodeJS.ProcessEnv {
  return {
    CHAT_A_LLM_PROVIDER: 'fake',
    CHAT_A_MEMORY_BACKEND: 'memory',
  };
}

describe('assembleApp 核心装配(FakeLLM,不触网)', () => {
  it('发文字 → 收到流式 token + 非空 reply', async () => {
    const app = assembleApp({ env: fakeEnv(), loadEnv: false });
    expect(app.llmConfig.provider).toBe('fake');
    const tokens: string[] = [];
    const reply = await app.convo.send('你好', (t) => tokens.push(t));
    expect(tokens.length).toBeGreaterThan(0);
    expect(reply.length).toBeGreaterThan(0);
    expect(tokens.join('')).toBe(reply);
    await app.cleanup();
  });

  it('reset() 换 sessionId 并重建 convo(长期记忆仍由同一 store 持有)', async () => {
    const app = assembleApp({ env: fakeEnv(), loadEnv: false });
    const sid0 = app.sessionId;
    const convo0 = app.convo;
    const sid1 = app.reset();
    expect(sid1).not.toBe(sid0);
    expect(app.sessionId).toBe(sid1);
    expect(app.convo).not.toBe(convo0);
    await app.cleanup();
  });

  it('cleanup() 幂等:多次调用不抛', async () => {
    const app = assembleApp({ env: fakeEnv(), loadEnv: false });
    await expect(app.cleanup()).resolves.toBeUndefined();
    await expect(app.cleanup()).resolves.toBeUndefined();
    await expect(app.cleanup()).resolves.toBeUndefined();
  });

  it('暴露 bus / persona / memoryInfo 供前端复用', async () => {
    const app = assembleApp({ env: fakeEnv(), loadEnv: false });
    expect(app.bus).toBeDefined();
    expect(app.memoryInfo.backend).toBe('memory');
    const tone = app.persona.tone();
    expect(typeof tone.emotion).toBe('string');
    await app.cleanup();
  });

  it('personaView() 读名字 + 三档', async () => {
    const app = assembleApp({ env: fakeEnv(), loadEnv: false });
    const v = app.personaView();
    expect(v.name).toBe(app.seed.name);
    expect(v.warmth).toBe(app.seed.dials.baselineWarmth);
    expect(v.expressiveness).toBe(app.seed.dials.expressiveness);
    expect(v.volatility).toBe(app.seed.dials.emotionalVolatility);
    await app.cleanup();
  });

  it('applyPersona() 运行时生效:换种子 + 重建引擎/会话(sessionId 不变,记忆续接)', async () => {
    const app = assembleApp({ env: fakeEnv(), loadEnv: false });
    const sid0 = app.sessionId;
    const persona0 = app.persona;
    const convo0 = app.convo;
    const view = app.applyPersona({ name: '阿狸', warmth: 1.5, expressiveness: 0, volatility: 0.8 });
    // 返回值与读路径一致,且夹取生效
    expect(view.name).toBe('阿狸');
    expect(view.warmth).toBe(1); // 1.5 → 夹到 1
    expect(view.volatility).toBe(0.8);
    expect(app.personaView()).toEqual(view);
    // seed/persona/convo 已换新;sessionId 不变(对话不断)
    expect(app.seed.name).toBe('阿狸');
    expect(app.seed.dials.baselineWarmth).toBe(1);
    expect(app.persona).not.toBe(persona0);
    expect(app.convo).not.toBe(convo0);
    expect(app.sessionId).toBe(sid0);
    // 新引擎仍可读 tone(PAD 从同一 store 续接)
    expect(typeof app.persona.tone().emotion).toBe('string');
    await app.cleanup();
  });

  it('applyPersona() 空补丁不改名字/三档', async () => {
    const app = assembleApp({ env: fakeEnv(), loadEnv: false });
    const before = app.personaView();
    const after = app.applyPersona({});
    expect(after).toEqual(before);
    await app.cleanup();
  });
});
