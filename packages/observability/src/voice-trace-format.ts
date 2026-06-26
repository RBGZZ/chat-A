/**
 * 语音 trace 事件 → 实时结构日志单行(纯函数,可单测;承 spec §6)。
 *
 * 单行紧凑、对齐既有 `[xxx]` 前缀风格,便于真机滚动看。可选字段缺省即省略
 * (clipText/emotion/lang/ttfa)。rms 类保留 3~4 位小数:mic 取 4 位(判静音需更细分辨),
 * 其余取 3 位。装配层在 `CHAT_A_VOICE_TRACE=1` 时把它接到 stdout(本函数不做 IO)。
 */

import type { VoiceTraceEvent } from '@chat-a/protocol';

const PREFIX = '[vtrace] ';

/** mic 取 4 位小数(更细);echo-guard/stt-input 取 3 位。 */
const rms4 = (n: number): string => n.toFixed(4);
const rms3 = (n: number): string => n.toFixed(3);

/** 语音 trace 事件 → 单行字符串(含 `[vtrace] ` 前缀,无换行)。 */
export function formatVoiceTrace(ev: VoiceTraceEvent): string {
  switch (ev.kind) {
    case 'mic-sample':
      return `${PREFIX}mic rms=${rms4(ev.rmsNorm)}`;
    case 'vad':
      return `${PREFIX}vad ${ev.event}`;
    case 'endpoint':
      return `${PREFIX}endpoint silence=${ev.silenceMs}ms`;
    case 'echo-guard':
      return `${PREFIX}echo-guard tier=${ev.tier} rms=${rms3(ev.rmsNorm)} run=${ev.run} passed=${ev.passed}`;
    case 'speech-gate':
      return `${PREFIX}speech-gate passed=${ev.passed} total=${ev.totalMs}ms voiced=${ev.voicedMs}ms`;
    case 'backchannel': {
      const clip = ev.clipText === undefined ? '' : ` clipText="${ev.clipText}"`;
      return `${PREFIX}backchannel fired=${ev.fired}${clip}`;
    }
    case 'state':
      return `${PREFIX}state ${ev.from}→${ev.to}`;
    case 'stt-input':
      return `${PREFIX}stt-input path=${ev.path} dur=${ev.durationMs}ms rms=${rms3(ev.rmsNorm)}`;
    case 'stt-result': {
      const finality = ev.isFinal ? 'final' : 'partial';
      const emotion = ev.emotion === undefined ? '' : ` emotion=${ev.emotion}`;
      const lang = ev.lang === undefined ? '' : ` lang=${ev.lang}`;
      return `${PREFIX}stt-result ${finality} text="${ev.text}"${emotion}${lang}`;
    }
    case 'turn': {
      const ttfa = ev.ttfaMs === undefined ? '' : ` ttfa=${ev.ttfaMs}ms`;
      return `${PREFIX}turn outcome=${ev.outcome}${ttfa}`;
    }
  }
}
