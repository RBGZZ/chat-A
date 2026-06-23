# chat-A 语音管线权威参考:音频格式 + STT/TTS API 参数 + 音色复刻（2026-06-23）

> 只读调查产出。证据分两类:**[已验证]** = 本地 `reference/` 代码有 path:line,或官方文档明确;**[推断]** = 由约定/惯例推导。本地根 `reference/github-projects/`(下称 `…/`)。给 protocol 音频/帧类型(V1)+ providers STT/TTS 接缝(V2)+ 未来语音回合接线做裏取。

## 1. 规范音频格式(业界事实标准,交叉佐证 [已验证])
几乎所有本地语音栈:**STT 入 = 16kHz / mono / 16-bit PCM(s16le)**;**TTS 出 = 24kHz / mono**。
- Pipecat(我们的帧管线基座):`audio_in_sample_rate=16000` / `audio_out_sample_rate=24000`(`…/voice-infra/pipecat/src/pipecat/frames/frames.py:922-923`)。
- Open-LLM-VTuber ASR:`SAMPLE_RATE=16000 / NUM_CHANNELS=1 / SAMPLE_WIDTH=2`(`asr/asr_interface.py:7-9`)。
- RealtimeVoiceChat:STT 16k INT16 / TTS 24000;voice-core:STT 16k float32 / TTS 24000(Kokoro);projectBEA/Kokoro:24000。

### chat-A 规范音频格式表
| 档位 | 采样率 | 声道 | 编码 | 分块 |
|---|---|---|---|---|
| 终端→大脑 上行(麦克风) | 16000 | 1 | 16-bit PCM **s16le** | **10ms=160样本=320字节**(或 20/30ms,VAD 友好) |
| 终端←大脑 下行(扬声器) | 24000 | 1 | s16le | 10ms 批量(Pipecat 默认 40ms 缓冲) |
| STT 入 | 16000 | 1 | s16le(引擎内转 float32 归一 [-1,1]) | VAD 窗 512 样本(32ms@16k)/ webrtcvad 10/20/30ms |
| TTS 出 | 24000 | 1 | s16le(Kokoro/OpenAI pcm 原生;Edge-TTS 原生 MP3 需解码) | 句级/分块流式 |

- 派生数(16-bit):每秒字节 = `采样率×2`;`numFrames = len(audio)/(channels*2)`(`frames.py:172`)。10ms@16k=320B、@24k=480B。
- **重采样在大脑侧用 SOXR 流式重采样器统一**(Pipecat `audio/resamplers/soxr_stream_resampler.py`,VHQ/HQ/MQ/LQ/QQ,嵌入式降 QQ/LQ 省算力)。

## 2. STT API 参数 [已验证]
### 本地引擎
- **faster-whisper**:`model_size`(tiny…large-v3-turbo/distil-*)、`device`(auto/cpu/cuda)、`compute_type`(int8/float16/int8_float16/float32)、`language`、`beam_size`(默认5)、`vad_filter`(Silero)、`chunk_length=30`;输入 16k float32 归一(库内自动重采样)。
- **Sherpa-ONNX ASR(端侧首选)**:`sample_rate=16000`、`feature_dim=80`、transducer/paraformer/sense_voice 等、`provider=cpu`、`num_threads`、`decoding=greedy_search`;**流式 transducer 支持真流式,树莓派友好**(`sherpa_onnx_asr.py:13,31,36-41`)。
- **Whisper.cpp**:model/language,隐式 16k mono。
### 云 OpenAI 兼容 `/audio/transcriptions`
`model`(whisper-1 / gpt-4o-transcribe / gpt-4o-mini-transcribe)、`language`、`response_format`(json/text/srt/verbose_json/vtt;**gpt-4o-transcribe 仅 json**,verbose_json 仅 whisper-1)、`temperature`(默认0)、`timestamp_granularities[]`(word/segment,需 verbose_json+whisper-1)、`stream`(gpt-4o 系列支持,whisper-1 不支持)。上传容器:float32→int16 PCM→WAV。

