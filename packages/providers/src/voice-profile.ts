/**
 * voice 配置块(§4.1 语音 I/O 输入/输出语种解绑,行为即配置 §3.2)。
 *
 * **输入语种(听)与输出语种(说)解绑**:用户可用一种语言说、小雪按设定语言答(可同可不同)。
 * 本模块只做**纯解析**(env → VoiceProfile),无副作用、不触网;装配层(client)据此拼
 * STT 的 `SttOptions.language` 与 TTS 的 `TtsOptions{language,voiceId,refAudio}`,经注入透传给
 * VoiceLoop(§3.1 接缝边界:VoiceLoop 不直接 import 本 config,只吃注入的解析结果)。
 *
 * **缺省安全(硬约束)**:不配置时各键**省略**(exactOptionalPropertyTypes,绝不显式 undefined)→
 * STT 不下发 language(自动检测)、TTS opts 为 undefined、LLM 无输出语种注入 → 行为逐字现状。
 *
 * 多 provider 按语种自动路由/切换 = **future**(§4.1 能力驱动路由);本期只透传单一已配 provider 的
 * language/voice + 经既有能力门 `assertSttLanguage`/`assertTtsLanguage` fail-fast(§4.3)。
 */

/**
 * 参考音色样本(zero-shot 复刻用,§4.1/v2.1);字段对齐 `TtsRefAudio`(source 这里用路径字符串)。
 */
export interface VoiceCloneRef {
  /** 参考音频路径(GPT-SoVITS `ref_audio_path` / CosyVoice 上传 / Coqui `speaker_wav`)。 */
  readonly source: string;
  /** 参考音频转写文本(`prompt_text`);提升复刻保真,可选。 */
  readonly refText?: string;
  /** 参考音频语种(`prompt_lang`);省略时部分引擎回落目标语种,可选。 */
  readonly refLang?: string;
}

/**
 * 解析好的 voice 配置(§4.1)。各字段**省略=不强制/自动**:
 * - `inputLang` 省略 = STT 自动检测(transcribe 不下发 language)。
 * - `outputLang` 省略 = 不强制(LLM 无注入 + TTS 不下发 language)。
 * - `voiceId` / `cloneRef` 省略 = 用 provider 默认音色 / 不走复刻。
 */
export interface VoiceProfile {
  readonly inputLang?: string;
  readonly outputLang?: string;
  readonly voiceId?: string;
  readonly cloneRef?: VoiceCloneRef;
}

/** 输入语种取此值(或空)视作自动检测(大小写不敏感)。 */
const AUTO_INPUT_LANG = 'auto';

/**
 * 从环境变量加载 voice 配置(§4.1):
 *   CHAT_A_VOICE_INPUT_LANG    = auto | zh | en | ja …(缺省/auto = 自动检测,inputLang 省略)
 *   CHAT_A_VOICE_OUTPUT_LANG   = 目标输出语种(缺省空 = 不强制,outputLang 省略)
 *   CHAT_A_VOICE_ID            = 音色 id(内置或已注册复刻音色)
 *   CHAT_A_VOICE_CLONE_REF     = 即时复刻参考音频路径(给定才产出 cloneRef)
 *   CHAT_A_VOICE_CLONE_REF_TEXT= 参考音频转写文本(可选)
 *   CHAT_A_VOICE_CLONE_REF_LANG= 参考音频语种(可选)
 *
 * 各未设字段一律**省略键**(缺省安全:全空 → 全链路逐字现状)。
 */
export function loadVoiceProfile(env: NodeJS.ProcessEnv = process.env): VoiceProfile {
  const rawInput = env['CHAT_A_VOICE_INPUT_LANG']?.trim();
  // auto / 空 → 自动检测(inputLang 省略)。
  const inputLang =
    rawInput && rawInput.toLowerCase() !== AUTO_INPUT_LANG ? rawInput : undefined;

  const rawOutput = env['CHAT_A_VOICE_OUTPUT_LANG']?.trim();
  const outputLang = rawOutput && rawOutput.length > 0 ? rawOutput : undefined;

  const rawVoiceId = env['CHAT_A_VOICE_ID']?.trim();
  const voiceId = rawVoiceId && rawVoiceId.length > 0 ? rawVoiceId : undefined;

  const rawCloneRef = env['CHAT_A_VOICE_CLONE_REF']?.trim();
  const cloneRef: VoiceCloneRef | undefined =
    rawCloneRef && rawCloneRef.length > 0
      ? {
          source: rawCloneRef,
          ...(env['CHAT_A_VOICE_CLONE_REF_TEXT']?.trim()
            ? { refText: env['CHAT_A_VOICE_CLONE_REF_TEXT']!.trim() }
            : {}),
          ...(env['CHAT_A_VOICE_CLONE_REF_LANG']?.trim()
            ? { refLang: env['CHAT_A_VOICE_CLONE_REF_LANG']!.trim() }
            : {}),
        }
      : undefined;

  return {
    ...(inputLang !== undefined ? { inputLang } : {}),
    ...(outputLang !== undefined ? { outputLang } : {}),
    ...(voiceId !== undefined ? { voiceId } : {}),
    ...(cloneRef !== undefined ? { cloneRef } : {}),
  };
}
