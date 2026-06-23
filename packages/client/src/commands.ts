/**
 * 交互式 CLI 的命令解析与文案渲染(纯逻辑层,可单测、无副作用)。
 *
 * 设计:把"一行输入归类成什么"与"打印什么文案"从交互壳(cli.ts)中抽出,
 * 使其成为确定性纯函数——便于 headless 单测(交互式 TTY 无法在 CI 真测)。
 * cli.ts 仅负责把解析结果分发到实际副作用(send / 清屏 / 关库 等)。
 */

/** 一行输入解析后的归类(判别联合)。 */
export type ParsedCommand =
  | { readonly kind: 'empty' }
  | { readonly kind: 'chat'; readonly text: string }
  | { readonly kind: 'help' }
  | { readonly kind: 'quit' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'persona' }
  | { readonly kind: 'reset' }
  | { readonly kind: 'unknown'; readonly name: string };

/** 内建命令别名 → 规范 kind(大小写不敏感;`/exit`=quit)。 */
const COMMAND_ALIASES: Record<string, ParsedCommand['kind']> = {
  '/help': 'help',
  '/quit': 'quit',
  '/exit': 'quit',
  '/clear': 'clear',
  '/persona': 'persona',
  '/reset': 'reset',
};

/**
 * 把一行原始输入解析为命令(纯函数):
 *   - 空/纯空白 → empty(忽略并重提示);
 *   - 不以 `/` 开头 → chat(普通对话,文本已 trim);
 *   - `/<词>`(忽略后续参数)命中别名表 → 对应内建命令(大小写不敏感);
 *   - 其它 `/xxx` → unknown(友好提示,不发给 LLM)。
 */
export function parseCommand(line: string): ParsedCommand {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: 'empty' };
  if (!trimmed.startsWith('/')) return { kind: 'chat', text: trimmed };

  const firstWord = trimmed.split(/\s+/)[0] ?? trimmed;
  const lower = firstWord.toLowerCase();
  const kind = COMMAND_ALIASES[lower];
  if (kind === undefined) return { kind: 'unknown', name: firstWord };
  return { kind } as ParsedCommand;
}

/** `/help` 文案:命令一览(中文)。 */
export function renderHelp(): string {
  return [
    '可用命令:',
    '  /help            显示这份帮助',
    '  /persona         查看当前人格与情绪旋钮',
    '  /clear           清屏',
    '  /reset           清空当前会话上下文(开新一段对话)',
    '  /quit  (/exit)   退出',
    '',
    '直接打字即可和小雪对话。',
  ].join('\n');
}

/** `/persona` 需要的人格摘要信息(由 cli.ts 从 seed 收集后传入)。 */
export interface PersonaInfo {
  readonly name: string;
  readonly identity: string;
  readonly warmth: number;
  readonly expressiveness: number;
  readonly volatility: number;
  readonly assertiveness: number;
}

/** `/persona` 文案:人格名/身份 + 关键旋钮(纯函数)。 */
export function renderPersona(info: PersonaInfo): string {
  return [
    `人格: ${info.name}`,
    `身份: ${info.identity}`,
    `旋钮: 暖(warmth)=${info.warmth}  外显(expressiveness)=${info.expressiveness}  ` +
      `波动(volatility)=${info.volatility}  敢顶嘴(assertiveness)=${info.assertiveness}`,
  ].join('\n');
}

/** 启动横幅所需信息(由 cli.ts 装配后传入)。 */
export interface BannerInfo {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly memoryBackend: string;
  readonly warmth: number;
  readonly expressiveness: number;
  readonly volatility: number;
  /** provider 是否为占位 FakeLLM(未配真模型)。 */
  readonly isFake: boolean;
}

/**
 * 启动横幅(纯函数):面向用户、简洁。含人格名、模型、记忆后端、情绪旋钮与 `/help` 提示。
 * fake 兜底时追加"如何配置真模型"的引导(`.env.local` 一行 key / 切 Qwen)。
 */
export function renderBanner(info: BannerInfo): string {
  const lines = [
    `╭─ chat-A · 和「${info.name}」聊天 ─╮`,
    `  模型: ${info.provider} / ${info.model}`,
    `  记忆: ${info.memoryBackend}`,
    `  人格: 暖=${info.warmth} 外显=${info.expressiveness} 波动=${info.volatility}`,
    `  输入 /help 查看命令,Ctrl+C 退出。`,
  ];
  if (info.isFake) {
    lines.push(
      '',
      '  (当前为 FakeLLM 占位,未配置真模型。配置方式:',
      '   在项目根新建 .env.local,写一行  CHAT_A_LLM_API_KEY=sk-你的key',
      '   默认走 DeepSeek;切 Qwen 设 CHAT_A_LLM_PROVIDER=qwen CHAT_A_LLM_MODEL=qwen-plus)',
    );
  }
  return lines.join('\n');
}
