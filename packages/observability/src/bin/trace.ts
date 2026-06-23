#!/usr/bin/env node
/**
 * 决策 trace 查看工具(§8.1 可重放落地的"回放查看")。
 *
 * 用法:
 *   chat-a-trace list [--session <id>] [--limit N] [--db <path>]
 *   chat-a-trace show <turnId|correlationId|trace_id> [--db <path>]
 *
 * 库路径优先级:--db > CHAT_A_DECISION_TRACE_DB > 默认 chat-a-trace.db。
 * 纯只读、带外工具,不在回合热路径,不改写库、不动 client。
 */
import { parseArgs } from 'node:util';
import { DecisionTraceReader } from '../decision-trace-reader';
import type { DecisionTrace } from '../decision-trace';

const DEFAULT_DB = 'chat-a-trace.db';

function resolveDbPath(flag: string | undefined): string {
  return flag ?? process.env['CHAT_A_DECISION_TRACE_DB'] ?? DEFAULT_DB;
}

function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) return '?';
  // 本地时间,精确到秒,便于人读。
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function printUsage(): void {
  console.log(
    [
      '决策 trace 查看工具(只读)',
      '',
      '用法:',
      '  chat-a-trace list [--session <id>] [--limit N] [--db <path>]',
      '  chat-a-trace show <turnId|correlationId|trace_id> [--db <path>]',
      '',
      '库路径优先级:--db > CHAT_A_DECISION_TRACE_DB > 默认 chat-a-trace.db',
    ].join('\n'),
  );
}

function runList(reader: DecisionTraceReader, sessionId: string | undefined, limit: number): void {
  const rows = reader.listRecent({
    ...(sessionId !== undefined ? { sessionId } : {}),
    limit,
  });
  if (rows.length === 0) {
    console.log('(无决策 trace:库为空、不存在或会话无匹配)');
    return;
  }
  console.log(`最近 ${rows.length} 回合${sessionId !== undefined ? `(会话 ${sessionId})` : ''}:`);
  console.log('');
  rows.forEach((r, i) => {
    const idx = String(i + 1).padStart(2, ' ');
    console.log(`${idx}. [${formatTime(r.createdAtMs)}] turnId=${r.turnId}  session=${r.sessionId}`);
    console.log(`    用户: ${r.userTextSummary || '(空)'}`);
    console.log(`    小雪: ${r.replySummary || '(空)'}`);
    console.log(`    correlationId=${r.correlationId}${r.traceId !== undefined ? `  traceId=${r.traceId}` : ''}`);
    console.log('');
  });
  console.log('看单回合完整决策链:chat-a-trace show <turnId>');
}

const HR = '─'.repeat(60);

function section(title: string): void {
  console.log('');
  console.log(`【${title}】`);
}

function printTrace(t: DecisionTrace): void {
  console.log(HR);
  console.log(`回合 turnId=${t.turnId}  session=${t.sessionId}`);
  console.log(HR);

  section('基本信息');
  console.log(`  时间:        ${formatTime(t.createdAtMs)}`);
  console.log(`  回合延迟:    ${t.latencyMs} ms`);
  console.log(`  correlationId: ${t.correlationId}`);
  if (t.traceId !== undefined) console.log(`  traceId:     ${t.traceId}`);
  if (t.spanId !== undefined) console.log(`  spanId:      ${t.spanId}`);

  section('用户输入');
  console.log(`  ${t.userText || '(空)'}`);

  section('召回记忆 + 打分');
  if (t.recalled.length === 0) {
    console.log('  (无召回)');
  } else {
    t.recalled.forEach((m, i) => {
      const kind = m.kind !== undefined ? ` kind=${m.kind}` : '';
      console.log(`  ${i + 1}. [hits=${m.hits} subject=${m.subject}${kind}] ${m.text}`);
    });
  }

  section('情绪 / PAD');
  console.log(`  emotion: ${t.emotion}`);
  if (t.pad !== undefined) {
    console.log(`  PAD:     P=${t.pad.pleasure}  A=${t.pad.arousal}  D=${t.pad.dominance}`);
  } else {
    console.log('  PAD:     (未记录)');
  }

  section('assertiveness / stance');
  console.log(`  assertiveness: ${t.assertiveness}`);
  if (t.stanceNotions.length === 0) {
    console.log('  stance 命中观点: (无)');
  } else {
    console.log('  stance 命中观点:');
    t.stanceNotions.forEach((s) => console.log(`    - ${s}`));
  }
  if (t.posture !== undefined) {
    console.log(`  负面姿态(posture): ${t.posture}`);
  }

  section('最终 system prompt');
  console.log(t.system || '(空)');

  section('messages');
  if (t.messages.length === 0) {
    console.log('  (无)');
  } else {
    t.messages.forEach((m) => {
      console.log(`  [${m.role}] ${m.content}`);
    });
  }

  section('Provider / model');
  console.log(`  ${t.provider} / ${t.model}`);

  section('小雪回复(reply)');
  console.log(t.reply || '(空)');
  console.log('');
}

function runShow(reader: DecisionTraceReader, id: string): void {
  // 依次按 turnId → correlationId → trace_id 尝试,任一命中即打印。
  const trace =
    reader.getByTurnId(id) ?? reader.getByCorrelationId(id) ?? reader.getByTraceId(id);
  if (trace === undefined) {
    console.log(`未找到决策 trace:${id}(库为空、不存在,或该标识无匹配)`);
    return;
  }
  printTrace(trace);
}

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    printUsage();
    return;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        db: { type: 'string' },
        session: { type: 'string' },
        limit: { type: 'string' },
      },
    } as const);
  } catch (err) {
    console.error(`参数错误:${err instanceof Error ? err.message : String(err)}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  const dbPath = resolveDbPath(parsed.values.db);
  const reader = new DecisionTraceReader({ path: dbPath });
  try {
    if (command === 'list') {
      const rawLimit = parsed.values.limit;
      const limit = rawLimit !== undefined ? Number(rawLimit) : 20;
      runList(reader, parsed.values.session, Number.isFinite(limit) && limit > 0 ? limit : 20);
    } else if (command === 'show') {
      const id = parsed.positionals[0];
      if (id === undefined) {
        console.error('show 需要一个标识:chat-a-trace show <turnId|correlationId|trace_id>');
        process.exitCode = 1;
        return;
      }
      runShow(reader, id);
    } else {
      console.error(`未知子命令:${command}`);
      printUsage();
      process.exitCode = 1;
    }
  } finally {
    reader.close();
  }
}

main(process.argv.slice(2));
