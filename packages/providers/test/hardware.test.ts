import { describe, it, expect } from 'vitest';
import {
  resolveHardwareDefaults,
  applyHardwareDefaults,
  loadSttConfig,
  loadTtsConfig,
  loadEmbedderConfig,
  loadLlmConfig,
  createStt,
  createTts,
  createEmbedder,
} from '../src/index';
import type { Device, ComputeType, HardwareProfile } from '../src/index';

describe('resolveHardwareDefaults(profile → 默认 device/computeType,§5.10 C1)', () => {
  it('pc → { cuda, float16 }', () => {
    expect(resolveHardwareDefaults('pc')).toEqual({ device: 'cuda', computeType: 'float16' });
  });

  it('raspberry → { cpu, int8 }', () => {
    expect(resolveHardwareDefaults('raspberry')).toEqual({ device: 'cpu', computeType: 'int8' });
  });

  it('browser → { cpu, int8 }', () => {
    expect(resolveHardwareDefaults('browser')).toEqual({ device: 'cpu', computeType: 'int8' });
  });

  it('纯函数:多次调用产物相等', () => {
    const profiles: readonly HardwareProfile[] = ['pc', 'raspberry', 'browser'];
    for (const p of profiles) {
      expect(resolveHardwareDefaults(p)).toEqual(resolveHardwareDefaults(p));
    }
  });
});

describe('applyHardwareDefaults(显式值优先,缺失用 profile 默认填)', () => {
  it('未指定 device/computeType → 用 profile 默认填(pc)', () => {
    expect(applyHardwareDefaults({}, 'pc')).toEqual({ device: 'cuda', computeType: 'float16' });
  });

  it('未指定 → 用 profile 默认填(raspberry)', () => {
    expect(applyHardwareDefaults({}, 'raspberry')).toEqual({ device: 'cpu', computeType: 'int8' });
  });

  it('显式 device 覆盖 profile 默认,computeType 仍取默认', () => {
    const out = applyHardwareDefaults({ device: 'cpu' as Device }, 'pc');
    expect(out).toEqual({ device: 'cpu', computeType: 'float16' });
  });

  it('显式 computeType 覆盖 profile 默认,device 仍取默认', () => {
    const out = applyHardwareDefaults({ computeType: 'int8_float16' as ComputeType }, 'pc');
    expect(out).toEqual({ device: 'cuda', computeType: 'int8_float16' });
  });

  it('两者都显式 → 完全保留,不被 profile 覆盖', () => {
    const out = applyHardwareDefaults(
      { device: 'auto' as Device, computeType: 'float32' as ComputeType },
      'raspberry',
    );
    expect(out).toEqual({ device: 'auto', computeType: 'float32' });
  });

  it('保留 cfg 上的其它字段(纯加法合并)', () => {
    const out = applyHardwareDefaults({ model: 'large-v3' as string, device: 'cuda' as Device }, 'pc');
    expect(out).toEqual({ model: 'large-v3', device: 'cuda', computeType: 'float16' });
  });
});

describe('向后兼容:新字段省略时各 config/工厂行为与现状一致', () => {
  it('loadSttConfig 全空 → 仍降级 fake(无新键)', () => {
    expect(loadSttConfig({})).toEqual({ kind: 'fake' });
  });

  it('loadSttConfig whisper-local 不带 device/computeType/requiresCuda → 不含这些键(exactOptional 合规)', () => {
    const cfg = loadSttConfig({ CHAT_A_STT_KIND: 'whisper-local', CHAT_A_STT_MODEL: 'large-v3' });
    expect(cfg).toEqual({ kind: 'whisper-local', model: 'large-v3' });
    expect('device' in cfg).toBe(false);
    expect('computeType' in cfg).toBe(false);
    expect('requiresCuda' in cfg).toBe(false);
  });

  it('loadSttConfig whisper-local 显式 device/computeType/requiresCuda → 透传(含新 int8_float16)', () => {
    const cfg = loadSttConfig({
      CHAT_A_STT_KIND: 'whisper-local',
      CHAT_A_STT_MODEL: 'large-v3',
      CHAT_A_STT_DEVICE: 'cuda',
      CHAT_A_STT_COMPUTE_TYPE: 'int8_float16',
      CHAT_A_STT_REQUIRES_CUDA: 'true',
    });
    expect(cfg).toEqual({
      kind: 'whisper-local',
      model: 'large-v3',
      device: 'cuda',
      computeType: 'int8_float16',
      requiresCuda: true,
    });
  });

  it('loadTtsConfig 全空 → 仍降级 fake', () => {
    expect(loadTtsConfig({})).toEqual({ kind: 'fake' });
  });

  it('loadEmbedderConfig 全空 → 仍降级 hash(无新键)', () => {
    const cfg = loadEmbedderConfig({});
    expect(cfg).toEqual({ kind: 'hash' });
    expect('device' in cfg).toBe(false);
    expect('computeType' in cfg).toBe(false);
  });

  it('loadLlmConfig 不带硬件字段 → 不含 device/computeType/requiresCuda 键', () => {
    const cfg = loadLlmConfig({ CHAT_A_LLM_PROVIDER: 'fake' });
    expect('device' in cfg).toBe(false);
    expect('computeType' in cfg).toBe(false);
    expect('requiresCuda' in cfg).toBe(false);
  });

  it('工厂照常工作:省略新字段的 config 仍能建 provider/embedder', () => {
    expect(() => createStt({ kind: 'fake' })).not.toThrow();
    expect(() => createTts({ kind: 'fake' })).not.toThrow();
    expect(() => createEmbedder({ kind: 'hash' })).not.toThrow();
  });

  it('embedder openai-compat 类型允许显式硬件字段,工厂照常建出(本地 BGE-M3 档,纯加法)', () => {
    const built = createEmbedder({
      kind: 'openai-compat',
      model: 'bge-m3',
      apiKey: 'k',
      baseURL: 'http://localhost:8000/v1',
      dimension: 1024,
      device: 'cuda',
      computeType: 'float16',
    });
    expect(built.dimension).toBe(1024);
  });
});
