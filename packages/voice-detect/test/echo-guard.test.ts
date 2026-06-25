import { describe, it, expect, vi } from 'vitest';
import {
  EchoGuardGate,
  DEFAULT_ECHO_GUARD_CONFIG,
  type EchoGuardConfig,
  type EchoGuardDecision,
} from '../src/echo-guard';

/** 构造一帧输入(prob/能量/VAD speaking/时刻可调)。 */
function frame(
  over: Partial<{ prob: number; energy01: number; speakingFromVad: boolean; atMs: number }> = {},
): { prob: number; energy01: number; speakingFromVad: boolean; atMs: number } {
  return {
    prob: over.prob ?? 0.9,
    energy01: over.energy01 ?? 1,
    speakingFromVad: over.speakingFromVad ?? true,
    atMs: over.atMs ?? 0,
  };
}
/** 高置信高能量语音帧。 */
function speech(atMs = 0, energy01 = 1): ReturnType<typeof frame> {
  return frame({ prob: 0.9, energy01, speakingFromVad: true, atMs });
}
/** 静音/低置信帧。 */
function silence(atMs = 0): ReturnType<typeof frame> {
  return frame({ prob: 0.1, energy01: 0, speakingFromVad: false, atMs });
}

/** 启用、N=1、双层阈值显式的基础配置(便于聚焦 tier 行为)。 */
function cfg(over: Partial<EchoGuardConfig> = {}): EchoGuardConfig {
  return {
    enabled: true,
    confirmFrames: 1,
    minSpeechProb: 0.5,
    minEnergy: 0,
    cooldownMs: 1500,
    baseRmsThreshold: 0,
    cooldownRmsThreshold: 0.03,
    ...over,
  };
}

