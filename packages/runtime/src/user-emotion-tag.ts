/**
 * omni audio-in 直路（path B，§7#5 prosody）「情感→PAD」**显式情绪标签**纯函数集。
 *
 * 设计依据：`docs/multimodal-voice-emotion-investigation-2026-06-25.md` §5 P1 方案 A
 * 与 openspec change `omni-prosody-to-pad`。
 *
 * 背景：omni 直路 `#startThinkingOmni` 不调 `#send`，原本不把用户语气情绪喂进 PAD（断链）。
 * 方案 A：让模型在回复**末尾**附机读标签 `[user_emotion:<label>-<intensity>]`，VoiceLoop 从尾部
 * 剥掉它（**绝不进 TTS/显示/记忆**）再映射成 `SttEmotionLike` 经可选钩子喂 PAD（复用 `prosodyToPadPull`）。
 *
 * 本文件全为**确定性纯函数 + 常量**（无 I/O、无副作用，可 golden test，§3.2 可测试性）：
 * - {@link OMNI_USER_EMOTION_DIRECTIVE}：注入 omni 系统提示的标签门控指令（单一真相源）。
 * - {@link stripUserEmotionTag}：从文本尾部解析+剥离标签，回传干净文本 + 可选情绪。
 * - {@link splitSafeTextForTag}：流式喂句前的 hold-back，避免半截标签被当正文念出来。
 */
import type { SttEmotionLike } from '@chat-a/persona';

/**
 * 7 类 prosody 情绪标签（与 providers 的 `SttEmotionLabel` / `prosodyToPadPull` 接受集合逐字一致）。
 * 单一真相源：指令文案与解析白名单共用，杜绝双源漂移。
 */
export const USER_EMOTION_LABELS = [
  'surprised',
  'neutral',
  'happy',
  'sad',
  'disgusted',
  'angry',
  'fearful',
] as const;

/** 标签白名单集合（解析时校验 label 合法性）。 */
const LABEL_SET: ReadonlySet<string> = new Set(USER_EMOTION_LABELS);

/** 机读标签的关键字前缀（hold-back 与解析共用，单一真相源）。 */
const TAG_OPEN = '[user_emotion:';

/**
 * 注入 omni 直路系统提示的标签门控指令（**仅 omni 路**追加；STT/文字路不经过）。
 * 要求模型在回复**最后**单独附一个机读标签，供程序读出用户语气情绪喂 PAD；明确「不要在正文里念它」。
 */
export const OMNI_USER_EMOTION_DIRECTIVE = [
  '[语音情绪标注·只给程序读]',
  '请在你这次回复的**最末尾**，单独附上一个机读标签，用来标注**用户刚才说话的语气情绪**（不是你自己的情绪）：',
  `格式固定为 [user_emotion:标签-强度]，标签只能从这 7 个里选其一：${USER_EMOTION_LABELS.join(' / ')}；强度是 1 到 10 的整数。`,
  '例如用户听起来很低落就写 [user_emotion:sad-7]；听起来平静就写 [user_emotion:neutral-3]。',
  '这个标签只给程序解析、不会念给用户，所以**不要在正文里提它、不要解释它**，正文照常自然说话，只在结尾附上即可。',
].join('\n');

/** 完整标签匹配（全局、大小写不敏感）：捕获 label 与 intensity（1~2 位数字）。 */
const TAG_RE = /\[user_emotion:([a-z]+)-(\d{1,2})\]/gi;

/**
 * 从文本中**剥离所有** `[user_emotion:...]` 标签，并取**最后一个**合法标签作为本轮情绪。
 *
 * - 多标签 → 取最后一个；所有标签均从 `cleanText` 剥除（不进 TTS/显示/记忆）。
 * - label 不在 7 类白名单 / intensity 不在 [1,10] → **emotion 缺席**（零情绪降级），仍剥除标签。
 * - 无标签 → `cleanText` 原样、`emotion` 缺席。
 * - intensity → `confidence = intensity/10`（喂 `SttEmotionLike.confidence`，`prosodyToPadPull` 线性缩放）。
 *
 * 返回采用 exactOptional 风格：仅在解析到合法情绪时带 `emotion` 键。
 */
export function stripUserEmotionTag(text: string): {
  readonly cleanText: string;
  readonly emotion?: SttEmotionLike;
} {
  let lastEmotion: SttEmotionLike | undefined;
  // 用 replace 一次性剥除所有标签；回调里记录最后一个**合法**标签。
  const cleanText = text.replace(TAG_RE, (_m, rawLabel: string, rawIntensity: string) => {
    const label = rawLabel.toLowerCase();
    const intensity = Number.parseInt(rawIntensity, 10);
    if (LABEL_SET.has(label) && intensity >= 1 && intensity <= 10) {
      lastEmotion = { label, confidence: intensity / 10 };
    }
    return ''; // 无论是否合法,标签本身都剥除（绝不念出/写库）
  });
  return lastEmotion !== undefined ? { cleanText, emotion: lastEmotion } : { cleanText };
}

/**
 * 流式喂句前的 **hold-back**:把「保证不可能再属于一个未完成标签前缀」的安全部分切出来 emit，
 * 把末尾**可能是半截标签**(如 `[`、`[user_e`、`[user_emotion:sad-`、乃至已完整的 `[user_emotion:sad-7]`)
 * 的尾巴留在 `hold` 不喂——等后续 token 续上或在收尾时由 {@link stripUserEmotionTag} 处理。
 *
 * 为何需要它:标签不含句末标点,`SentenceSplitter` 不会在标签处切句；若把标签直接喂 splitter，
 * 它会留在缓冲 → `flush()` 把标签当尾句念出来。hold-back 确保标签永不进 TTS。
 *
 * 实现:找最后一个 `[`；若从它到末尾的子串**是某个 `[user_emotion:...]` 标签的可行前缀**
 * (含已完整的标签),则 hold 之，其余 emit；否则全部 emit。纯函数,`emit + hold === text`(无损)。
 */
export function splitSafeTextForTag(text: string): { readonly emit: string; readonly hold: string } {
  const lastOpen = text.lastIndexOf('[');
  if (lastOpen < 0) return { emit: text, hold: '' };
  const suffix = text.slice(lastOpen);
  if (isPotentialTagPrefix(suffix)) {
    return { emit: text.slice(0, lastOpen), hold: suffix };
  }
  return { emit: text, hold: '' };
}

/**
 * 判断 `s`(以 `[` 开头)是否可能是一个 `[user_emotion:label-intensity]` 标签的可行前缀
 * (含半截 / 已完整)。用于 hold-back:可疑则留住,等后续 token 或收尾解析。
 */
function isPotentialTagPrefix(s: string): boolean {
  const lower = s.toLowerCase();
  // 1) 还没打满关键字前缀:必须是 TAG_OPEN 的前缀（如 `[`、`[user_e`）。
  if (lower.length <= TAG_OPEN.length) {
    return TAG_OPEN.startsWith(lower);
  }
  // 2) 已含完整关键字前缀:其后只允许 [a-z]+ 标签、可选 `-`、可选 1~2 位数字、可选闭合 `]`。
  if (!lower.startsWith(TAG_OPEN)) return false;
  const rest = lower.slice(TAG_OPEN.length);
  // 允许的「标签主体」前缀形态:label / label- / label-digits / label-digits]
  return /^[a-z]*(-\d{0,2}\]?)?$/.test(rest);
}
