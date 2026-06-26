import { describe, it, expect } from 'vitest';
import { NodeAudioDevice } from '../src/audio/node-audio-device';

// 记录每次开流用的 options，供断言。
function makeSpyModule() {
  const opens: Array<{ inOptions?: any; outOptions?: any }> = [];
  const AudioIO = (opts: any) => {
    opens.push(opts);
    return { on() {}, start() {}, write() {}, quit() {} };
  };
  return { mod: { AudioIO, getDevices: () => [] }, opens };
}

describe('NodeAudioDevice 输入/输出 deviceId 分离 (bug1)', () => {
  it('采集用 inputDeviceId、播放用 outputDeviceId（不串用）', async () => {
    const { mod, opens } = makeSpyModule();
    const dev = new NodeAudioDevice({ nativeModule: 'x', deviceId: 8, outputDeviceId: 3 } as any);
    // 注入假模块：绕过真 import（构造接受 nativeModule，但我们直接喂 factory）
    (dev as any)['#factory']; // no-op 占位
    await (dev as any).initWithModule(mod); // 见实现：测试专用注入入口
    dev.captureStart(() => {});
    dev.play({ samples: new Int16Array([1, 2, 3]), sampleRate: 24000, channels: 1 });
    const inOpen = opens.find((o) => o.inOptions);
    const outOpen = opens.find((o) => o.outOptions);
    expect(inOpen!.inOptions.deviceId).toBe(8);
    expect(outOpen!.outOptions.deviceId).toBe(3); // 关键：输出不再套用输入 id 8
  });

  it('未设 outputDeviceId 时输出缺省 -1（系统默认扬声器）', async () => {
    const { mod, opens } = makeSpyModule();
    const dev = new NodeAudioDevice({ nativeModule: 'x', deviceId: 8 } as any);
    await (dev as any).initWithModule(mod);
    dev.play({ samples: new Int16Array([1]), sampleRate: 24000, channels: 1 });
    expect(opens.find((o) => o.outOptions)!.outOptions.deviceId).toBe(-1);
  });
});
