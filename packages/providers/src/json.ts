/**
 * 容错 JSON 解析(承本次 §3.2):LLM 返回常夹带说明文字或 ```json``` 围栏。
 * 策略:① 直接 parse;② 剥围栏后 parse;③ 截取首个平衡的 {...} 或 [...] 后 parse。
 * 全失败返回 null(调用方再做字段校验 / 缺省 / 跳过,不抛进回合)。
 */
export function tolerantJsonParse(text: string): unknown | null {
  const tryParse = (s: string): unknown | null => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return null;
    }
  };

  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct !== null) return direct;

  // 剥 ```json ... ``` 或 ``` ... ``` 围栏。
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) {
    const fenced = tryParse(fence[1].trim());
    if (fenced !== null) return fenced;
  }

  // 截取首个平衡的对象/数组。
  const balanced = extractBalanced(trimmed);
  if (balanced !== null) {
    const parsed = tryParse(balanced);
    if (parsed !== null) return parsed;
  }
  return null;
}

function extractBalanced(text: string): string | null {
  const open = ((): number => {
    const o = text.indexOf('{');
    const a = text.indexOf('[');
    if (o === -1) return a;
    if (a === -1) return o;
    return Math.min(o, a);
  })();
  if (open === -1) return null;
  const openCh = text[open];
  const closeCh = openCh === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}
