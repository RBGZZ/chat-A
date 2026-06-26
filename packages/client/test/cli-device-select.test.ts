import { describe, it, expect } from 'vitest';
import { formatDeviceMenu, makeCliAudioSelect } from '../src/audio/cli-device-select';
import type { AudioDeviceInfo } from '../src/audio/device-registry';

const devs: AudioDeviceInfo[] = [
  { id: 8, name: '麦克风阵列 (Intel)', hostApi: 'WASAPI', maxInputChannels: 4, maxOutputChannels: 0, defaultSampleRate: 48000 },
  { id: 0, name: '麦克风 (Realtek)', hostApi: 'MME', maxInputChannels: 2, maxOutputChannels: 0, defaultSampleRate: 44100 },
];

describe('CLI 设备选择壳', () => {
  it('formatDeviceMenu 列出带序号/名/host/率', () => {
    const s = formatDeviceMenu('input', devs);
    expect(s).toContain('[0] 麦克风阵列 (Intel)');
    expect(s).toContain('WASAPI');
    expect(s).toContain('48000');
    expect(s).toContain('[1] 麦克风 (Realtek)');
  });

  it('promptSelect 按用户输入的序号返回对应设备', async () => {
    const sel = makeCliAudioSelect({ question: async () => '1', write: () => {}, envPath: '/tmp/x.env' });
    const chosen = await sel.promptSelect!('input', devs);
    expect(chosen!.id).toBe(0);
  });

  it('promptSelect 非法序号返回 null（回退默认）', async () => {
    const sel = makeCliAudioSelect({ question: async () => 'zzz', write: () => {}, envPath: '/tmp/x.env' });
    expect(await sel.promptSelect!('input', devs)).toBeNull();
  });
});
