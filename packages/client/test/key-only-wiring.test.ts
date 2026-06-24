import { describe, it, expect, vi } from 'vitest';
import { LightVoiceBus } from '@chat-a/runtime';
import { startVoiceMode, createDetectors, createAudioDevice } from '../src/cli-voice';

const baseDeps = () => ({
  send: async (_t: string, onToken: (s: string) => void) => {
    onToken('收到。');
    return '收到。';
  },
  memory: { appendMessage: vi.fn() },
  bus: new LightVoiceBus(),
  sessionId: 'voice-1',
});

describe('client/createAudioDevice — wav 档(无原生依赖)', () => {
  it('CHAT_A_AUDIO_DEVICE=wav(无输入 WAV)→ WavFileAudioDevice,id=wav', async () => {
    const { device, real } = await createAudioDevice({ CHAT_A_AUDIO_DEVICE: 'wav' });
    expect(device.id).toBe('wav');
    expect(real).toBe(true);
    device.close();
  });

  it('缺省 → fake(回归不破)', async () => {
    const { device, real } = await createAudioDevice({});
    expect(device.id).toBe('fake');
    expect(real).toBe(false);
    device.close();
  });
});

describe('client/createDetectors — energy 档(无模型)', () => {
  it('CHAT_A_VAD=energy → 能量 VAD + 静音超时 EOU', async () => {
    const d = await createDetectors({ CHAT_A_VAD: 'energy' });
    expect(d.vadKind).toBe('energy');
    expect(d.eouKind).toBe('silence-timeout');
  });

  it('缺省 → stub(回归不破)', async () => {
    const d = await createDetectors({});
    expect(d.vadKind).toBe('stub');
    expect(d.eouKind).toBe('stub');
  });
});

describe('client/startVoiceMode — wav 设备 + energy VAD 装配不崩', () => {
  it('装配链接通,info 反映实际档', async () => {
    const env: NodeJS.ProcessEnv = { CHAT_A_AUDIO_DEVICE: 'wav', CHAT_A_VAD: 'energy' };
    const handle = await startVoiceMode({ ...baseDeps(), env });
    expect(handle.info.device).toContain('wav');
    expect(handle.info.vad).toBe('energy');
    expect(handle.info.eou).toBe('silence-timeout');
    handle.stop();
  });
});