describe('voice-detect/EchoGuardGate (Tier1 硬门控 + Tier2 RMS 双层冷却)', () => {
  // ───────────────────────────── 禁用 / 默认安全 ─────────────────────────────

  it('禁用:恒放行(逐字现状),tier 报 disabled', () => {
    const gate = new EchoGuardGate({ ...DEFAULT_ECHO_GUARD_CONFIG, enabled: false });
    const d = gate.push(silence());
    expect(d.pass).toBe(true);
    expect(d.tier).toBe('disabled');
  });

  it('默认配置:enabled=false → 即时放行', () => {
    const gate = new EchoGuardGate(); // DEFAULT_ECHO_GUARD_CONFIG
    expect(gate.push(silence()).pass).toBe(true);
  });

  it('库默认(回归硬线):confirmFrames=1 且 enabled=false(去抖提升只在装配层,不动库默认)', () => {
    // barge-in-polish:语音模式装配层把 confirmFrames 覆盖为去抖值 3;库默认须保持 1
    //(配 enabled:false,直接构造/外部注入时给「逐字现状」安全起点)。两者分工、互不耦合。
    expect(DEFAULT_ECHO_GUARD_CONFIG.confirmFrames).toBe(1);
    expect(DEFAULT_ECHO_GUARD_CONFIG.enabled).toBe(false);
  });

  // ───────────────────────────── Tier 1:硬门控(最高 RMS 门槛 + N 帧去抖)──────────────────────────

  it('Tier1:agent 说话期用最高门槛 → 低能量回声帧被挡(不自打断)', () => {
    const gate = new EchoGuardGate(cfg({ confirmFrames: 1, cooldownRmsThreshold: 0.03 }));
    gate.setSpeaking(true, 0);
    // 自家回声经空气衰减能量低(0.01 < 0.03)→ 被挡,tier=speaking
    const d = gate.push(speech(10, 0.01));
    expect(d.pass).toBe(false);
    expect(d.tier).toBe('speaking');
  });

  it('Tier1:说话期低能量回声连续多帧仍全部被挡', () => {
    const gate = new EchoGuardGate(cfg({ confirmFrames: 1, cooldownRmsThreshold: 0.03 }));
    gate.setSpeaking(true, 0);
    for (let i = 0; i < 5; i++) {
      expect(gate.push(speech(i * 10, 0.01)).pass).toBe(false);
    }
  });

  it('Tier1:说话期真人足够响 + 连续 N 帧仍能打断(不变「打不断」)', () => {
    const gate = new EchoGuardGate(cfg({ confirmFrames: 2, cooldownRmsThreshold: 0.03 }));
    gate.setSpeaking(true, 0);
    expect(gate.push(speech(10, 0.5)).pass).toBe(false); // 1(响声 ≥ 0.03,但未够 N)
    const d = gate.push(speech(20, 0.5)); // 2 → 达 N
    expect(d.pass).toBe(true);
    expect(d.tier).toBe('speaking');
  });

  // ───────────────────────────── Tier 2:冷却窗 ─────────────────────────────

  it('Tier2:说完后冷却窗内,低能量帧被挡(高 RMS 门槛)', () => {
    const gate = new EchoGuardGate(cfg({ cooldownMs: 1500, cooldownRmsThreshold: 0.03 }));
    gate.setSpeaking(true, 0);
    gate.setSpeaking(false, 100); // 100ms 说完,冷却到 100+1500=1600ms
    // 冷却窗内(500ms),能量 0.01 < 0.03 → 挡
    const d = gate.push(speech(500, 0.01));
    expect(d.pass).toBe(false);
    expect(d.tier).toBe('cooldown');
  });

  it('Tier2:说完后冷却窗内,高能量帧放行(允许用户立刻回话)', () => {
    const gate = new EchoGuardGate(cfg({ cooldownMs: 1500, cooldownRmsThreshold: 0.03 }));
    gate.setSpeaking(true, 0);
    gate.setSpeaking(false, 100);
    // 冷却窗内,能量 0.5 ≥ 0.03 → 放行
    const d = gate.push(speech(500, 0.5));
    expect(d.pass).toBe(true);
    expect(d.tier).toBe('cooldown');
  });

  it('Tier2→open:冷却窗结束后恢复常态阈(base),冷却高阈不再生效', () => {
    const gate = new EchoGuardGate(
      cfg({ cooldownMs: 1500, cooldownRmsThreshold: 0.03, baseRmsThreshold: 0.005 }),
    );
    gate.setSpeaking(true, 0);
    gate.setSpeaking(false, 100); // 冷却到 1600ms
    // 冷却窗内:能量 0.01 介于 base(0.005) 与 cooldown(0.03) 之间 → 被冷却高阈挡
    expect(gate.push(speech(500, 0.01)).pass).toBe(false);
    // 冷却结束后(2000ms > 1600ms):同样能量 0.01 ≥ base(0.005) → 放行,tier=open
    const d = gate.push(speech(2000, 0.01));
    expect(d.pass).toBe(true);
    expect(d.tier).toBe('open');
  });

  it('open 态:能量 < baseRmsThreshold 被挡', () => {
    const gate = new EchoGuardGate(cfg({ baseRmsThreshold: 0.05 }));
    // 从未 setSpeaking → 一开始即 open
    expect(gate.push(speech(0, 0.01)).pass).toBe(false);
    expect(gate.push(speech(10, 0.2)).pass).toBe(true);
  });

  // ───────────────────────────── 连续帧去抖(承旧 confirmFrames)─────────────────────────────

  it('confirmFrames=3:open 态需连续 3 帧达标才放行', () => {
    const gate = new EchoGuardGate(cfg({ confirmFrames: 3, baseRmsThreshold: 0 }));
    expect(gate.push(speech(0)).pass).toBe(false); // 1
    expect(gate.push(speech(10)).pass).toBe(false); // 2
    expect(gate.push(speech(20)).pass).toBe(true); // 3
  });

  it('confirmFrames:中途掉线清零,需重新连续', () => {
    const gate = new EchoGuardGate(cfg({ confirmFrames: 3, baseRmsThreshold: 0 }));
    gate.push(speech(0));
    gate.push(speech(10));
    expect(gate.push(silence(20)).run).toBe(0); // 掉线清零
    expect(gate.push(speech(30)).pass).toBe(false); // 1
    expect(gate.push(speech(40)).pass).toBe(false); // 2
    expect(gate.push(speech(50)).pass).toBe(true); // 3
  });

  it('confirmFrames 误配 0/负 → 按 1 看待', () => {
    const gate = new EchoGuardGate(cfg({ confirmFrames: 0 }));
    expect(gate.push(silence(0)).pass).toBe(false);
    expect(gate.push(speech(10)).pass).toBe(true);
  });

  // ───────────────────────────── shouldSuppressInput(Tier2 听期混响尾抑制)─────────────────────────────

  it('shouldSuppressInput:冷却窗内低能量混响尾 → 抑制(true)', () => {
    const gate = new EchoGuardGate(cfg({ cooldownMs: 1500, cooldownRmsThreshold: 0.03 }));
    gate.setSpeaking(true, 0);
    gate.setSpeaking(false, 100); // 冷却到 1600ms
    expect(gate.shouldSuppressInput(speech(500, 0.01))).toBe(true);
  });

  it('shouldSuppressInput:冷却窗内高能量真语音 → 放行(false)', () => {
    const gate = new EchoGuardGate(cfg({ cooldownMs: 1500, cooldownRmsThreshold: 0.03 }));
    gate.setSpeaking(true, 0);
    gate.setSpeaking(false, 100);
    expect(gate.shouldSuppressInput(speech(500, 0.5))).toBe(false);
  });

  it('shouldSuppressInput:冷却窗外(open,base=0)→ 不抑制(false)', () => {
    const gate = new EchoGuardGate(cfg({ cooldownMs: 1500, baseRmsThreshold: 0 }));
    gate.setSpeaking(true, 0);
    gate.setSpeaking(false, 100);
    expect(gate.shouldSuppressInput(speech(5000, 0.001))).toBe(false);
  });

  it('shouldSuppressInput:不动 barge-in 连续计数(纯查询)', () => {
    const gate = new EchoGuardGate(cfg({ confirmFrames: 3, baseRmsThreshold: 0 }));
    gate.push(speech(0)); // run=1
    gate.shouldSuppressInput(speech(10)); // 不应清/加 run
    expect(gate.push(speech(20)).run).toBe(2); // 仍接续:1→(跳过)→2
  });

  it('shouldSuppressInput:禁用 → 恒不抑制', () => {
    const gate = new EchoGuardGate({ ...DEFAULT_ECHO_GUARD_CONFIG, enabled: false });
    expect(gate.shouldSuppressInput(silence())).toBe(false);
  });

  // ───────────────────────────── reset ─────────────────────────────

  it('reset:只清连续计数,不动档位(冷却窗延续)', () => {
    const gate = new EchoGuardGate(cfg({ confirmFrames: 3, cooldownMs: 1500, cooldownRmsThreshold: 0.03 }));
    gate.setSpeaking(true, 0);
    gate.setSpeaking(false, 100); // 开冷却窗到 1600ms
    gate.push(speech(200, 0.5)); // cooldown:run→1
    gate.reset();
    // reset 后:连续计数清零(run 从 1 重来),但**仍在冷却窗**(档位未被清)
    const d = gate.push(speech(300, 0.5));
    expect(d.tier).toBe('cooldown'); // 冷却窗延续,未被 reset 抹掉
    expect(d.run).toBe(1);
  });

  it('resetTiers:全量重置 → 清冷却/说话回 open', () => {
    const gate = new EchoGuardGate(cfg({ confirmFrames: 3, cooldownMs: 1500, cooldownRmsThreshold: 0.03 }));
    gate.setSpeaking(true, 0);
    gate.setSpeaking(false, 100); // 冷却到 1600
    gate.resetTiers();
    const d = gate.push(speech(200, 0.001)); // base=0 → 放行;tier=open(冷却被清)
    expect(d.tier).toBe('open');
    expect(d.run).toBe(1);
  });

  // ───────────────────────────── 可观测(day1 RMS 日志)─────────────────────────────

  it('可观测:每次 push 触发 onDecision 回调,带 RMS/tier/pass', () => {
    const records: EchoGuardDecision[] = [];
    const gate = new EchoGuardGate(cfg({ baseRmsThreshold: 0.05 }), {
      onDecision: (d) => records.push(d),
    });
    gate.push(speech(0, 0.2)); // open:0.2 ≥ base 0.05 → pass
    gate.setSpeaking(true, 10);
    gate.push(speech(20, 0.01)); // speaking:0.01 < cooldownRms 0.03 → 挡
    expect(records.length).toBe(2);
    expect(records[0]!.tier).toBe('open');
    expect(records[0]!.energy01).toBeCloseTo(0.2);
    expect(records[0]!.pass).toBe(true);
    expect(records[1]!.tier).toBe('speaking');
    expect(records[1]!.pass).toBe(false);
  });

  it('可观测:onDecision 抛错不影响门控决策(优雅降级)', () => {
    const gate = new EchoGuardGate(cfg(), {
      onDecision: () => {
        throw new Error('logger boom');
      },
    });
    // 即便日志回调抛错,push 仍返回正常决策、不抛
    expect(() => gate.push(speech(0))).not.toThrow();
  });
});
