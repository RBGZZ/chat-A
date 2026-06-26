/**
 * ASR 静音/噪声幻觉「填充词黑名单」(防 ASR 静音幻觉的**补充**判别,鲁棒性第二道)。
 *
 * 背景:qwen-asr 在静音/噪声段会幻觉出固定的短填充词(中文「嗯/谢谢观看」、英文「thank you/you」、
 * 日文「ありがとう/はい」)。**能量是第一判别**(段无足够有声内容);黑名单只是补充——
 * 仅在「精确命中填充词 ∧ 低能量」合取时才丢(真说「嗯」有 voiced 能量 → 不丢)。
 *
 * 设计要点:
 * - **精确匹配(归一化后整串相等)**,非子串包含——故长真语句即便含「thank you」也绝不误命中
 *   (「thank you very much」≠「thank you」),无需额外的「短」长度闸:精确匹配已自然蕴含「短」。
 * - 归一化:trim → 全角转半角 → 小写 → 去标点/空白(两侧同口径,故「Thank you.」与「thank you」相等)。
 * - 纯函数、无状态、确定可测;`enabled`/语种子集由装配层决定(不注入 = 逐字现状,只剩空文本判伪)。
 */

/** 黑名单覆盖的语种码。 */
export type DenylistLang = 'zh' | 'en' | 'ja';

/** 多语种填充词黑名单(原文;函数内部按同口径归一化后精确比较)。 */
export interface FillerDenylist {
  readonly byLang: Readonly<Record<DenylistLang, readonly string[]>>;
}

/**
 * 缺省多语种填充词黑名单(对齐设计):
 * - zh:嗯、嗯嗯、啊、呃、哦、谢谢、谢谢观看、谢谢大家、请订阅
 * - en:thank you、thanks、you、okay、ok、bye、yeah、uh、um
 * - ja:ありがとう、ありがとうございました、はい、うん
 */
export const DEFAULT_FILLER_DENYLIST: FillerDenylist = {
  byLang: {
    zh: ['嗯', '嗯嗯', '啊', '呃', '哦', '谢谢', '谢谢观看', '谢谢大家', '请订阅'],
    en: ['thank you', 'thanks', 'you', 'okay', 'ok', 'bye', 'yeah', 'uh', 'um'],
    ja: ['ありがとう', 'ありがとうございました', 'はい', 'うん'],
  },
};

/**
 * 归一化:trim → 全角转半角(FF01-FF5E + 全角空格 U+3000)→ 小写 → 去标点/空白。
 * 两侧(转写文本 + 黑名单条目)同口径,故「Thank you.」「ＯＫ」「嗯，」分别归一为「thankyou」「ok」「嗯」。
 */
export function normalizeForDenylist(text: string): string {
  return text
    .trim()
    // 全角 ASCII(！-～)转半角
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    // 全角空格 → 半角空格
    .replace(/　/g, ' ')
    .toLowerCase()
    // 去所有标点与空白(Unicode 标点类 + 空白)
    .replace(/[\s\p{P}]/gu, '');
}

/**
 * 转写文本归一化后是否**精确命中**黑名单(在选定语种子集内,缺省并集全名单)。
 * - 空文本(归一化后为空)→ false(空文本由调用方的「空转写」分支单独处理)。
 * - 精确匹配 → 长真语句绝不被子串误命中(鲁棒性第一保证);低能量合取由调用方(voice-loop)叠加。
 */
export function isDenylistedFiller(
  text: string,
  denylist: FillerDenylist = DEFAULT_FILLER_DENYLIST,
  langs?: readonly DenylistLang[],
): boolean {
  const norm = normalizeForDenylist(text);
  if (norm.length === 0) return false;
  const selected = langs ?? (Object.keys(denylist.byLang) as DenylistLang[]);
  for (const lang of selected) {
    for (const phrase of denylist.byLang[lang] ?? []) {
      if (normalizeForDenylist(phrase) === norm) return true;
    }
  }
  return false;
}
