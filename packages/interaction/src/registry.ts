import type { ToolCall, ToolResult } from '@chat-a/protocol';
import type { LlmToolDef } from '@chat-a/providers';
import type { Action } from './types';

/**
 * 动作注册表(§12.2):持有本地动作,暴露为 tool-use 工具定义,并**容错**执行。
 * execute 绝不抛——未知工具/入参非法/未授权/perform 抛错都收敛为 isError 的 ToolResult(§3.2),
 * 让"工具失败"成为模型可据此调整的正常信号,而非中断回合的故障。
 *
 * **能力门(§12.2)**:可配置"当前能力集"`Set<string>`,据此**动态隐藏设备不支持的动作**——
 * `toolDefs()` 只产授权动作(从源头隐藏),`execute()` 对未授权动作容错拒绝(不抛)。
 * **缺省(未配置能力集)= 全部可用**(向后兼容,行为与未引入能力门时逐字一致)。
 */
export class ActionRegistry {
  readonly #actions = new Map<string, Action>();
  /**
   * 当前能力集。`undefined` = **未配置能力门 = 全部授权**(向后兼容);
   * 一旦配置(哪怕空 Set = 门已开但无任何能力),按集合判定授权。
   */
  #capabilities: ReadonlySet<string> | undefined;

  /**
   * @param capabilities 可选的当前能力集;缺省 = 不开能力门(全部动作可用)。
   */
  constructor(capabilities?: ReadonlySet<string>) {
    this.#capabilities = capabilities;
  }

  register(action: Action): this {
    this.#actions.set(action.name, action);
    return this;
  }

  /**
   * 设置/更新当前能力集(能力门,§12.2)——可在运行期随设备能力切换。
   * 传入即开启能力门;之后 `toolDefs()`/`execute()` 据此过滤。链式返回 this。
   */
  withCapabilities(capabilities: ReadonlySet<string>): this {
    this.#capabilities = capabilities;
    return this;
  }

  /** 已注册动作数(供降级判断/横幅)。**不**计能力门过滤——是注册总数。 */
  get size(): number {
    return this.#actions.size;
  }

  /**
   * 判断动作在当前能力集下是否已授权:
   * 能力集未配置 → 全授权;动作未声明 capability → 授权;否则看能力集是否含该 capability。
   */
  #isAuthorized(action: Action): boolean {
    if (this.#capabilities === undefined) return true;
    if (action.capability === undefined) return true;
    return this.#capabilities.has(action.capability);
  }

  /** 产出喂给 tool-use Provider 的工具定义(§3.3);能力门:只产**已授权**动作(§12.2)。 */
  toolDefs(): LlmToolDef[] {
    return [...this.#actions.values()].filter((a) => this.#isAuthorized(a)).map((a) => ({
      name: a.name,
      description: a.description,
      inputSchema: a.inputSchema,
    }));
  }

  /** 执行一个工具调用,返回 ToolResult(toolCallId 对齐);全程容错不抛。 */
  async execute(call: ToolCall): Promise<ToolResult> {
    const action = this.#actions.get(call.name);
    if (action === undefined) {
      return { toolCallId: call.id, content: `未知工具:${call.name}`, isError: true };
    }
    // 能力门(§12.2):动作存在但当前设备不支持其能力 → 容错拒绝(不抛、不调 perform)。
    if (!this.#isAuthorized(action)) {
      return {
        toolCallId: call.id,
        content: `当前设备不支持该动作(缺能力:${action.capability ?? '?'}):${call.name}`,
        isError: true,
      };
    }
    const invalid = validateInput(action.inputSchema, call.input);
    if (invalid !== null) {
      return { toolCallId: call.id, content: `入参非法:${invalid}`, isError: true };
    }
    try {
      const result = await action.perform(call.input);
      return {
        toolCallId: call.id,
        content: result.content,
        ...(result.isError !== undefined ? { isError: result.isError } : {}),
      };
    } catch (err) {
      return {
        toolCallId: call.id,
        content: `执行出错:${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}

/**
 * 轻量入参校验(MVP,不引 Zod):按 inputSchema 的 required/properties 粗检
 * (必填存在 + 基础类型匹配)。返回 null=通过,否则返回错误说明。
 */
function validateInput(schema: Readonly<Record<string, unknown>>, input: unknown): string | null {
  const required = Array.isArray(schema['required']) ? (schema['required'] as unknown[]) : [];
  // input 必须是对象(除非无任何 required/properties 约束)。
  const isObj = typeof input === 'object' && input !== null && !Array.isArray(input);
  const props = (typeof schema['properties'] === 'object' && schema['properties'] !== null
    ? (schema['properties'] as Record<string, unknown>)
    : {});
  if (required.length > 0 && !isObj) return '需要对象入参';
  const obj = isObj ? (input as Record<string, unknown>) : {};
  for (const key of required) {
    if (typeof key === 'string' && !(key in obj)) return `缺少必填字段:${key}`;
  }
  // 基础类型粗检(仅对已提供且 schema 标了 type 的字段)。
  for (const [key, val] of Object.entries(obj)) {
    const p = props[key];
    const expected = typeof p === 'object' && p !== null ? (p as Record<string, unknown>)['type'] : undefined;
    if (typeof expected === 'string' && !typeMatches(expected, val)) {
      return `字段 ${key} 类型应为 ${expected}`;
    }
  }
  return null;
}

function typeMatches(expected: string, val: unknown): boolean {
  switch (expected) {
    case 'string':
      return typeof val === 'string';
    case 'number':
    case 'integer':
      return typeof val === 'number' && Number.isFinite(val);
    case 'boolean':
      return typeof val === 'boolean';
    case 'object':
      return typeof val === 'object' && val !== null && !Array.isArray(val);
    case 'array':
      return Array.isArray(val);
    default:
      return true; // 未知类型不拦(失败安全)。
  }
}
