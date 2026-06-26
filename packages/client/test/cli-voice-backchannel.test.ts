import { describe, it, expect } from 'vitest';
import { loadBackchannelConfig } from '../src/cli-voice';

// 注:`attention_mode` 在本项目尚无「从 env 读取」的现状(runtime attention 闸 mode 由装配钩子注入),
// 故 loadBackchannelConfig 以 CHAT_A_ATTENTION_MODE 作为新键接入(详见 cli-voice.ts 文档)。
describe('loadBackchannelConfig', () => {
  it('CHAT_A_BACKCHANNEL=off → undefined(关)', () => {
    expect(loadBackchannelConfig({ CHAT_A_BACKCHANNEL: 'off' } as NodeJS.ProcessEnv)).toBeUndefined();
  });
  it('focus 档 → undefined(不附和)', () => {
    expect(loadBackchannelConfig({ CHAT_A_ATTENTION_MODE: 'focus' } as NodeJS.ProcessEnv)).toBeUndefined();
  });
  it('companion 档 → 配置且 cooldown 较短', () => {
    const c = loadBackchannelConfig({ CHAT_A_ATTENTION_MODE: 'companion' } as NodeJS.ProcessEnv);
    expect(c).toBeDefined();
    expect(c!.cooldownMs).toBe(4000);
  });
  it('balanced/缺省 → 配置且 cooldown 较长', () => {
    const c = loadBackchannelConfig({} as NodeJS.ProcessEnv);
    expect(c).toBeDefined();
    expect(c!.cooldownMs).toBe(7000);
  });
});
