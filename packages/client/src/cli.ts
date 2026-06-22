import { createInterface } from 'node:readline';
import { stdin, stdout, env } from 'node:process';
import { Conversation, LightVoiceBus } from '@chat-a/runtime';
import { createLlm, loadLlmConfig } from '@chat-a/providers';
import { initTelemetry } from '@chat-a/observability';

/**
 * chat-A 文字版 MVP REPL(瘦客户端的文字形态,承 §9)。
 * 用 node:readline 异步迭代行;stdin EOF 时优雅退出(便于非交互冒烟)。
 */
async function main(): Promise<void> {
  const cfg = loadLlmConfig();
  const llm = createLlm(cfg);
  const bus = new LightVoiceBus();
  const convo = new Conversation({ bus, llm });

  // OTel 追踪骨架(§8.1):默认不开以免刷屏;设 CHAT_A_TRACE=1 打开控制台 span 树。
  const traceOn = (env['CHAT_A_TRACE'] ?? '').length > 0;
  const telemetry = traceOn ? initTelemetry({ console: true }) : undefined;

  stdout.write(`chat-A · 文字版 MVP  [provider=${cfg.provider} model=${cfg.model}]\n`);
  if (traceOn) stdout.write('(OTel trace 已开:每回合在控制台输出 turn→llm span。)\n');
  if (cfg.provider === 'fake') {
    stdout.write('(未检测到 ANTHROPIC_API_KEY → FakeLLM 占位。设 ANTHROPIC_API_KEY 用真 Claude;\n');
    stdout.write(' 或用 CHAT_A_LLM_PROVIDER / CHAT_A_LLM_MODEL 自选模型。)\n');
  }
  stdout.write('和小雪打字对话,Ctrl+C 退出。\n\n');

  const rl = createInterface({ input: stdin, output: stdout });
  let closed = false;
  rl.on('close', () => {
    closed = true;
  });
  rl.setPrompt('你 › ');
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (text.length === 0) {
      rl.prompt();
      continue;
    }
    stdout.write('小雪 › ');
    try {
      await convo.send(text, (token) => stdout.write(token));
    } catch (err) {
      stdout.write(`\n[出错: ${err instanceof Error ? err.message : String(err)}]`);
    }
    stdout.write('\n\n');
    if (!closed) rl.prompt();
  }

  await telemetry?.shutdown();
}

await main();
