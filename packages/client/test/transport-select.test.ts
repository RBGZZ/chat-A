import { describe, it, expect, vi } from 'vitest';
import { LightVoiceBus } from '@chat-a/runtime';
import { loadTransportKind, startVoiceMode, DEFAULT_GATEWAY_URL } from '../src/cli-voice';

/** 语音模式最小依赖(复用文字链路 convo/memory/bus/session 的桩)。 */
const baseDeps = () => ({
  send: async (_t: string, onToken: (s: string) => void) => {
    onToken('收到。');
    return '收到。';
  },
  memory: { appendMessage: vi.fn() },
  bus: new LightVoiceBus(),
  sessionId: 'voice-1',
});

describe('client 传输选择(行为即配置)', () => {
  it('loadTransportKind:缺省 → inprocess', () => {
    expect(loadTransportKind({})).toBe('inprocess');
    expect(loadTransportKind({ CHAT_A_TRANSPORT: '' })).toBe('inprocess');
    expect(loadTransportKind({ CHAT_A_TRANSPORT: 'inprocess' })).toBe('inprocess');
    // 未知值一律回落 inprocess(缺省零行为变更)。
    expect(loadTransportKind({ CHAT_A_TRANSPORT: 'webrtc' })).toBe('inprocess');
  });

  it('loadTransportKind:websocket(大小写不敏感)', () => {
    expect(loadTransportKind({ CHAT_A_TRANSPORT: 'websocket' })).toBe('websocket');
    expect(loadTransportKind({ CHAT_A_TRANSPORT: 'WebSocket' })).toBe('websocket');
  });

  it('回归:缺省(不设 CHAT_A_TRANSPORT)→ inprocess,info.transport=inprocess + 真 VoiceLoop 链', async () => {
    const env: NodeJS.ProcessEnv = { CHAT_A_AUDIO_DEVICE: 'fake' };
    const handle = await startVoiceMode({ ...baseDeps(), env });
    expect(handle.info.transport).toBe('inprocess');
    // STT/TTS/VAD/EOU 仍在本进程(缺省 fake/stub),与本变更前一致。
    expect(handle.info.stt).toBeDefined();
    expect(handle.info.vad).toBe('stub');
    handle.stop();
  });

  it('websocket 档:终端只起 WS transport + 设备桥,STT/TTS/VAD/EOU 标「大脑侧」,不触真网络即不崩', async () => {
    // 不起真大脑;connectClientTransport 缺省懒加载 ws 会尝试连 DEFAULT_GATEWAY_URL,
    // 但建连是异步的、且 transport 内置重连/降级——startVoiceMode 同步返回不崩即达标。
    const env: NodeJS.ProcessEnv = { CHAT_A_AUDIO_DEVICE: 'fake', CHAT_A_TRANSPORT: 'websocket' };
    const handle = await startVoiceMode({ ...baseDeps(), env });
    expect(handle.info.transport).toBe('websocket');
    expect(handle.info.stt).toBe('大脑侧');
    expect(handle.info.tts).toBe('大脑侧');
    expect(handle.info.vad).toBe('大脑侧');
    expect(handle.info.eou).toBe('大脑侧');
    handle.stop(); // 收尾不崩(关桥 + 关 transport)
  });

  it('DEFAULT_GATEWAY_URL 为本地 ws 地址(双进程手测缺省)', () => {
    expect(DEFAULT_GATEWAY_URL).toMatch(/^ws:\/\//);
  });
});
