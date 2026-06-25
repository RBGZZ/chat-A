import { padToEmotion } from './numeric';
import type { Emotion, Pad, PersonaDials } from './types';

/**
 * PAD 心情 → CosyVoice 风格"语音情绪指令"(承 §6 PAD 情绪 + §4.1 TTS 情感;§3.1 确定性内核可 golden 测)。
 *
 * 为什么:小雪是长期伴侣、有情绪内核;让她的复刻音色"带着当下心情说话"。把 PAD 映成一句自然语言
 * 情绪指令,经 TtsOptions.instruction 注入 CosyVoice 的 parameters.instruction。
 *
 * 纪律:
 * - **确定性纯函数**(同输入同输出),不调 LLM(§3.1「能用代码算的不交给 LLM」);
 * - **不依赖 providers**(产出纯字符串;镜像 prosodyToPadPull 用结构类型解耦);
 * - 复用 {@link padToEmotion} 做主分类(**单一权威**,与既有离散情绪一致,不引第二套阈值漂移);
 * - **只表达情绪/语气,不含语速**——语速归 TTS rate(`CHAT_A_TTS_RATE`)独立控制,避免与之打架;
 * - 中性/接近基线 → 空串(=不发 instruction,温和不强加情绪);
 * - 输出按 `.length` 截断到 ≤ {@link VOICE_INSTRUCTION_MAX_LEN}。
 */

/**
 * CosyVoice instruction 字符上限相关:输出按 JS `.length`(UTF-16 码元)截断到 ≤100。
 * 注:CosyVoice 服务端按"汉字算 2、其它算 1"计长,中文指令实占约 2×;故 .length≤100 已足够保守安全。
 */
export const VOICE_INSTRUCTION_MAX_LEN = 100;

/**
 * 离散情绪 → 语音情绪指令。**纪律(2026-06-25 调研结论)**:CosyVoice 自然语言 instruction 会连
 * 音色一起改;只用 🟢 安全词(情绪/语气/语调)、**严禁 🔴 伤音色词**(声音低沉/沙哑/浑厚/磁性/男低音
 * 等描述嗓音物理属性的词=让模型重塑音色)。亦不含语速(语速归 TTS rate)。neutral=空串(不强加)。
 * 详见记忆 cosyvoice-clone-synth-contract「情感控制 vs 音色保真」+ docs/emotion-vs-timbre-2026-06-25.md。
 */
const EMOTION_VOICE_INSTRUCTION: Record<Emotion, string> = {
  joyful: '语气开心,轻盈上扬,带着雀跃的笑意',
  content: '语气温和放松,带点满足的暖意',
  neutral: '',
  // ⚠️ 不用"声音低沉"(伤音色);改用纯情绪/语气词。
  down: '情绪有些低落,语气提不起劲、有点失落',
  irritated: '语气有点不耐烦,带着些许急躁',
};

/**
 * 把 PAD 心情映射成语音情绪指令字符串。
 * `dials` 入参可选、**本次不消费**(只看 PAD);保留形参为未来按 expressiveness/emotionalIntensity
 * 调情绪强度留口(届时改此一处 + 补 golden,爆炸半径可控)。
 */
export function padToVoiceInstruction(pad: Pad, _dials?: PersonaDials): string {
  const instr = EMOTION_VOICE_INSTRUCTION[padToEmotion(pad)];
  return instr.length > VOICE_INSTRUCTION_MAX_LEN
    ? instr.slice(0, VOICE_INSTRUCTION_MAX_LEN)
    : instr;
}
