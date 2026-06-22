import type { LlmProvider, LlmRequest } from './llm';

/**
 * 确定性占位 Provider(承 §3.2 可测试性):无 API key / 离线 / 测试用。
 * 逐字回放一句引用用户最后一句话的占位回复。
 */
export class FakeLlm implements LlmProvider {
  readonly id = 'fake';
  readonly model: string;

  constructor(model = 'fake-1') {
    this.model = model;
  }

  async *stream(req: LlmRequest): AsyncIterable<string> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const reply = lastUser
      ? `嗯,你说"${lastUser.content}"——我在听。(FakeLLM 占位回复;设 ANTHROPIC_API_KEY 后换真模型。)`
      : '你好,我是小雪。(FakeLLM 占位回复。)';
    for (const ch of reply) {
      yield ch;
    }
  }
}
