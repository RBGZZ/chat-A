// packages/client/test/device-registry.test.ts
import { describe, it, expect } from 'vitest';
import { listInputDevices, listOutputDevices, resolveDeviceByName } from '../src/audio/device-registry';

const fakeMod = {
  getDevices: () => [
    { id: 0, name: '麦克风 (Realtek)', hostAPIName: 'MME', maxInputChannels: 2, maxOutputChannels: 0, defaultSampleRate: 44100 },
    { id: 8, name: '麦克风阵列 (Intel)', hostAPIName: 'WASAPI', maxInputChannels: 4, maxOutputChannels: 0, defaultSampleRate: 48000 },
    { id: 3, name: '扬声器 (Realtek)', hostAPIName: 'MME', maxInputChannels: 0, maxOutputChannels: 2, defaultSampleRate: 48000 },
    { id: 9, name: '麦克风阵列 (Intel)', hostAPIName: 'MME', maxInputChannels: 2, maxOutputChannels: 0, defaultSampleRate: 44100 },
  ],
};

describe('device-registry', () => {
  it('listInputDevices 只留有输入通道的，字段映射正确', () => {
    const ins = listInputDevices(fakeMod);
    expect(ins.map((d) => d.id).sort((a, b) => a - b)).toEqual([0, 8, 9]);
    const intel = ins.find((d) => d.id === 8)!;
    expect(intel).toMatchObject({ name: '麦克风阵列 (Intel)', hostApi: 'WASAPI', defaultSampleRate: 48000 });
  });

  it('listOutputDevices 只留有输出通道的', () => {
    expect(listOutputDevices(fakeMod).map((d) => d.id)).toEqual([3]);
  });

  it('resolveDeviceByName 命中返回当前 id', () => {
    const ins = listInputDevices(fakeMod);
    expect(resolveDeviceByName(ins, '麦克风 (Realtek)')!.id).toBe(0);
  });

  it('resolveDeviceByName 同名用 hostApi 消歧', () => {
    const ins = listInputDevices(fakeMod);
    expect(resolveDeviceByName(ins, '麦克风阵列 (Intel)', 'WASAPI')!.id).toBe(8);
    expect(resolveDeviceByName(ins, '麦克风阵列 (Intel)', 'MME')!.id).toBe(9);
  });

  it('resolveDeviceByName 未命中返回 null', () => {
    expect(resolveDeviceByName(listInputDevices(fakeMod), '不存在的设备')).toBeNull();
  });

  it('mod 无 getDevices 时返回空数组（降级不崩）', () => {
    expect(listInputDevices({})).toEqual([]);
    expect(listInputDevices(null)).toEqual([]);
  });
});
