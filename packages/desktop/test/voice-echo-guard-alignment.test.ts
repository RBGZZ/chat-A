/**
 * desktop EchoGuard 对齐契约(barge-in-polish §3):
 *
 * desktop 的 `voiceStart`(main.ts)经**共用**的 `@chat-a/client` `startVoiceMode(deps)` 启动免提语音并
 * 透传 `env`;`startVoiceMode` 内部统一调 `loadEchoGuardConfig(env)` 注入 EchoGuard。故 desktop 与 cli
 * **共用同一条 EchoGuard 装配路径**,desktop 不存在「漏注入 EchoGuard」缺口,自动继承去抖默认。
 *
 * 本测试钉死该契约:用 desktop 透传的同款 deps 形态调 `startVoiceMode`,验证缺省下 EchoGuard 被注入
 *(`info.echoGuard==='on'`)、`CHAT_A_ECHO_GUARD=off` 时显式关(`'off'`)。若未来 desktop 自起 loop
 * 绕开 `startVoiceMode` 导致回声防护回退,此测试即红。纯 headless(Fake 设备),不触网、不依赖 Electron。
 */
import { describe, it, expect, vi } from 'vitest';
import { startVoiceMode } from '@chat-a/client';
import { LightVoiceBus } from '@chat-a/runtime';

/** desktop `voiceStart` 透传给 startVoiceMode 的最小 deps 形态(send/memory/bus/sessionId/env)。 */
function desktopStyleDeps() {
  return {
    send: async (_t: string, onToken: (s: string) => void) => {
      onToken('收到。');
      return '收到。';
    },
    memory: { appendMessage: vi.fn() },
    bus: new LightVoiceBus(),
    sessionId: 'desktop-voice-1',
  };
}

describe('desktop/EchoGuard 对齐:voiceStart 经共用 startVoiceMode 注入自打断防护', () => {
  it('缺省 → info.echoGuard=on(desktop 免提默认启用 EchoGuard,与 cli 一致,无漏注入缺口)', async () => {
    const env: NodeJS.ProcessEnv = { CHAT_A_AUDIO_DEVICE: 'fake' };
    const handle = await startVoiceMode({ ...desktopStyleDeps(), env });
    expect(handle.info.echoGuard).toBe('on');
    handle.stop();
  });

  it('CHAT_A_ECHO_GUARD=off → info.echoGuard=off(显式关回落现状,与 cli 同语义)', async () => {
    const env: NodeJS.ProcessEnv = { CHAT_A_AUDIO_DEVICE: 'fake', CHAT_A_ECHO_GUARD: 'off' };
    const handle = await startVoiceMode({ ...desktopStyleDeps(), env });
    expect(handle.info.echoGuard).toBe('off');
    handle.stop();
  });
});
