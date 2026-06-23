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
  /**
   * 该动作执行所需的设备/环境能力标签(能力门,§12.2),如 'time'/'audio'。
   * **缺省(未声明)= 无需任何能力,始终可用**——能力声明随动作走,能力集由调用方按设备传入,
   * 声明与环境解耦(行为即配置,§3.2)。
   */
  readonly capability?: string;
  perform(input: unknown): Promise<ActionResult>;
}
