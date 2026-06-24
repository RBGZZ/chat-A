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

  // —— 三语种 + 朗读(本批次) ——
  it('缺省 displayLang 为空(自动);TTS 默认 fake(朗读不可用判定用)', async () => {
    const app = assembleApp({ env: fakeEnv(), loadEnv: false });
    expect(app.displayLang).toBe('');
    expect(app.ttsConfig.kind).toBe('fake');
    expect(app.tts).toBeDefined();
    await app.cleanup();
  });

  it('CHAT_A_DISPLAY_LANG 初值接进 displayLang', async () => {
    const app = assembleApp({ env: { ...fakeEnv(), CHAT_A_DISPLAY_LANG: 'en' }, loadEnv: false });
    expect(app.displayLang).toBe('en');
    await app.cleanup();
  });

  it('applyLang({displayLang}) 改语种 → 重建 convo(sessionId 不变)+ 同步 env', async () => {
    const env = fakeEnv();
    const app = assembleApp({ env, loadEnv: false });
    const sid0 = app.sessionId;
    const convo0 = app.convo;
    const out = app.applyLang({ displayLang: 'ja' });
    expect(out.displayLang).toBe('ja');
    expect(app.displayLang).toBe('ja');
    expect(env['CHAT_A_DISPLAY_LANG']).toBe('ja');
    // 重建会话但 sessionId 不变(对话不断、记忆续接)。
    expect(app.convo).not.toBe(convo0);
    expect(app.sessionId).toBe(sid0);
    // 仍可正常对话。
    const reply = await app.convo.send('test', () => {});
    expect(reply.length).toBeGreaterThan(0);
    await app.cleanup();
  });

  it('applyLang({displayLang 不变}) 不重建 convo', async () => {
    const app = assembleApp({ env: { ...fakeEnv(), CHAT_A_DISPLAY_LANG: 'zh' }, loadEnv: false });
    const convo0 = app.convo;
    app.applyLang({ displayLang: 'zh' });
    expect(app.convo).toBe(convo0); // 同值 → 不重建
    await app.cleanup();
  });

  it('applyLang 同步 ttsLang/cloneRefLang/speak 到 env(供 voice-profile/朗读读取)', async () => {
    const env = fakeEnv();
    const app = assembleApp({ env, loadEnv: false });
    const out = app.applyLang({ ttsLang: 'en', cloneRefLang: 'zh', speak: true });
    expect(env['CHAT_A_TTS_LANG']).toBe('en');
    expect(env['CHAT_A_VOICE_CLONE_REF_LANG']).toBe('zh');
    expect(env['CHAT_A_DESKTOP_SPEAK']).toBe('on');
    expect(out.ttsLang).toBe('en');
    expect(out.cloneRefLang).toBe('zh');
    expect(out.speak).toBe(true);
    // speak:false → off
    expect(app.applyLang({ speak: false }).speak).toBe(false);
    expect(env['CHAT_A_DESKTOP_SPEAK']).toBe('off');
    await app.cleanup();
  });
});
