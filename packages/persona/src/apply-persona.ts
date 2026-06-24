/**
 * 人格自定义薄接口(承北极星「人格由用户自定义」+ §6.2 用户自治):
 * 把"用户编辑的最小人格字段(名字 + 三档情绪旋钮)"夹取 + 应用到一个既有 `PersonaSeed`,
 * 产出**新种子**(纯函数,不改原种子、不碰 engine.ts 的情绪推进核心)。
 *
 * 设计:只暴露**读/应用**层薄函数,engine 当前不支持"运行时改 dials",故走
 * 「更新 seed → 重建引擎/会话(保留长期记忆与 PAD 持久化)」路径(见 client `applyPersona`)。
 * 三档对齐 desktop 横幅已展示的 `warmth/expressiveness/volatility`(= dials 的
 * baselineWarmth / expressiveness / emotionalVolatility),其余 dials 原样保留。
 */
import type { PersonaSeed } from './types';
import { clamp01 } from './defaults';

/** 用户可编辑的最小人格补丁(全可选;缺省字段不改)。 */
export interface PersonaPatch {
  /** 名字(空白/缺省 → 不改)。 */
  readonly name?: string;
  /** 基础温暖 [0,1](对应 dials.baselineWarmth)。 */
  readonly warmth?: number;
  /** 表达度 [0,1](对应 dials.expressiveness)。 */
  readonly expressiveness?: number;
  /** 情绪波动 [0,1](对应 dials.emotionalVolatility)。 */
  readonly volatility?: number;
}

/** 当前人格可读视图(读路径返回;与 desktop AppInfo 的三档同义)。 */
export interface PersonaView {
  readonly name: string;
  readonly warmth: number;
  readonly expressiveness: number;
  readonly volatility: number;
}

/** 从种子摘出可编辑视图(纯)。 */
export function personaViewOf(seed: PersonaSeed): PersonaView {
  return {
    name: seed.name,
    warmth: seed.dials.baselineWarmth,
    expressiveness: seed.dials.expressiveness,
    volatility: seed.dials.emotionalVolatility,
  };
}

/**
 * 把数字补丁字段夹取到 [0,1];非有限/缺省 → 回落到原值(纯函数,无 magic number)。
 */
function num01OrKeep(raw: number | undefined, fallback: number): number {
  if (raw === undefined || !Number.isFinite(raw)) return fallback;
  return clamp01(raw);
}

/**
 * 把名字补丁规整:非空白 → trim 后采用;空白/缺省 → 回落原名(纯函数,绝不产出空名)。
 */
function nameOrKeep(raw: string | undefined, fallback: string): string {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * 应用人格补丁,产出**新种子**(纯函数,不改原种子):
 * - 名字:空白/缺省回落原名;非空 trim 采用。
 * - 三档:各自夹取 [0,1],缺省/非有限回落原值,写回对应 dials 字段;其余 dials 原样保留。
 * identity/ocean/selfNotions/greetings 等不在最小可编辑面内 → 一律原样保留。
 */
export function applyPersonaPatch(seed: PersonaSeed, patch: PersonaPatch): PersonaSeed {
  return {
    ...seed,
    name: nameOrKeep(patch.name, seed.name),
    dials: {
      ...seed.dials,
      baselineWarmth: num01OrKeep(patch.warmth, seed.dials.baselineWarmth),
      expressiveness: num01OrKeep(patch.expressiveness, seed.dials.expressiveness),
      emotionalVolatility: num01OrKeep(patch.volatility, seed.dials.emotionalVolatility),
    },
  };
}
