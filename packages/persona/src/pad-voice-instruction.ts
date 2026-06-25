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

/** 离散情绪 → 语音情绪指令(只含情绪/语气维度,无语速)。neutral=空串(不强加)。 */
const EMOTION_VOICE_INSTRUCTION: Record<Emotion, string> = {
  joyful: '语气轻盈上扬,带着雀跃的笑意',
  content: '语气温柔放松,带点满足的暖意',
  neutral: '',
  down: '声音低沉一些,语气有点低落、提不起劲',
  irritated: '语气带点不耐烦,略显紧绷',
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
