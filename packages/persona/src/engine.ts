import type { Appraiser, Emotion, Pad, PersonaConfig, PersonaSeed, PersonaSnapshot, PersonaStore } from './types';
import { DEFAULT_PERSONA_CONFIG } from './defaults';
import { oceanToPadBaseline, padToEmotion, stepPad } from './numeric';
import { renderToneFragment } from './tone';
import { DefaultAppraiser } from './appraiser';
import { InMemoryPersonaStore } from './store';

export interface PersonaTurn {
  readonly emotion: Emotion;
  readonly toneFragment: string;
  readonly pad: Pad;
}

export interface PersonaEngineOptions {
  readonly seed: PersonaSeed;
  readonly appraiser?: Appraiser;
  readonly store?: PersonaStore;
  readonly config?: PersonaConfig;
}

/**
 * 人格引擎:绑定种子/旋钮/评估器/持久化,驱动每轮情绪步进(承 §6.1 流程)。
 * 首启从 store 载入快照;无则用种子初始化(OCEAN=种子、PAD=基线)。
 */
export class PersonaEngine {
  readonly #seed: PersonaSeed;
  readonly #config: PersonaConfig;
  readonly #appraiser: Appraiser;
  readonly #store: PersonaStore;
  #snapshot: PersonaSnapshot;

  constructor(opts: PersonaEngineOptions) {
    this.#seed = opts.seed;
    this.#config = opts.config ?? DEFAULT_PERSONA_CONFIG;
    this.#appraiser = opts.appraiser ?? new DefaultAppraiser();
    this.#store = opts.store ?? new InMemoryPersonaStore();
    const loaded = this.#store.load();
    this.#snapshot = loaded ?? {
      ocean: opts.seed.ocean,
      pad: oceanToPadBaseline(opts.seed.ocean, opts.seed.dials),
      turn: 0,
    };
  }

  /** 当前持久化快照。 */
  current(): PersonaSnapshot {
    return this.#snapshot;
  }

  /** 观察一条用户输入:appraise → spring 步进 → 持久化 → 返回本轮情绪与 tone。 */
  observe(userText: string): PersonaTurn {
    const dials = this.#seed.dials;
    const turn = this.#snapshot.turn + 1;
    const baseline = oceanToPadBaseline(this.#snapshot.ocean, dials);
    const pull = this.#appraiser.appraise({ userText, pad: this.#snapshot.pad, turn });
    const pad = stepPad({ pad: this.#snapshot.pad, pull, baseline, dials, turn, config: this.#config });
    this.#snapshot = { ocean: this.#snapshot.ocean, pad, turn };
    this.#store.save(this.#snapshot);
    return { emotion: padToEmotion(pad), toneFragment: renderToneFragment(pad, dials), pad };
  }
}
