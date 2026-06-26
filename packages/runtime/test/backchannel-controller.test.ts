import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BACKCHANNEL_CONFIG, INITIAL_BACKCHANNEL_STATE,
  onSpeechStartedState, onPartialState, onTurnDoneState, decideBackchannel,
} from '../src/backchannel-controller';

const CFG = DEFAULT_BACKCHANNEL_CONFIG; // pause700 minSpeech3000 cooldown5000

describe('BackchannelController 决策核', () => {
  it('未开口 → 不触发', () => {
    expect(decideBackchannel(INITIAL_BACKCHANNEL_STATE, 10000, CFG).fire).toBe(false);
  });

  it('说够 minSpeech + 停顿≥pause + 冷却足 → 触发并给 clip、更新状态', () => {
    let s = onSpeechStartedState(INITIAL_BACKCHANNEL_STATE, 0); // 开口@0
    s = onPartialState(s, 100); // 最近 partial@100
    // now=100+... 让 spoken=now-0≥3000 且 sincePartial=now-100≥700 → now≥3100
    const r = decideBackchannel(s, 3200, CFG);
    expect(r.fire).toBe(true);
    expect(r.clipText).toBe('嗯'); // clipIndex 0
    expect(r.state.lastBackchannelAtMs).toBe(3200);
    expect(r.state.clipIndex).toBe(1);
  });

  it('未说够 minSpeech → 不触发', () => {
    let s = onSpeechStartedState(INITIAL_BACKCHANNEL_STATE, 0);
    s = onPartialState(s, 100);
    expect(decideBackchannel(s, 1000, CFG).fire).toBe(false); // spoken=1000<3000
  });

  it('partial 刚来(无停顿) → 不触发', () => {
    let s = onSpeechStartedState(INITIAL_BACKCHANNEL_STATE, 0);
    s = onPartialState(s, 3000); // 最近 partial@3000
    expect(decideBackchannel(s, 3100, CFG).fire).toBe(false); // sincePartial=100<700
  });

  it('冷却内不重复触发', () => {
    let s = onSpeechStartedState(INITIAL_BACKCHANNEL_STATE, 0);
    s = onPartialState(s, 100);
    const r1 = decideBackchannel(s, 3200, CFG); // 触发,lastBc=3200
    expect(r1.fire).toBe(true);
    // 再次:now=3900,spoken够、停顿够,但 sinceBc=700<5000 → 不触发
    expect(decideBackchannel(r1.state, 3900, CFG).fire).toBe(false);
  });

  it('clip 轮换', () => {
    let s = onSpeechStartedState(INITIAL_BACKCHANNEL_STATE, 0);
    s = onPartialState(s, 100);
    const r1 = decideBackchannel(s, 3200, CFG); // 嗯 (idx0→1)
    // 过冷却再触发:now=3200+5000+1=8201,需 sincePartial≥700→lastPartial 仍100,ok
    const r2 = decideBackchannel(r1.state, 8201, CFG);
    expect(r1.clipText).toBe('嗯');
    expect(r2.clipText).toBe('嗯嗯'); // idx1
  });

  it('onTurnDone 清开口态(下句前不附和)', () => {
    let s = onSpeechStartedState(INITIAL_BACKCHANNEL_STATE, 0);
    s = onPartialState(s, 100);
    s = onTurnDoneState(s);
    expect(decideBackchannel(s, 3200, CFG).fire).toBe(false); // speechStartedAtMs=null
  });
});
