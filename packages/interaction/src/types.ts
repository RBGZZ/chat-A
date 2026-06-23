/**
 * 行动侧接缝(§12.2):小雪能执行的本地动作。
 * Action 是"她会做的一件事"的最小契约;ActionRegistry 把动作暴露为 tool-use 工具并容错执行。
 */

/** 动作执行结果。content=回灌给模型的可读结果;isError=true 表示失败(模型可据此调整)。 */
export interface ActionResult {
  readonly content: string;
  readonly isError?: boolean;
}

/**
 * 一个本地动作(§12.2)。inputSchema 为 JSON schema(映射 Anthropic input_schema / LlmToolDef);
 * perform 执行动作——可抛错(由 ActionRegistry 收敛为 isError 结果,§3.2)。
 */
export interface Action {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  perform(input: unknown): Promise<ActionResult>;
}
