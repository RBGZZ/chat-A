import type { Action, ActionResult } from '../types';

/**
 * 内置本地动作:简单四则运算(§12.2)。纯本地、无副作用、确定性。
 * 入参两形态(择一):
 *   - { expression: string }   如 "3 + 4 * 2"、"(1+2)*3"
 *   - { a: number, op, b: number }  结构化,无需解析
 * 只支持 + - * /;**不用 eval**(自写最小递归下降解析器);除零/非法 → isError(不抛)。
 */
export function createCalculateAction(): Action {
  return {
    name: 'calculate',
    description:
      '做简单四则运算(+ - * /,支持括号)。入参可为 {expression:"3 + 4 * 2"} 或结构化 {a,op,b}。' +
      '当用户要算数(如"123 乘以 7 等于几")时用。',
    // 轻量校验只看 required/properties;此处用 oneOf 仅作描述,真校验在 perform(优雅降级)。
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '四则表达式,如 "3 + 4 * 2"' },
        a: { type: 'number' },
        op: { type: 'string', enum: ['+', '-', '*', '/'] },
        b: { type: 'number' },
      },
      required: [],
    },
    perform(input: unknown): Promise<ActionResult> {
      const obj = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
      // 结构化形态优先(更可靠)。
      if (typeof obj['a'] === 'number' && typeof obj['b'] === 'number' && typeof obj['op'] === 'string') {
        return Promise.resolve(evalStructured(obj['a'], obj['op'], obj['b']));
      }
      if (typeof obj['expression'] === 'string') {
        return Promise.resolve(evalExpression(obj['expression']));
      }
      return Promise.resolve({ content: '入参非法:需要 {expression} 或 {a,op,b}', isError: true });
    },
  };
}

/** 结构化四则:op 仅 + - * /;除零 → isError。 */
function evalStructured(a: number, op: string, b: number): ActionResult {
  switch (op) {
    case '+':
      return ok(a + b);
    case '-':
      return ok(a - b);
    case '*':
      return ok(a * b);
    case '/':
      return b === 0 ? err('除数为零') : ok(a / b);
    default:
      return err(`不支持的运算符:${op}`);
  }
}

/** 表达式形态:自写解析器求值;解析失败/除零 → isError。 */
function evalExpression(expr: string): ActionResult {
  try {
    const value = new Parser(expr).parse();
    return ok(value);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

function ok(value: number): ActionResult {
  if (!Number.isFinite(value)) return err('结果非有限数');
  return { content: String(value) };
}

function err(msg: string): ActionResult {
  return { content: `计算失败:${msg}`, isError: true };
}

/**
 * 最小递归下降解析器(**不用 eval**):
 *   expr   := term (('+' | '-') term)*
 *   term   := factor (('*' | '/') factor)*
 *   factor := number | '(' expr ')' | ('+' | '-') factor
 * 仅识别:十进制数字(含小数)、四则、括号、空白;其它字符 → 抛错(由调用方收敛为 isError)。
 * 除零在此抛错。
 */
class Parser {
  readonly #s: string;
  #i = 0;

  constructor(s: string) {
    this.#s = s;
  }

  parse(): number {
    const v = this.#expr();
    this.#skipWs();
    if (this.#i < this.#s.length) throw new Error(`非法字符:${this.#s[this.#i]}`);
    return v;
  }

  #expr(): number {
    let v = this.#term();
    for (;;) {
      const op = this.#peekOp(['+', '-']);
      if (op === null) return v;
      this.#i += 1;
      const rhs = this.#term();
      v = op === '+' ? v + rhs : v - rhs;
    }
  }

  #term(): number {
    let v = this.#factor();
    for (;;) {
      const op = this.#peekOp(['*', '/']);
      if (op === null) return v;
      this.#i += 1;
      const rhs = this.#factor();
      if (op === '/' && rhs === 0) throw new Error('除数为零');
      v = op === '*' ? v * rhs : v / rhs;
    }
  }

  #factor(): number {
    this.#skipWs();
    const c = this.#s[this.#i];
    if (c === '+' || c === '-') {
      this.#i += 1;
      const v = this.#factor();
      return c === '-' ? -v : v;
    }
    if (c === '(') {
      this.#i += 1;
      const v = this.#expr();
      this.#skipWs();
      if (this.#s[this.#i] !== ')') throw new Error('缺少右括号');
      this.#i += 1;
      return v;
    }
    return this.#number();
  }

  #number(): number {
    this.#skipWs();
    const start = this.#i;
    while (this.#i < this.#s.length && /[0-9.]/.test(this.#s[this.#i] as string)) this.#i += 1;
    const raw = this.#s.slice(start, this.#i);
    if (raw === '' || raw === '.') throw new Error(`期望数字,得到:${this.#s[start] ?? '末尾'}`);
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`非法数字:${raw}`);
    return n;
  }

  /** 跳过空白后,若下一个非空白字符属 ops 则返回它(不前进),否则 null。 */
  #peekOp(ops: readonly string[]): string | null {
    this.#skipWs();
    const c = this.#s[this.#i];
    return c !== undefined && ops.includes(c) ? c : null;
  }

  #skipWs(): void {
    while (this.#i < this.#s.length && /\s/.test(this.#s[this.#i] as string)) this.#i += 1;
  }
}
