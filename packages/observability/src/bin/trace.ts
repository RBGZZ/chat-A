#!/usr/bin/env node
/**
 * 决策 trace 查看工具(§8.1 可重放落地的"回放查看")。
 *
 * 用法:
 *   chat-a-trace list [--session <id>] [--limit N] [--db <path>]
 *   chat-a-trace show <turnId|correlationId|trace_id> [--db <path>]
 *   chat-a-trace stats [--db <path>]
 *
 * 库路径优先级:--db > CHAT_A_DECISION_TRACE_DB > 默认 chat-a-trace.db。
 * 纯只读、带外工具,不在回合热路径,不改写库、不动 client。
 */
import { parseArgs } from 'node:util';
import { DecisionTraceReader } from '../decision-trace-reader';
import { DecisionTraceStats, type DecisionTraceStatsResult, type CountDistribution } from '../decision-trace-stats';
import type { DecisionTrace } from '../decision-trace';
import { SqliteSpanSink, type SpanRecord } from '../sqlite-span-trace';

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
      '  chat-a-trace stats [--db <path>]',
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

/**
 * 缝合打印:若该回合带 traceId,从**同库** otel_spans 还原挂在同 trace 下的 span 树阶段耗时
 * (§8.1 决策记录 ←→ span 阶段耗时对照)。纯只读、库无表/无 span 静默跳过(降级不崩)。
 */
function printSpans(dbPath: string, t: DecisionTrace): void {
  if (t.traceId === undefined) return;
  const sink = new SqliteSpanSink({ path: dbPath, onError: () => {} });
  let spans: SpanRecord[] = [];
  try {
    spans = sink.getSpansByTraceId(t.traceId);
  } finally {
    sink.close();
  }
  if (spans.length === 0) return; // 无 span(未启用 span→SQLite)→ 静默跳过
  section('OTel span 阶段耗时(同 trace 缝合)');
  for (const s of spans) {
    const star = s.spanId === t.spanId ? ' *' : '';
    const status = s.statusCode !== 'unset' ? ` status=${s.statusCode}` : '';
    const model = s.model !== undefined ? ` model=${s.model}` : '';
    console.log(`  ${s.name}: ${num(s.durationMs)} ms${status}${model}  span_id=${s.spanId}${star}`);
  }
  console.log('  (* = 产出本决策的 span)');
}

function runShow(reader: DecisionTraceReader, id: string, dbPath: string): void {
  // 依次按 turnId → correlationId → trace_id 尝试,任一命中即打印。
  const trace =
    reader.getByTurnId(id) ?? reader.getByCorrelationId(id) ?? reader.getByTraceId(id);
  if (trace === undefined) {
    console.log(`未找到决策 trace:${id}(库为空、不存在,或该标识无匹配)`);
    return;
  }
  printTrace(trace);
  printSpans(dbPath, trace);
}

/** 把"取值 → 计数"分布按计数倒序打印;可选 top 截断。空分布打印"(无)"。 */
function printDistribution(dist: CountDistribution, top?: number): void {
  const entries = Object.entries(dist).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    console.log('  (无)');
    return;
  }
  const shown = top !== undefined ? entries.slice(0, top) : entries;
  for (const [key, count] of shown) {
    console.log(`  ${key}: ${count}`);
  }
  if (top !== undefined && entries.length > top) {
    console.log(`  …(其余 ${entries.length - top} 项省略)`);
  }
}

/** 数值漂亮化:保留 1 位小数但去掉无意义的 .0(便于人读 latency/占比)。 */
function num(n: number): string {
  if (!Number.isFinite(n)) return '?';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function printStats(s: DecisionTraceStatsResult): void {
  if (s.totalTurns === 0) {
    console.log('(无数据:库为空、不存在或损坏)');
    return;
  }
  console.log(HR);
  console.log(`决策 trace 统计(共 ${s.totalTurns} 回合)`);
  console.log(HR);

  section('emotion 分布');
  printDistribution(s.emotionCounts);

  section('posture 分布(仅有姿态的回合)');
  printDistribution(s.postureCounts);

  section('provider 分布');
  printDistribution(s.providerCounts);

  section('回合延迟(ms)');
  console.log(`  样本: ${s.latency.count}`);
  console.log(`  均值: ${num(s.latency.mean)}`);
  console.log(`  p50:  ${num(s.latency.p50)}`);
  console.log(`  p95:  ${num(s.latency.p95)}`);

  section('召回命中');
  console.log(`  平均召回条数: ${num(s.recall.meanRecalledLen)}`);
  console.log(`  有召回占比:   ${num(s.recall.recalledRatio * 100)}%`);

  section('各会话回合数(倒序 top 10)');
  printDistribution(s.sessionTurnCounts, 10);
  console.log('');
}

function runStats(stats: DecisionTraceStats): void {
  printStats(stats.compute());
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

  // stats 用独立只读统计模块(自己的只读句柄),不开 reader。
  if (command === 'stats') {
    const stats = new DecisionTraceStats({ path: dbPath });
    try {
      runStats(stats);
    } finally {
      stats.close();
    }
    return;
  }

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
      runShow(reader, id, dbPath);
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
