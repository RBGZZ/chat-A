import { describe, expect, it } from 'vitest';
import {
  isSignalEvent,
  signalPriority,
  signalToEvent,
  ingestBusEventAsSignal,
} from '../src/signal-adapter';
import { PriorityEventQueue } from '../src/priority-queue';
import type { Clock } from '../src/types';
import { isAutonomyEnabled } from '../src/config';

const clock: Clock = { now: () => 42 };

describe('autonomy/signal-adapter(消费 signal:* 入队)', () => {
  it('鸭子类型识别 signal:* 事件', () => {
    expect(isSignalEvent({ action: 'signal:temporal:tick' })).toBe(true);
    expect(isSignalEvent({ action: 'turn:end' })).toBe(false);
    expect(isSignalEvent(null)).toBe(false);
    expect(isSignalEvent({})).toBe(false);
  });

  it('优先级映射:signal:user:* → URGENT,其余 → PERCEPTION', () => {
    expect(signalPriority('signal:user:speech')).toBe('URGENT');
    expect(signalPriority('signal:temporal:tick')).toBe('PERCEPTION');
    expect(signalPriority('signal:system:notify')).toBe('PERCEPTION');
  });

  it('signalToEvent:映射为非 synthetic 内核事件,透传 data 为 payload', () => {
    const e = signalToEvent(
      { action: 'signal:user:speech', data: { description: '用户开口', confidence: 0.9 } },
      clock,
    );
    expect(e.kind).toBe('signal:user:speech');
    expect(e.priority).toBe('URGENT');
    expect(e.synthetic).toBe(false);
    expect(e.atMs).toBe(42);
    expect(e.payload).toEqual({ description: '用户开口', confidence: 0.9 });
  });

  it('ingestBusEventAsSignal:signal 入队,非 signal 忽略', () => {
    const q = new PriorityEventQueue();
    expect(ingestBusEventAsSignal({ action: 'turn:end' }, q, clock)).toBe(false);
    expect(q.size).toBe(0);
    expect(ingestBusEventAsSignal({ action: 'signal:temporal:tick' }, q, clock)).toBe(true);
    expect(q.size).toBe(1);
    // URGENT 用户信号先出队
    ingestBusEventAsSignal({ action: 'signal:user:speech' }, q, clock);
    expect(q.dequeue()?.kind).toBe('signal:user:speech');
  });
});

describe('autonomy/isAutonomyEnabled(CHAT_A_AUTONOMY 主开关,默认关)', () => {
  it('缺省/空 → off', () => {
    expect(isAutonomyEnabled({})).toBe(false);
    expect(isAutonomyEnabled({ CHAT_A_AUTONOMY: '' })).toBe(false);
  });
  it('on(大小写/空白不敏感) → 启用', () => {
    expect(isAutonomyEnabled({ CHAT_A_AUTONOMY: 'on' })).toBe(true);
    expect(isAutonomyEnabled({ CHAT_A_AUTONOMY: ' ON ' })).toBe(true);
  });
  it('其它值 → off', () => {
    expect(isAutonomyEnabled({ CHAT_A_AUTONOMY: 'true' })).toBe(false);
    expect(isAutonomyEnabled({ CHAT_A_AUTONOMY: '1' })).toBe(false);
    expect(isAutonomyEnabled({ CHAT_A_AUTONOMY: 'off' })).toBe(false);
  });
});
