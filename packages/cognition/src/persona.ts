import { XIAOXUE_SEED, type PersonaSeed } from '@chat-a/persona';

/**
 * system 静态骨架组装(承 §6.1/§6.2):由人格种子的身份/背景/说话风格文本构成。
 * 情绪 tone fragment(随心情每轮变化)由回合编排层另行拼接,不在此。
 */
export function buildSystemPrompt(seed: PersonaSeed = XIAOXUE_SEED): string {
  return seed.identity;
}
