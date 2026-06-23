import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { Ocean, PersonaCard, PersonaDials, PersonaSeed, LoadedPersonaCard, SelfNotion } from './types';
import { XIAOXUE_SEED } from './seed';

/**
 * PersonaCard(§6.2,card-as-config)加载器。
 *
 * 设计纪律:
 * - 纯函数:只把 YAML 映射成 { seed, lore, userProfile },绝不 import/调用 MemoryStore
 *   (接缝边界,§3.1);落库副作用留给编排层(client)。
 * - 优雅降级(§3.2):文件缺失/YAML 失败/顶层结构非法 → 整卡回落默认种子 + 告警,绝不抛;
 *   单个数值字段越界 → 只回落该字段(coerce01),卡其余合法字段仍生效。
 * - 行为即配置:所有默认取自 XIAOXUE_SEED,无 magic number。
 */

/**
 * 把数值/数字字符串夹取到 [0,1];其余一律回落 fallback(字段级容错)。
 * 只认真正的 number 或非空数字字符串——显式拒绝 null/boolean/空串/对象,
 * 否则 `Number(null)===0`、`Number(true)===1` 会让"写空/写错"的字段静默变成 0/1
 * 而非回落默认(违反 §6.2 "非数→回落该字段默认值")。
 */
function coerce01(v: unknown, fallback: number): number {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim().length > 0) n = Number(v);
  else return fallback;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/** 非空字符串否则 fallback。 */
function coerceStr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim().length > 0 ? v : fallback;
}

/** 取字符串数组(过滤掉非字符串/空白项);非数组返回 []。 */
function coerceStrList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim());
}

/**
 * 解析 self_notions(§7#3):每条须有非空 position 与至少一个 topic 关键词,否则丢弃该条。
 * topic 接受字符串(单关键词)或字符串数组;非数组/全非法 → []。
 */
function coerceSelfNotions(v: unknown): SelfNotion[] {
  if (!Array.isArray(v)) return [];
  const out: SelfNotion[] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const position = typeof o['position'] === 'string' ? o['position'].trim() : '';
    if (position.length === 0) continue;
    const rawTopic = o['topic'];
    const topic = typeof rawTopic === 'string' ? coerceStrList([rawTopic]) : coerceStrList(rawTopic);
    if (topic.length === 0) continue;
    out.push({ topic, position });
  }
  return out;
}

function warn(msg: string): void {
  process.stderr.write(`[persona-card] ${msg}\n`);
}

/** 默认产物:等价 XIAOXUE 种子 + 空 lore/画像/观点。 */
function defaultLoaded(): LoadedPersonaCard {
  return { seed: XIAOXUE_SEED, lore: [], userProfile: [], selfNotions: XIAOXUE_SEED.selfNotions ?? [] };
}

/** 把(可能部分/含错的)PersonaCard 对象映射成种子 + 列表,逐字段回落默认。 */
function cardToLoaded(card: PersonaCard): LoadedPersonaCard {
  const base = XIAOXUE_SEED;
  const ocean: Ocean = {
    openness: coerce01(card.ocean?.openness, base.ocean.openness),
    conscientiousness: coerce01(card.ocean?.conscientiousness, base.ocean.conscientiousness),
    extraversion: coerce01(card.ocean?.extraversion, base.ocean.extraversion),
    agreeableness: coerce01(card.ocean?.agreeableness, base.ocean.agreeableness),
    neuroticism: coerce01(card.ocean?.neuroticism, base.ocean.neuroticism),
  };
  const dials: PersonaDials = {
    assertiveness: coerce01(card.dials?.assertiveness, base.dials.assertiveness),
    negativeAffectExpression: coerce01(card.dials?.negativeAffectExpression, base.dials.negativeAffectExpression),
    proactivity: coerce01(card.dials?.proactivity, base.dials.proactivity),
    intimacyPace: coerce01(card.dials?.intimacyPace, base.dials.intimacyPace),
    emotionalIntensity: coerce01(card.dials?.emotionalIntensity, base.dials.emotionalIntensity),
    emotionalVolatility: coerce01(card.dials?.emotionalVolatility, base.dials.emotionalVolatility),
    baselineWarmth: coerce01(card.dials?.baselineWarmth, base.dials.baselineWarmth),
    expressiveness: coerce01(card.dials?.expressiveness, base.dials.expressiveness),
  };
  const greetings = coerceStrList(card.greetings);
  const selfNotions = coerceSelfNotions(card.selfNotions);
  const seed: PersonaSeed = {
    name: coerceStr(card.name, base.name),
    identity: coerceStr(card.identity, base.identity),
    ocean,
    dials,
    ...(greetings.length > 0 ? { greetings } : base.greetings ? { greetings: base.greetings } : {}),
    ...(selfNotions.length > 0 ? { selfNotions } : base.selfNotions ? { selfNotions: base.selfNotions } : {}),
  };
  return {
    seed,
    lore: coerceStrList(card.lore),
    userProfile: coerceStrList(card.userProfile),
    selfNotions,
  };
}

/**
 * 解析 YAML 文本为加载产物。YAML 语法错误或顶层非对象 → 告警 + 默认种子(不抛)。
 */
export function parsePersonaCard(rawYaml: string): LoadedPersonaCard {
  let doc: unknown;
  try {
    doc = parseYaml(rawYaml);
  } catch (err) {
    warn(`YAML 解析失败,回落默认种子:${err instanceof Error ? err.message : String(err)}`);
    return defaultLoaded();
  }
  if (doc === null || doc === undefined) return defaultLoaded();
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    warn('卡顶层结构非法(应为映射对象),回落默认种子');
    return defaultLoaded();
  }
  return cardToLoaded(doc as PersonaCard);
}

/**
 * 从文件加载 PersonaCard。path 省略/为空 → 默认种子;文件缺失/读失败 → 告警 + 默认种子(不抛)。
 */
export function loadPersonaCard(path?: string): LoadedPersonaCard {
  if (path === undefined || path.trim().length === 0) return defaultLoaded();
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    warn(`读取卡文件失败(${path}),回落默认种子:${err instanceof Error ? err.message : String(err)}`);
    return defaultLoaded();
  }
  return parsePersonaCard(content);
}
