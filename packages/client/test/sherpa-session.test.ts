import { describe, it, expect } from 'vitest';
import {
  createSherpaVadSession,
  createSherpaEouSession,
} from '../src/audio/sherpa-vad-session';

// ───────────────────────────── 鸭子类型假 sherpa 模块 ─────────────────────────────
// 不引真原生库:用注入式 importer 喂各种导出形状,验「能挑出推理面 / 装不上报错 / 形状不符报错」。

/** 顶层具名 `infer` 方法:返回首样本的绝对值(确定性,供断言转调成功)。 */
const fakeModuleNamedInfer = {
  infer(samples: Float32Array): number {
    return Math.abs(samples[0] ?? 0);
  },
};

/** default 导出一个函数。 */
const fakeModuleDefaultFn = {
  default: (samples: Float32Array): number => Math.abs(samples[0] ?? 0),
};

/** 形状不符:既无顶层函数也无已知方法名。 */
const fakeModuleBadShape = {
  Vad: class {
    acceptWaveform(): void {}
  },
};

describe('client/sherpa-vad-session 工厂', () => {
  it('鸭子挑出顶层 infer 方法并包成 VadInferenceSession(转调 + 概率钳位)', async () => {
    const session = await createSherpaVadSession({
      nativeModule: 'fake-sherpa',
      importer: async () => fakeModuleNamedInfer,
    });
    // infer 转调底层得首样本绝对值;>1 被钳到 1。
    expect(session.infer(Float32Array.from([0.7]))).toBeCloseTo(0.7, 5);
    expect(session.infer(Float32Array.from([2.5]))).toBe(1); // 越界钳位
    expect(() => session.reset()).not.toThrow();
  });

  it('鸭子挑出 default 函数并包成 EouInferenceSession', async () => {
    const session = await createSherpaEouSession({
      nativeModule: 'fake-sherpa',
      importer: async () => fakeModuleDefaultFn,
    });
    expect(session.infer(Float32Array.from([0.3]))).toBeCloseTo(0.3, 5);
    expect(() => session.reset()).not.toThrow();
  });

  it('模块装不上 → 抛明确中文错误(含安装提示)', async () => {
    await expect(
      createSherpaVadSession({
        nativeModule: 'does-not-exist',
        importer: async () => {
          throw new Error('Cannot find module');
        },
      }),
    ).rejects.toThrow(/未能加载真 VAD 推理库.*pnpm add.*C\+\+/s);
  });

  it('模块加载但形状不符 → 抛明确中文错误(指明补薄适配)', async () => {
    await expect(
      createSherpaEouSession({
        nativeModule: 'fake-sherpa',
        importer: async () => fakeModuleBadShape,
      }),
    ).rejects.toThrow(/未挑到.*薄适配|sherpa-vad-session/s);
  });

  it('模块名解析:显式参数 > env', async () => {
    let askedFor = '';
    const session = await createSherpaVadSession({
      nativeModule: 'explicit-module',
      env: { CHAT_A_SHERPA_MODULE: 'env-module' },
      importer: async (name) => {
        askedFor = name;
        return fakeModuleNamedInfer;
      },
    });
    expect(askedFor).toBe('explicit-module'); // 显式优先
    expect(session.infer(Float32Array.from([0.1]))).toBeCloseTo(0.1, 5);
  });
});
