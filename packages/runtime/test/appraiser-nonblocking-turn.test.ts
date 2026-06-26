import { describe, it, expect } from 'vitest';
import type { LlmProvider } from '@chat-a/providers';
import type { Appraiser } from '@chat-a/persona';
import { LightVoiceBus } from '../src/bus';
import { Conversation } from '../src/conversation';

/** 立即吐一个 token 的 LLM(回合本体极快,把唯一的慢点孤立到 appraiser)。 */
function fastLlm(): LlmProvider {
  return {
    id: 'rec',
    model: 'rec-1',
    async *stream() {
      yield 'ok';
    },
    async complete() {
      return 'ok';
    },
  };
}

/** 受控挂起 appraiser:release 前一直挂起,模拟慢 LLM 情绪评估(~0.5-0.9s)。 */
function gatedAppraiser() {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const appraiser: Appraiser = {
    appraise: async () => {
      await gate;
      return { pleasure: -0.8, arousal: 0.3, dominance: 0 };
    },
  };
  return { appraiser, release: () => release() };
}

describe('runtime/conversation: LLM 情绪评估非阻塞旁路(backgroundAppraisal)', () => {
  it('appraiser 仍挂起时 send() 已 resolve(回合关键路径不被情绪评估拖住)', async () => {
    const { appraiser, release } = gatedAppraiser();
    const convo = new Conversation({
      bus: new LightVoiceBus(),
      llm: fastLlm(),
      appraiser,
      backgroundAppraisal: true,
      sessionId: 'nb',
    });

    // appraiser 还挂着;send 必须在它 resolve 之前就返回最终回复,否则 race 取 'timeout' → 失败。
    const sendDone = convo.send('你好', () => {}).then((r) => `done:${r}` as const);
    const guard = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 300));
    const winner = await Promise.race([sendDone, guard]);
    expect(winner).toBe('done:ok');
    release();
  });

  it('未开 background:appraiser 挂起会拖住 send()(证明默认是阻塞的)', async () => {
    const { appraiser, release } = gatedAppraiser();
    const convo = new Conversation({
      bus: new LightVoiceBus(),
      llm: fastLlm(),
      appraiser,
      sessionId: 'blk',
    });

    const sendDone = convo.send('你好', () => {}).then(() => 'done' as const);
    const guard = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 150));
    const winner = await Promise.race([sendDone, guard]);
    expect(winner).toBe('timeout'); // 默认阻塞:send 被慢评估挂住
    release();
    await sendDone; // 收尾,避免悬挂
  });
});
