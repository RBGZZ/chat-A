import type { LlmProvider } from '@chat-a/providers';
import { tolerantJsonParse } from '@chat-a/providers';
import type { ChatMessage, MemoryStore } from './types';

/**
 * 会话沉淀接缝(§5/§6.1 Reflection 夜间沉淀):会话结束后**异步**把整段会话蒸馏成
 * "最显著的几条高层 Q&A"+ Agent 第一人称自传记忆,经 MemoryStore.addMemory 写回中期记忆。
 * 纯 SQLite + LLM,绝不依赖向量库。返回 void:沉淀是副作用写回,调用方只想"触发一次、别崩"(§3.1)。
 */
export interface Reflector {
  /** 对指定会话做一次沉淀。幂等、失败降级,绝不抛(承 §3.2)。 */
  reflect(sessionId: string): Promise<void>;
}

/** 默认:不沉淀(沿用项目"接缝 + 默认关/降级"风格)。 */
export class NoopReflector implements Reflector {
  async reflect(_sessionId: string): Promise<void> {
    // 什么都不做。
  }
}

/**
 * 沉淀行为配置(行为即配置,§3.2):触发节奏/上限/种类/键前缀全外置,无 magic number。
 */
export interface ReflectionConfig {
  /** 触发节奏:'session-end'=会话结束触发(默认);'off'=不沉淀(等价 Noop 语义)。 */
  readonly enabled: 'session-end' | 'off';
  /** 高层 Q&A 写回条数上限(防失控)。 */
  readonly maxHighlights: number;
  /** 沉淀写回的 kind 标签(高层 Q&A 与第一人称自传共用)。 */
  readonly reflectionKind: string;
  /** 幂等标记键前缀:实际键为 `${prefix}${sessionId}`。 */
  readonly diaryStateKeyPrefix: string;
  /** LLM 蒸馏的生成 token 上限。 */
  readonly maxTokens: number;
}

export const DEFAULT_REFLECTION_CONFIG: ReflectionConfig = {
  enabled: 'session-end',
  maxHighlights: 5,
  reflectionKind: 'reflection',
  diaryStateKeyPrefix: 'diary_',
  maxTokens: 512,
};

/** 合并用户覆盖与默认值。 */
export function resolveReflectionConfig(overrides?: Partial<ReflectionConfig>): ReflectionConfig {
  return { ...DEFAULT_REFLECTION_CONFIG, ...overrides };
}

export interface LlmReflectorOptions {
  readonly provider: LlmProvider;
  readonly store: MemoryStore;
  readonly config?: Partial<ReflectionConfig>;
  /** 读取本会话消息的条数上限(省略用 store 的配置默认)。 */
  readonly messageLimit?: number;
  readonly onError?: (err: unknown) => void;
}

