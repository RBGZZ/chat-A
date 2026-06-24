import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDecisionTraceSink } from '../src/sqlite-decision-trace';
import { DecisionTraceReader } from '../src/decision-trace-reader';
import {
  SqliteAutonomyDecisionSink,
  type AutonomyDecisionTraceLike,
} from '../src/sqlite-autonomy-decision';
import type { DecisionTrace, DecisionTraceSink } from '../src/decision-trace';

/**
 * autonomy 决策 → SQLite 落库适配测试(不触网):
 * - 映射进既有 decision_traces 表,provider='autonomy',可凭 sessionId='autonomy' 查回。
 * - record 内部自吞不抛(底层 sink record 抛 → 经 onError 降级)。
 */

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  dirs = [];
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autonomy-trace-'));
  dirs.push(dir);
  return join(dir, 'trace.db');
}

const sampleTrace: AutonomyDecisionTraceLike = {
  correlationId: 'corr-xyz',
  skillId: 'autonomy-runner',
  atMs: 1_700_000_000_000,
  decision: 'speak',
  reason: '值得主动开口',
  input: { candidates: ['在忙吗?'], context: '傍晚了' },
  text: '在忙吗?',
};

describe('observability/SqliteAutonomyDecisionSink', () => {
  it('record 一条 autonomy 决策 → 落进 decision_traces 表,可查回', () => {
    const path = tempDbPath();
    const base = new SqliteDecisionTraceSink({ path, captureActiveSpan: false });
    const sink = new SqliteAutonomyDecisionSink({ sink: base });
    sink.record(sampleTrace);
    base.close();

    const reader = new DecisionTraceReader({ path });
    const rows = reader.listRecent({ sessionId: 'autonomy' });
    expect(rows.length).toBe(1);
    expect(rows[0]!.correlationId).toBe('corr-xyz');
    expect(rows[0]!.replySummary).toContain('在忙吗');
  });

  it('record 不抛:底层 sink 抛错 → 经 onError 降级', () => {
    const throwingSink: DecisionTraceSink = {
      record(_t: DecisionTrace): void {
        throw new Error('boom');
      },
      close(): void {},
    };
    const errors: string[] = [];
    const sink = new SqliteAutonomyDecisionSink({
      sink: throwingSink,
      onError: (_e, op) => errors.push(op),
    });
    expect(() => sink.record(sampleTrace)).not.toThrow();
    expect(errors).toContain('record');
  });

  it('silent/idle 决策:reply 为空,emotion=decision', () => {
    const path = tempDbPath();
    const base = new SqliteDecisionTraceSink({ path, captureActiveSpan: false });
    const sink = new SqliteAutonomyDecisionSink({ sink: base });
    const silentTrace: AutonomyDecisionTraceLike = {
      correlationId: 'corr-silent',
      skillId: 'autonomy-runner',
      atMs: 1_700_000_000_001,
      decision: 'silent',
      reason: '此刻不开口',
      input: { candidates: ['x'] },
    };
    sink.record(silentTrace);
    base.close();
    const reader = new DecisionTraceReader({ path });
    const rows = reader.listRecent({ sessionId: 'autonomy' });
    expect(rows.length).toBe(1);
    expect(rows[0]!.replySummary).toBe('');
  });
});
