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

  it('defaultSampleRate 为 null 时回落 16000（num 不被 Number(null)=0 吞默认）', () => {
    const modNullRate = {
      getDevices: () => [
        { id: 1, name: '虚拟麦', hostAPIName: 'WASAPI', maxInputChannels: 2, maxOutputChannels: 0, defaultSampleRate: null },
      ],
    };
    const ins = listInputDevices(modNullRate);
    expect(ins).toHaveLength(1);
    expect(ins[0]!.defaultSampleRate).toBe(16000);
  });

  it('getDevices 落在 .default 上也能枚举（esm interop）', () => {
    const esmMod = {
      default: {
        getDevices: () => [
          { id: 5, name: '麦克风 (X)', hostAPIName: 'MME', maxInputChannels: 2, maxOutputChannels: 0, defaultSampleRate: 48000 },
        ],
      },
    };
    const ins = listInputDevices(esmMod);
    expect(ins.map((d) => d.id)).toEqual([5]);
  });
});
