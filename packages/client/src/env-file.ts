/**
 * `.env.local` 加载(纯函数解析 + 薄壳应用)。
 *
 * 目标:让 `pnpm dev` 与 `start.bat` 行为一致——用户只需在项目根放一行 key
 * (`CHAT_A_LLM_API_KEY=sk-...`)即可用真模型,而不必非走 Windows 批处理。
 *
 * 语义对齐 `start.bat` 的 `for /f "eol=# tokens=1,* delims==" ...`:
 *   - `#` 开头的行(含 `eol=#`)与空行跳过;
 *   - 只切**第一个** `=`(`tokens=1,*`),value 中其余 `=` 完整保留;
 *   - key/value 去首尾空白;value 两侧成对引号去掉(便于含空格的值)。
 *
 * 解析为**纯函数**(可单测、无副作用);注入为薄壳且**不覆盖**已存在的真实环境变量。
 */

/** 把 `.env.local` 文本解析成键值映射(纯函数,无 IO)。 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue; // 无 `=` 或空 key,跳过
    const key = line.slice(0, eq).trim();
    if (key.length === 0) continue;
    let value = line.slice(eq + 1).trim();
    value = stripPairedQuotes(value);
    out[key] = value;
  }
  return out;
}

/** 去掉成对的首尾引号(单或双);不成对则原样保留。 */
function stripPairedQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * 把解析结果注入环境(薄壳):仅当目标 env 中该键**未定义或为空**时写入,
 * 真实环境变量(已设置且非空)永远优先,不被文件覆盖。
 */
export function applyDotEnv(parsed: Record<string, string>, env: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(parsed)) {
    const existing = env[key];
    if (existing === undefined || existing.length === 0) {
      env[key] = value;
    }
  }
}