## 3. TTS API 参数 [已验证]
- **Edge-TTS**:`voice`/`rate("+0%")`/`volume`/`pitch("+0Hz")`;**输出 MP3 24kHz 需解码**(非 PCM);流式 `Communicate.stream()`。
- **Kokoro**:`voice`(af_sky/af_heart…可混)、`speed=1.0`、`sample_rate=24000`、`lang=en-us`;**kokoro-onnx 纯 CPU 可跑**;输出 float32 mono;**Apache 2.0,82M,54 音色/8 语言**。
- **OpenAI 兼容 `/audio/speech`**:`model`(tts-1/gpt-4o-mini-tts;本地兼容服务可填 kokoro)、`voice`、`response_format`(mp3/opus/aac/flac/wav/**pcm**)、`speed`(0.25-4)、`instructions`(仅 gpt-4o-mini-tts)、`stream`。**`pcm` = 24kHz 16-bit s16le 无头,最低延迟,chat-A 推荐默认**。
- **Piper(端侧极轻)**:`length_scale`(语速)/`noise_scale=0.667`/`noise_w`/`speaker_id`;采样率取自模型(典型 22.05k,需重采样)。
- **Sherpa-ONNX TTS(VITS)**:`speaker_id`/`speed`/`provider=cpu`,WAV PCM16。

## 4. chat-A 接缝落地建议
### protocol 音频帧 payload(对齐 Pipecat AudioRawFrame [已验证 frames.proto:23-30])
```
AudioFrame { audio: bytes(s16le); sampleRate: uint32(16000上行/24000下行); numChannels: uint32(=1); ptsNs?: uint64 }
// 区分 InputAudioFrame(上行,带 userId) / OutputAudioFrame / TTSAudioFrame(带 contextId 关联回合)
// numFrames = len(audio)/(numChannels*2) 收端重算,不上线
```
### providers STT config 判别联合
```
SttConfig =
 | { kind:"faster-whisper", model, device, computeType, language?, beamSize=5, vadFilter=false }
 | { kind:"sherpa-onnx", modelType, modelDir, provider="cpu", numThreads, decoding="greedy_search" }
 | { kind:"whisper-cpp", model, language }
 | { kind:"openai-compat", baseUrl, apiKey, model, language?, responseFormat="json", temperature=0, stream?, timestampGranularities? }
能力: { sampleRate:16000, channels:1, encoding:"s16le", streaming, languages[], requiresCuda }
// sherpa-onnx/whisper-cpp requiresCuda=false(端侧);faster-whisper cuda 档 true
```
### providers TTS config 判别联合
```
TtsConfig =
 | { kind:"kokoro", voice, speed=1.0, lang="en-us", sampleRate=24000 }        // onnx 纯CPU,固定音色
 | { kind:"edge-tts", voice, rate="+0%", volume="+0%", pitch="+0Hz" }          // MP3 需解码
 | { kind:"openai-compat", baseUrl, model, voice, responseFormat="pcm", speed=1.0, stream? }
 | { kind:"piper", voiceModel, lengthScale=1.0, noiseScale=0.667, speakerId=0 }
 | { kind:"gpt-sovits", apiUrl, textLang, refAudio, refText, refLang, textSplit="cut5", streamingMode }  // 见 §5
能力: { outputSampleRate, channels:1, encoding, streaming, voiceCloning, languages[], requiresCuda }
```

## 5. 音色复刻(Voice Cloning)调查
| 引擎 | 参考音频 | 关键复刻参数 | 流式 | 端侧 | License(商用) |
|---|---|---|---|---|---|
| **GPT-SoVITS**(reference 在用) | zero-shot ~5s | `ref_audio_path`/`prompt_text`/`prompt_lang`/`text_lang`/`text_split=cut5`/`streaming_mode`(`gpt_sovits_tts.py:14-23`) | 是 | ❌需GPU | MIT [推断,**落地前核实**] |
| **CosyVoice2-0.5B** | zero-shot 几秒,跨语种 | reference audio +(可选)prompt text | **是**(chunk-aware,主打低延迟) | ❌~4GB VRAM | Apache 2.0 [推断] |
| **Fish-Speech/S1** | zero-shot ~10-15s | reference audio + ref text | 是 | ❌GPU | **Apache 2.0(商用友好)** |
| **OpenVoice V2** | 短样本 | speaker embedding + base TTS | 否 | ❌GPU | **MIT(商用友好)** |
| **XTTS v2(Coqui)** | zero-shot ~6s,17 语 | `speaker_wav`+`language` | 是 | ❌GPU | ⚠️**CPML 非商用** |
| **F5-TTS** | 短样本 | ref audio + ref text | 部分 | ❌GPU | ⚠️**CC-BY-NC 非商用** |
| **ElevenLabs**(云) | Instant~1min / Pro 数十分钟 | `voice_id` + stability/similarity_boost/style | 是 | 云 | 付费授权 |

- **reference 实际**:Open-LLM-VTuber 用 **GPT-SoVITS**(克隆参数齐全)+ ElevenLabs 云克隆;RealtimeVoiceChat 用 Coqui XTTS(⚠️CPML 非商用);voice-core/projectBEA 只用 Kokoro(非克隆,固定音色)。

### chat-A 音色复刻接缝建议
```
TtsCloneConfig {
  voiceCloning: true
  cloneMode: "zero-shot" | "fine-tune"
  refAudio: path|bytes          // 5-15s,16/24k mono wav
  refText?: string              // GPT-SoVITS/Fish/F5 需要
  refLang?: string              // GPT-SoVITS prompt_lang
  voiceId?: string              // 已克隆音色句柄(ElevenLabs/缓存 speaker embedding)
}
能力加位: voiceCloning / cloneMode / minRefSeconds / needsRefText / requiresCuda
```
**选型**:
- **PC 档(默认克隆)**:**GPT-SoVITS**(reference 已验、zero-shot 5s、流式、中文强)或 **CosyVoice2**(流式低延迟、Apache)。
- ⚠️ **商用避免 XTTS(CPML)/ F5-TTS(CC-BY-NC)**;要绝对安全选 **Fish-Speech(Apache)/ OpenVoice(MIT)**;GPT-SoVITS license 落地前核实。
- **嵌入式**:**克隆不下端(均需 GPU)**——端侧用固定音色 **Kokoro-onnx(Apache,纯 CPU,24k)/ Piper / Sherpa-ONNX**;克隆走云或 PC 大脑侧,端侧只收 24k PCM 流。
- **云兜底**:ElevenLabs(voice_id + stability/similarity_boost)。

## 6. 不确定项(诚实标注)
- Edge-TTS 输出 "24kHz/48kbit mono mp3" 为微软服务惯例 [推断];管线务必先解码再重采样。
- GPT-SoVITS / CosyVoice2 license(MIT/Apache)为 [推断],**商用落地前必须核对各仓库 LICENSE**。
- OpenVoice/F5 流式程度 [推断],未在本地代码验证。

### 主要证据文件
Pipecat `…/voice-infra/pipecat/src/pipecat/frames/frames.py:156-173,922-923`、`frames.proto:23-30`、`audio/resamplers/soxr_stream_resampler.py`;OLV `…/Open-LLM-VTuber/src/open_llm_vtuber/{asr,tts}/*.py`;voice-core `…/voice-core/voice-core-main/{ears/stt.py,voice/tts.py}`;RealtimeVoiceChat `…/RealtimeVoiceChat/code/{transcribe.py,audio_module.py}`;projectBEA `…/projectBEA/src/modules/tts/kokoro_tts_wrapper.py`。
官方:OpenAI STT/TTS 文档、rany2/edge-tts、SYSTRAN/faster-whisper、FunAudioLLM/CosyVoice2-0.5B、fish.audio、Kokoro。
