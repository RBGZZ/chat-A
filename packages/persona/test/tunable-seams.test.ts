import { describe, it, expect } from 'vitest';
import {
  PersonaEngine,
  InMemoryPersonaStore,
  loadPersonaConfigFromEnv,
  padToEmotion,
  padToVoiceInstruction,
  DEFAULT_PERSONA_CONFIG,
  XIAOXUE_SEED,
  type Appraiser,
  type PersonaConfig,
  type Pad,
} from '../src/index';

/** 把引擎 PAD 钉到指定值的最小 store(load 返回固定快照 → tone() 读它)。 */
function fixedPadStore(pad: Pad): InMemoryPersonaStore {
  const store = new InMemoryPersonaStore();
  store.save({ ocean: XIAOXUE_SEED.ocean, pad, turn: 0 });
  return store;
}

const SILENT_APPRAISER: Appraiser = {
  appraise: () => Promise.resolve({ pleasure: 0, arousal: 0, dominance: 0 }),
};

describe('persona-tunable-seams: engine.tone() 阈值透传一致性(spec Scenario 4)', () => {
  // 基线 0.34:默认阈值 0.35 下 neutral;降阈 0.25 下进 content。
  const pad: Pad = { pleasure: 0.34, arousal: 0.1, dominance: 0 };

  it('默认 config → emotion / toneFragment(系统提示文案) / voiceInstruction 三处都按 0.35 判 neutral', () => {
    const engine = new PersonaEngine({ seed: XIAOXUE_SEED, store: fixedPadStore(pad), appraiser: SILENT_APPRAISER });
    const view = engine.tone();
    expect(view.emotion).toBe('neutral');
    // neutral 的语音指令为空串(EMOTION_VOICE_INSTRUCTION.neutral='')。
    expect(view.voiceInstruction).toBe('');
    // 系统提示情绪文案应是 neutral 对应文案,与显示情绪一致。
    expect(view.toneFragment).toContain('心情平平');
  });

  it('降低 pleasure 阈值到 0.25 → 三处同步升为 content,显示/提示/语音不漂移', () => {
    const cfg: PersonaConfig = {
      ...DEFAULT_PERSONA_CONFIG,
      emotion: { pleasureThreshold: 0.25, arousalThreshold: 0.25 },
    };
    const engine = new PersonaEngine({
      seed: XIAOXUE_SEED,
      store: fixedPadStore(pad),
      appraiser: SILENT_APPRAISER,
      config: cfg,
    });
    const view = engine.tone();
    expect(view.emotion).toBe('content');
    // 系统提示情绪文案随阈值一并变 content(否则会与显示情绪不一致 = spec Scenario 4 违反)。
    expect(view.toneFragment).toContain('平和愉悦');
    // 语音情绪指令也用同阈值 → content 的指令(非空)。
    expect(view.voiceInstruction).toBe(padToVoiceInstruction(pad, XIAOXUE_SEED.dials, cfg.emotion));
    expect(view.voiceInstruction).not.toBe('');
    // 与裸 padToEmotion 同阈值结论一致(单一权威)。
    expect(view.emotion).toBe(padToEmotion(pad, cfg.emotion));
  });
});

describe('persona-tunable-seams: loadPersonaConfigFromEnv', () => {
  it('无任何 env → 逐字 = DEFAULT_PERSONA_CONFIG(零回归)', () => {
    expect(loadPersonaConfigFromEnv({})).toEqual(DEFAULT_PERSONA_CONFIG);
  });

  it('解析 coldStart + 情绪阈值 env', () => {
    const cfg = loadPersonaConfigFromEnv({
      CHAT_A_COLD_START_TURNS: '0',
      CHAT_A_COLD_START_REBOUND: '3',
      CHAT_A_EMOTION_PLEASURE_THRESHOLD: '0.25',
      CHAT_A_EMOTION_AROUSAL_THRESHOLD: '0.1',
    });
    expect(cfg.coldStartTurns).toBe(0);
    expect(cfg.coldStartReboundFactor).toBe(3);
    expect(cfg.emotion).toEqual({ pleasureThreshold: 0.25, arousalThreshold: 0.1 });
    // 未暴露字段沿用默认。
    expect(cfg.evolutionEveryTurns).toBe(DEFAULT_PERSONA_CONFIG.evolutionEveryTurns);
    expect(cfg.maxOceanDeltaPerStep).toBe(DEFAULT_PERSONA_CONFIG.maxOceanDeltaPerStep);
  });

  it('非法/越界值逐字段回落现值(不整体丢弃)', () => {
    const cfg = loadPersonaConfigFromEnv({
      CHAT_A_COLD_START_TURNS: '-1', // 负 → 回落 5
      CHAT_A_COLD_START_REBOUND: 'abc', // 非数 → 回落 2
      CHAT_A_EMOTION_PLEASURE_THRESHOLD: '1.5', // >1 → 回落 0.35
      CHAT_A_EMOTION_AROUSAL_THRESHOLD: '0.4', // 合法 → 0.4
    });
    expect(cfg.coldStartTurns).toBe(DEFAULT_PERSONA_CONFIG.coldStartTurns);
    expect(cfg.coldStartReboundFactor).toBe(DEFAULT_PERSONA_CONFIG.coldStartReboundFactor);
    expect(cfg.emotion.pleasureThreshold).toBe(DEFAULT_PERSONA_CONFIG.emotion.pleasureThreshold);
    expect(cfg.emotion.arousalThreshold).toBe(0.4);
  });
});
