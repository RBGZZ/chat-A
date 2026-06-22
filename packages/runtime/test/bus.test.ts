import { describe, it, expect, vi } from 'vitest';
import { makeBusEvent } from '@chat-a/protocol';
import { LightVoiceBus } from '../src/index';

const start = (cid = 'c/c/0') => makeBusEvent('turn:start', { startedAtMs: 1 }, cid);

describe('runtime/LightVoiceBus', () => {
  it('on 收匹配事件;onAny 收全部', () => {
    const bus = new LightVoiceBus();
    const seen: number[] = [];
    bus.on('turn:start', (e) => seen.push(e.data.startedAtMs));
    const any: string[] = [];
    bus.onAny((e) => any.push(e.action));
    bus.emit(start());
    bus.emit(makeBusEvent('turn:interrupt', { reason: 'x' }, 'c/c/0'));
    expect(seen).toEqual([1]);
    expect(any).toEqual(['turn:start', 'turn:interrupt']);
  });

  it('订阅者抛错被隔离,不影响其他', () => {
    const onHandlerError = vi.fn();
    const bus = new LightVoiceBus({ onHandlerError });
    const ok: string[] = [];
    bus.on('turn:start', () => {
      throw new Error('boom');
    });
    bus.on('turn:start', () => ok.push('ok'));
    bus.emit(start());
    expect(ok).toEqual(['ok']);
    expect(onHandlerError).toHaveBeenCalledOnce();
  });

  it('emit 同步有序', () => {
    const bus = new LightVoiceBus();
    const order: number[] = [];
    bus.on('turn:start', () => order.push(1));
    bus.on('turn:start', () => order.push(2));
    bus.emit(start());
    expect(order).toEqual([1, 2]);
  });

  it('事件 deepFreeze 不可变(含嵌套 data)', () => {
    const bus = new LightVoiceBus();
    const e = start();
    bus.emit(e);
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen(e.data)).toBe(true);
  });

  it('once 只触发一次', () => {
    const bus = new LightVoiceBus();
    let n = 0;
    bus.once('turn:start', () => {
      n += 1;
    });
    bus.emit(start());
    bus.emit(start());
    expect(n).toBe(1);
  });

  it('history 环形缓冲遵守容量', () => {
    const bus = new LightVoiceBus({ historyCapacity: 2 });
    bus.emit(start('a'));
    bus.emit(start('b'));
    bus.emit(start('c'));
    expect(bus.history().map((x) => x.correlationId)).toEqual(['b', 'c']);
  });

  it('per-handler 超预算告警(不杀)', () => {
    const onSlowHandler = vi.fn();
    const bus = new LightVoiceBus({ handlerBudgetMs: -1, onSlowHandler });
    bus.on('turn:start', () => {});
    bus.emit(start());
    expect(onSlowHandler).toHaveBeenCalled();
  });

  it('runWithCorrelation 传播 correlationId', () => {
    const bus = new LightVoiceBus();
    let captured: string | undefined;
    bus.runWithCorrelation('s/t/0', () => {
      captured = bus.currentCorrelationId();
    });
    expect(captured).toBe('s/t/0');
  });

  it('退订生效', () => {
    const bus = new LightVoiceBus();
    let n = 0;
    const off = bus.on('turn:start', () => {
      n += 1;
    });
    bus.emit(start());
    off();
    bus.emit(start());
    expect(n).toBe(1);
  });
});