/** 解析后的蒸馏结果(校验后)。 */
interface Distilled {
  readonly highlights: readonly string[];
  readonly diary?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 把整段会话渲染为提示里的对话文本。 */
function renderTranscript(messages: readonly ChatMessage[]): string {
  return messages
    .map((m) => `${m.role === 'assistant' ? '小雪' : m.role === 'user' ? '用户' : m.role}：${m.content}`)
    .join('\n');
}

function buildPrompt(transcript: string): string {
  return [
    '下面是一段「用户」与「小雪」的完整对话。请做会话沉淀,蒸馏出:',
    '1) highlights:最显著的几条高层 Q&A(主旨级,不是逐句复述),每条形如 {"q":"...","a":"..."};没有则空数组。',
    '2) diary:以「小雪」第一人称写一小段这次聊天的自传/感受(我……),简洁真诚;没有可省略或空串。',
    '只输出 JSON 对象,形如 {"highlights":[{"q":"...","a":"..."}],"diary":"..."},不要解释。',
    '对话:',
    transcript,
  ].join('\n');
}

/** 校验解析结果为 Distilled(丢弃非法项)。 */
function toDistilled(v: unknown, maxHighlights: number): Distilled {
  const highlights: string[] = [];
  let diary: string | undefined;
  if (isRecord(v)) {
    const rawHi = v['highlights'];
    if (Array.isArray(rawHi)) {
      for (const item of rawHi) {
        if (highlights.length >= maxHighlights) break;
        if (!isRecord(item)) continue;
        const q = typeof item['q'] === 'string' ? item['q'].trim() : '';
        const a = typeof item['a'] === 'string' ? item['a'].trim() : '';
        if (q.length === 0 && a.length === 0) continue;
        // 拼成单条可去重/可召回的文本(§5.8 复用 ADD 去重)。
        highlights.push(`Q：${q} A：${a}`.trim());
      }
    }
    const rawDiary = v['diary'];
    if (typeof rawDiary === 'string' && rawDiary.trim().length > 0) {
      diary = rawDiary.trim();
    }
  }
  return diary !== undefined ? { highlights, diary } : { highlights };
}

/**
 * LLM 会话沉淀:取本会话消息 → 一次 complete 蒸馏 → 经 addMemory 写回(复用 ADD+去重)。
 * 幂等(kv_state 标记)、全程降级(无消息/LLM 失败/解析失败都安静跳过,绝不抛,§3.2)。
 */
export class LlmReflector implements Reflector {
  readonly #provider: LlmProvider;
  readonly #store: MemoryStore;
  readonly #cfg: ReflectionConfig;
  readonly #messageLimit: number | undefined;
  readonly #onError: ((err: unknown) => void) | undefined;

  constructor(opts: LlmReflectorOptions) {
    this.#provider = opts.provider;
    this.#store = opts.store;
    this.#cfg = resolveReflectionConfig(opts.config);
    this.#messageLimit = opts.messageLimit;
    this.#onError = opts.onError;
  }

  async reflect(sessionId: string): Promise<void> {
    // 关闭即等价 Noop(行为即配置,§3.2)。
    if (this.#cfg.enabled === 'off') return;

    const stateKey = this.#cfg.diaryStateKeyPrefix + sessionId;
    // 幂等:已沉淀过该会话则安静跳过(不调 LLM、不写回)。
    try {
      if (this.#store.getState(stateKey) !== undefined) return;
    } catch (err) {
      // 读状态失败也降级跳过(不阻塞退出)。
      this.#onError?.(err);
      return;
    }

    // 取本会话消息;无消息则跳过(不调 LLM、不打标记,下次有消息再试)。
    const messages =
      this.#messageLimit !== undefined
        ? this.#store.messagesForSession(sessionId, this.#messageLimit)
        : this.#store.messagesForSession(sessionId);
    if (messages.length === 0) return;

    let distilled: Distilled;
    try {
      const text = await this.#provider.complete({
        system: '你是会话沉淀器,只输出 JSON 对象,不要解释。',
        messages: [{ role: 'user', content: buildPrompt(renderTranscript(messages)) }],
        maxTokens: this.#cfg.maxTokens,
      });
      distilled = toDistilled(tolerantJsonParse(text), this.#cfg.maxHighlights);
    } catch (err) {
      // LLM 失败:降级跳过,不打标记(允许下次重试)。
      this.#onError?.(err);
      return;
    }

    // 写回:高层 Q&A → shared;第一人称自传 → agent(承 §5.3)。经 addMemory 复用 ADD+去重。
    let written = 0;
    for (const text of distilled.highlights) {
      this.#store.addMemory({ text, kind: this.#cfg.reflectionKind, subject: 'shared' });
      written += 1;
    }
    if (distilled.diary !== undefined) {
      this.#store.addMemory({ text: distilled.diary, kind: this.#cfg.reflectionKind, subject: 'agent' });
      written += 1;
    }

    // 仅在确实写回 ≥1 条后打幂等标记(纯失败/全非法不打,下次可重试)。
    if (written > 0) {
      this.#store.setState(stateKey, JSON.stringify({ at: Date.now(), count: written }));
    }
  }
}
