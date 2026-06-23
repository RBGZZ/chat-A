import { describe, it, expect } from 'vitest';
import {
  createEmbedder,
  listEmbedderKinds,
  loadEmbedderConfig,
  HashEmbedder,
  OpenAiCompatEmbedder,
} from '../src/index';
import type { EmbedderConfig } from '../src/index';

describe('createEmbedder(工厂按判别联合切换)', () => {
  it('kind: hash → HashEmbedder(维度可由 config 透传)', () => {
    const e = createEmbedder({ kind: 'hash', dimension: 256 });
    expect(e).toBeInstanceOf(HashEmbedder);
    expect(e.id).toBe('hash');
    expect(e.dimension).toBe(256);
  });

  it('kind: hash 不带维度 → 用实现默认 384', () => {
    const e = createEmbedder({ kind: 'hash' });
    expect(e.dimension).toBe(384);
  });

  it('kind: openai-compat → OpenAiCompatEmbedder(声明维度透传)', () => {
    const e = createEmbedder({
      kind: 'openai-compat',
      model: 'bge-m3',
      apiKey: 'k',
      baseURL: 'http://localhost:8000/v1',
      dimension: 1024,
    });
    expect(e).toBeInstanceOf(OpenAiCompatEmbedder);
    expect(e.id).toBe('openai-compat');
    expect(e.name).toBe('bge-m3');
    expect(e.dimension).toBe(1024);
  });

  it('openai-compat 自定义 id 透传为 trace 标识', () => {
    const e = createEmbedder({
      kind: 'openai-compat',
      id: 'bge-local',
      model: 'bge-m3',
      apiKey: 'k',
      baseURL: 'http://localhost:8000/v1',
      dimension: 1024,
    });
    expect(e.id).toBe('bge-local');
  });

  it('未知 kind → 抛错并列出已注册项', () => {
    expect(() => createEmbedder({ kind: 'nope' } as unknown as EmbedderConfig)).toThrow(
      /unknown embedder kind "nope"/,
    );
  });

  it('已注册的 kind 列表', () => {
    expect([...listEmbedderKinds()].sort()).toEqual(['hash', 'openai-compat']);
  });
});

describe('loadEmbedderConfig(环境变量 → 判别联合,缺项降级 Hash)', () => {
  it('全空 env → 降级到 hash', () => {
    expect(loadEmbedderConfig({})).toEqual({ kind: 'hash' });
  });

  it('齐备 openai-compat 字段 → openai-compat', () => {
    const cfg = loadEmbedderConfig({
      CHAT_A_EMBEDDER_MODEL: 'bge-m3',
      CHAT_A_EMBEDDER_API_KEY: 'k',
      CHAT_A_EMBEDDER_BASE_URL: 'http://localhost:8000/v1',
      CHAT_A_EMBEDDER_DIMENSION: '1024',
    });
    expect(cfg).toEqual({
      kind: 'openai-compat',
      model: 'bge-m3',
      apiKey: 'k',
      baseURL: 'http://localhost:8000/v1',
      dimension: 1024,
    });
  });

  it('显式 hash + 维度', () => {
    expect(loadEmbedderConfig({ CHAT_A_EMBEDDER_KIND: 'hash', CHAT_A_EMBEDDER_DIMENSION: '128' })).toEqual({
      kind: 'hash',
      dimension: 128,
    });
  });

  it('exactOptionalPropertyTypes 合规:hash 不带维度时不含 dimension 键', () => {
    const cfg = loadEmbedderConfig({ CHAT_A_EMBEDDER_KIND: 'hash' });
    expect('dimension' in cfg).toBe(false);
  });

  it('loadEmbedderConfig 产物可直接喂 createEmbedder', () => {
    const e = createEmbedder(
      loadEmbedderConfig({
        CHAT_A_EMBEDDER_MODEL: 'm',
        CHAT_A_EMBEDDER_API_KEY: 'k',
        CHAT_A_EMBEDDER_BASE_URL: 'http://x/v1',
        CHAT_A_EMBEDDER_DIMENSION: '768',
      }),
    );
    expect(e.dimension).toBe(768);
  });
});
