/**
 * 流式 JSON tool-call 检测器(§3.3 降级骨架,prompt 模式备用)。
 *
 * 本地模型无原生 tool-use 时,可约定让模型把工具调用写成内联 JSON,从文本流里识别。
 * 本函数为**确定性纯函数**:从缓冲中切出**首个括号配平**的 `{...}`(字符串/转义感知),
 * 返回 { json, rest };缓冲尚未含完整平衡对象(还在流式增量中)则返回 null,表示等待更多增量。
 *
 * 不接线到任何 Provider——仅作可独立单测的备用工具。
 */
export function detectToolCallJson(buffer: string): { json: string; rest: string } | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  let open = -1; // 首个**不在字符串内**的 `{` 位置(锚点),避免被前置引号文本里的 `{` 误锚定。
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (open === -1) open = i;
      depth++;
    } else if (ch === '}') {
      if (open === -1) continue; // 对象开始前的游离 `}`,忽略。
      depth--;
      if (depth === 0) {
        return { json: buffer.slice(open, i + 1), rest: buffer.slice(i + 1) };
      }
    }
  }
  // 尚无配平对象(还在流式增量,或 `{` 仍在未闭合字符串内)—— 等待更多增量。
  return null;
}
