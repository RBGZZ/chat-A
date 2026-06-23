import type { ChatMessage, ToolCall } from '@chat-a/protocol';
import type { LlmProvider, LlmRequest, LlmStreamEvent, LlmToolResponse } from './llm';

/**
 * 工具桩脚本的一"轮"(承 §3.2 record-replay):
 * - `text`:本轮模型吐的文本(可空)。
 * - `toolCalls`:本轮发起的 tool_use 调用(0..N);非空则停因为 'tool_use'。
 * 多轮按"收到 tool_result 回传"推进:每检测到请求里新增一批 toolResults 即前进一轮,
 * 模拟未来 Agent loop 的「调用→执行→回传→续写」往返。
 */
export interface FakeToolTurn {
  readonly text?: string;
  readonly toolCalls?: readonly ToolCall[];
}

/**
 * 确定性占位 Provider(承 §3.2 可测试性):无 API key / 离线 / 测试用。
 * 逐字回放一句引用用户最后一句话的占位回复。
 */
export interface FakeLlmOptions {
  /** complete() 的罐装返回(record-replay 用):字符串或按请求计算。 */
  readonly complete?: string | ((req: LlmRequest) => string);
  /** 工具通道脚本(completeWithTools/streamWithTools 用);提供则 supportsTools=true。 */
  readonly toolScript?: readonly FakeToolTurn[];
}

export class FakeLlm implements LlmProvider {
  readonly id = 'fake';
  readonly model: string;
  readonly #complete: string | ((req: LlmRequest) => string) | undefined;
  readonly #toolScript: readonly FakeToolTurn[] | undefined;

  constructor(model = 'fake-1', opts: FakeLlmOptions = {}) {
    this.model = model;
    this.#complete = opts.complete;
    this.#toolScript = opts.toolScript;
  }

  /** 声明工具能力:仅当配置了脚本时(否则保持"纯文本桩"语义,不冒充工具能力)。 */
  get supportsTools(): boolean {
    return this.#toolScript !== undefined;
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

  async complete(req: LlmRequest): Promise<string> {
    if (typeof this.#complete === 'function') return this.#complete(req);
    if (this.#complete !== undefined) return this.#complete;
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    return lastUser ? `(FakeLLM complete) ${lastUser.content}` : '(FakeLLM complete)';
  }

  // ---- 工具通道(可选,§3.3)----
  // 脚本轮次由「请求里已回传的 tool_result 批数」决定:
  // 第 0 轮无回传;每多一批 toolResults(role:'tool' 消息)推进一轮,模拟 Agent loop 续写。

  async completeWithTools(req: LlmRequest): Promise<LlmToolResponse> {
    const turn = this.#turnFor(req);
    const toolCalls = turn?.toolCalls ?? [];
    return {
      text: turn?.text ?? '',
      toolCalls,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end',
    };
  }

  async *streamWithTools(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const turn = this.#turnFor(req);
    const text = turn?.text ?? '';
    for (const ch of text) {
      yield { type: 'text', text: ch };
    }
    const toolCalls = turn?.toolCalls ?? [];
    for (const call of toolCalls) {
      yield { type: 'tool_use', call };
    }
    yield { type: 'end', stopReason: toolCalls.length > 0 ? 'tool_use' : 'end' };
  }

  /** 据「已回传 tool_result 的批数」定位当前脚本轮(无脚本/越界则返回兜底回声)。 */
  #turnFor(req: LlmRequest): FakeToolTurn | undefined {
    if (this.#toolScript === undefined) {
      // 无脚本:退化为单轮回声文本,工具调用为空。
      return { text: this.#echo(req.messages) };
    }
    // 约定:每一轮的所有 tool_result 聚合为**单条** 'tool' 消息回传(Agent loop 标准形态),
    // 故含结果的 tool 消息条数 = 已完成轮数 = 下一条脚本索引。
    const returned = req.messages.filter(
      (m) => m.role === 'tool' && (m.toolResults?.length ?? 0) > 0,
    ).length;
    return this.#toolScript[returned];
  }

  #echo(messages: readonly ChatMessage[]): string {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    return lastUser ? `(FakeLLM tools) ${lastUser.content}` : '(FakeLLM tools)';
  }
}
