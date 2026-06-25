/**
 * Electron 主进程(承 desktop-electron-frontend §2/§4/§3.2):**in-process 复用** `@chat-a/client`
 * 的 `assembleApp()` 装大脑(Conversation + 记忆 + 人格 + provider),经类型化 IPC 暴露给渲染层。
 *
 * 不起独立大脑/WS 网关(等价单机 CLI 形态);文字路真可用(接 qwen),语音路结构就位 +
 * naudiodon 优雅降级(探测不可用 → 通知渲染层禁用语音按钮,文字路不受影响、主进程绝不崩)。
 *
 * 本文件是**薄壳**:会决定 UI 行为的逻辑(状态派生 / 回合编排 / 探测降级)都在 ipc-contract.ts
 * 的纯模块里(可 headless 单测);main 只负责接 electron 生命周期 + 装配 + 订阅总线推 IPC。
 */
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { app, BrowserWindow, ipcMain } from 'electron';
import {
  assembleApp,
  startVoiceMode,
  NodeAudioDevice,
  type AppHandle,
  type VoiceModeHandle,
  // —— 代理B:主动陪伴桥(autonomy 主动消息通道) ——
  assembleProactiveBridge,
  createCompanionCandidateSource,
  createPresencePort,
  type ProactiveBridgeHandle,
} from '@chat-a/client';
import {
  createVoice,
  createCosyVoice,
  loadVoiceProfile,
  QWEN_VOICE_CLONE_DEFAULT_TARGET_MODEL,
  COSYVOICE_DEFAULT_TARGET_MODEL,
  supportsStreamingFeed,
  type TtsOptions,
  type TtsProvider,
} from '@chat-a/providers';
import { SentenceSplitter } from '@chat-a/runtime';
import {
  IPC,
  StateTracker,
  toMoodSummary,
  runSendTurn,
  probeVoice,
  runCloneVoice,
  upsertEnvLocal,
  CLONE_NO_KEY_REASON,
  VOICE_UNAVAILABLE_REASON,
  sanitizePersonaForm,
  type AppInfo,
  type VoiceCloneInput,
  type VoiceCloneStatus,
  // —— 代理B:主动消息归一/开关(纯逻辑) ——
  toProactiveMessage,
  isProactiveEnabled,
  type PersonaForm,
  // —— 代理D:记忆面板纯格式化 ——
  toMemoryItems,
  type MemoryItem,
  // —— 三语种 + 朗读(本批次) ——
  runSpeakReply,
  runStreamSpeakReply,
  makeTokenStreamReadout,
  resolveSpokenPlan,
  translateForSpeech,
  isSpeakAvailable,
  normalizeLangCode,
  normalizeTtsLang,
  type LangForm,
  type TtsAudioChunk,
  type SpeakStreamSession,
  type SentenceFeed,
  type TokenStreamReadout,
} from './ipc-contract';

let mainWindow: BrowserWindow | null = null;
let appHandle: AppHandle | null = null;
let voiceHandle: VoiceModeHandle | undefined;
// —— 代理B:主动陪伴桥句柄(autonomy on 时装配;off 恒 undefined) ——
let proactiveHandle: ProactiveBridgeHandle | undefined;

/** 向渲染层推一条 IPC(窗口已关则静默丢弃)。 */
function emit(channel: string, payload?: unknown): void {
  mainWindow?.webContents.send(channel, payload);
}

// —— 朗读(本批次):同一时刻只朗读一条 + 可干净打断;abort 时发 ttsAudioStop 清渲染层队列。
// 在 bootstrap 里初始化(class 声明在下方,避免 TDZ);未初始化前的调用走空安全。
let speakCtl: SpeakController | undefined;

/** 组装 AppInfo(横幅用):从 llmConfig / memoryInfo / seed 取。 */
function buildAppInfo(handle: AppHandle): AppInfo {
  return {
    name: handle.seed.name,
    provider: handle.llmConfig.provider,
    model: handle.llmConfig.model,
    memory: `${handle.memoryInfo.backend}${handle.memoryInfo.dbPath ? ` (${handle.memoryInfo.dbPath})` : ''}`,
    isFake: handle.llmConfig.provider === 'fake',
    warmth: handle.seed.dials.baselineWarmth,
    expressiveness: handle.seed.dials.expressiveness,
    volatility: handle.seed.dials.emotionalVolatility,
    // 语音输出语种(设置面板可写项;''=自动)。与显示文字语种解耦、与 voiceId/输入语种正交。
    outputLang: normalizeLangCode(handle.env['CHAT_A_VOICE_OUTPUT_LANG']),
  };
}

/** 取 DashScope key(复刻复用 CHAT_A_DASHSCOPE_API_KEY,回落 CHAT_A_TTS_API_KEY)。 */
function dashKey(handle: AppHandle): string {
  return (
    handle.env['CHAT_A_DASHSCOPE_API_KEY'] ?? handle.env['CHAT_A_TTS_API_KEY'] ?? ''
  ).trim();
}

/** 复刻区可用性:有 key 才可用,否则禁用 + 中文提示。 */
function cloneStatus(handle: AppHandle): VoiceCloneStatus {
  return dashKey(handle).length > 0
    ? { available: true }
    : { available: false, reason: CLONE_NO_KEY_REASON };
}

/**
 * 经 DashScope 千问声音复刻创建专属音色(主进程注入给 runCloneVoice 的 clone 端口)。
 * 优先用渲染层给的文件路径(读盘 + 按扩展名推 MIME 由 providers 处理);兜底用字节 + mime。
 * targetModel 取 CHAT_A_TTS_MODEL(若是 vc 模型)否则默认 vc-realtime。
 *
 * **一致性纪律(已据官方核实 2026-06-24)**:复刻 target_model 必须与后续合成时的 model
 * **逐字一致**(含日期快照),否则合成失败——音色绑单模型。故此处直接取合成配置 CHAT_A_TTS_MODEL
 * (当它是 vc 模型时)作 targetModel,确保复刻得到的 voiceId 能被同一 model 合成。
 */
/** 复刻引擎选择:CHAT_A_VOICE_CLONE_KIND=cosyvoice → CosyVoice;缺省/其它 = qwen(保持现状)。 */
function cloneEngine(handle: AppHandle): 'qwen' | 'cosyvoice' {
  const raw = (handle.env['CHAT_A_VOICE_CLONE_KIND'] ?? '').trim().toLowerCase();
  return raw === 'cosyvoice' ? 'cosyvoice' : 'qwen';
}

/**
 * 算本次复刻实际使用的 target_model(单一真相源:复刻创建与持久化 CHAT_A_TTS_MODEL 共用,
 * 杜绝两者算出不同值导致"复刻用 A、合成用 B"的硬约束违背)。**按引擎分支**:
 * - cosyvoice:CHAT_A_TTS_MODEL 含 'cosyvoice' 则用它,否则回落 cosyvoice-v3.5-flash(无日期快照);
 * - qwen:CHAT_A_TTS_MODEL 是 vc 模型则用它,否则回落带快照的 vc-realtime。
 * (⚠️ 修旧 bug:此前一律 `includes('vc')`,对 'cosyvoice-v3.5-flash' 为 false → 错路由成 qwen 快照。)
 */
function resolveCloneTargetModel(handle: AppHandle): string {
  const configModel = (handle.env['CHAT_A_TTS_MODEL'] ?? '').trim();
  if (cloneEngine(handle) === 'cosyvoice') {
    return configModel.includes('cosyvoice') ? configModel : COSYVOICE_DEFAULT_TARGET_MODEL;
  }
  return configModel.includes('vc') ? configModel : QWEN_VOICE_CLONE_DEFAULT_TARGET_MODEL;
}

async function cloneVoiceViaDashScope(
  handle: AppHandle,
  input: VoiceCloneInput,
  onProgress?: (message: string) => void,
): Promise<string> {
  const apiKey = dashKey(handle);
  if (apiKey.length === 0) throw new Error(CLONE_NO_KEY_REASON);
  // 取合成 model 作 target_model 以保证两者同串(按引擎分支;与持久化共用同一算法)。
  const targetModel = resolveCloneTargetModel(handle);

  if (cloneEngine(handle) === 'cosyvoice') {
    // CosyVoice 契约:音频只收公网/oss:// URL —— 本地文件经 DashScope 临时上传转 oss://(createCosyVoice 内置)。
    // 复刻参考语种 CHAT_A_VOICE_CLONE_REF_LANG 作 language_hints(帮助提取音色特征)。
    const refLang = (handle.env['CHAT_A_VOICE_CLONE_REF_LANG'] ?? '').trim();
    const audio =
      input.path !== undefined && input.path.length > 0
        ? { path: input.path }
        : input.bytes !== undefined
          ? { data: input.bytes, filename: 'voice-sample.wav' }
          : undefined;
    if (audio === undefined) throw new Error('未选择音频文件;请先选择一段约 15~20 秒的清晰录音。');
    onProgress?.('正在上传参考音频并创建音色…');
    const { voiceId } = await createCosyVoice(audio, {
      apiKey,
      targetModel,
      ...(refLang.length > 0 ? { languageHints: [refLang] } : {}),
      onDeployPoll: (attempt, max) =>
        onProgress?.(`音色部署中(可能需要几分钟)… ${attempt}/${max}`),
    });
    return voiceId;
  }

  // qwen 云复刻(enrollment):base64 内联本地文件,同步直返。
  // 复刻参考语种在 qwen enrollment 里语种中性——createVoice 不接受 prompt_lang,服务端自动处理。
  const audio =
    input.path !== undefined && input.path.length > 0
      ? { path: input.path }
      : input.bytes !== undefined
        ? { data: input.bytes, mime: input.mime ?? 'application/octet-stream' }
        : undefined;
  if (audio === undefined) throw new Error('未选择音频文件;请先选择一段约 15 秒的清晰录音。');
  onProgress?.('正在创建音色…');
  const { voiceId } = await createVoice(audio, { apiKey, targetModel });
  return voiceId;
}

/**
 * 持久化复刻结果到项目根 .env.local(保留其它行)+ 即时设入当前进程 env(无需重启即可被后续装配读到)。
 * 写盘失败抛错由 runCloneVoice 降级提示。除 CHAT_A_VOICE_ID 外,**还把本次复刻实际用的 target_model
 * 写进 CHAT_A_TTS_MODEL,并开启 CHAT_A_TTS_VOICE_CLONING=1 + 钉死 CHAT_A_TTS_KIND=qwen-tts**——
 * 关键硬约束:复刻 target_model 必须与合成 model 逐字一致(含日期快照)。此前复刻后用户得手动把
 * CHAT_A_TTS_MODEL 配成对应快照、极易出错;现自动同步,复刻成功即可直接朗读出复刻音色,零手配。
 */
function persistVoiceId(handle: AppHandle, voiceId: string): void {
  // 本次复刻真正使用的 target_model(与 cloneVoiceViaDashScope 共用同一算法,确保逐字一致)。
  const targetModel = resolveCloneTargetModel(handle);
  const engine = cloneEngine(handle);
  // 合成引擎档:cosyvoice → 'cosyvoice'(run-task);qwen → 'qwen-tts'。**修旧 bug:此前一律写 qwen-tts**。
  const ttsKind = engine === 'cosyvoice' ? 'cosyvoice' : 'qwen-tts';
  // 本进程即时生效(下次语音模式装配/朗读 loadVoiceProfile + ttsConfig 直接读到,无需重启)。
  handle.env['CHAT_A_VOICE_ID'] = voiceId;
  handle.env['CHAT_A_TTS_MODEL'] = targetModel;
  handle.env['CHAT_A_TTS_KIND'] = ttsKind;
  const path = join(process.cwd(), '.env.local');
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // 文件不存在 → 从空文本新建。
  }
  // 逐键 upsert(同键覆盖、不重复追加;幂等)。
  text = upsertEnvLocal(text, 'CHAT_A_VOICE_ID', voiceId);
  text = upsertEnvLocal(text, 'CHAT_A_TTS_MODEL', targetModel);
  text = upsertEnvLocal(text, 'CHAT_A_TTS_KIND', ttsKind);
  if (engine === 'cosyvoice') {
    // CosyVoice 合成无需 qwen 专用复刻位(voiceCloning 是 qwen-tts vc 模型的能力开关);本进程清掉,避免误带。
    handle.env['CHAT_A_TTS_VOICE_CLONING'] = '';
  } else {
    // qwen vc 合成需开复刻位(TtsOptions.voiceId 当 WS voice 透传)。
    handle.env['CHAT_A_TTS_VOICE_CLONING'] = '1';
    text = upsertEnvLocal(text, 'CHAT_A_TTS_VOICE_CLONING', '1');
  }
  writeFileSync(path, text, 'utf8');
}

/**
 * 由 env(主要是复刻写入的 `CHAT_A_VOICE_ID`,及 voice-profile 其它键)拼语音合成 opts(§4.1)。
 * **音色复刻闭环关键**:一键复刻把 voiceId 持久化进 `handle.env['CHAT_A_VOICE_ID']`(本进程即时生效),
 * 这里 `loadVoiceProfile(env)` 读出它拼成 `ttsOptions.voiceId` 注入 `startVoiceMode` → VoiceLoop `#speak`
 * → `tts.synthesize(sentence, ttsOptions)` → qwen-tts vc 模型据此 voice 合成,小雪即用复刻音色说话。
 * 各键缺席 → 返回 undefined(不透传,逐字现状,用 provider 默认音色)。
 */
function buildVoiceTtsOptions(env: NodeJS.ProcessEnv): TtsOptions | undefined {
  const p = loadVoiceProfile(env);
  if (p.outputLang === undefined && p.voiceId === undefined && p.cloneRef === undefined) {
    return undefined;
  }
  return {
    ...(p.outputLang !== undefined ? { language: p.outputLang } : {}),
    ...(p.voiceId !== undefined ? { voiceId: p.voiceId } : {}),
    ...(p.cloneRef !== undefined
      ? {
          refAudio: {
            source: p.cloneRef.source,
            ...(p.cloneRef.refText !== undefined ? { refText: p.cloneRef.refText } : {}),
            ...(p.cloneRef.refLang !== undefined ? { refLang: p.cloneRef.refLang } : {}),
          },
        }
      : {}),
  };
}

/**
 * 持久化人格修改(代理C):把名字 + 三档情绪旋钮写项目根 .env.local 的覆盖键
 * (CHAT_A_PERSONA_NAME / CHAT_A_DIAL_WARMTH / _EXPRESSIVENESS / _VOLATILITY,保留其它行),
 * 与 config-loader 的 env 覆盖层语义对齐——下次启动 loadPersonaFromEnv 即自动续接本次自定义。
 * (运行时已由 handle.applyPersona 重装配即时生效;此处只为跨重启留存。)写盘失败抛错由上层降级。
 */
function persistPersona(form: PersonaForm): void {
  const path = join(process.cwd(), '.env.local');
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // 文件不存在 → 从空文本新建。
  }
  text = upsertEnvLocal(text, 'CHAT_A_PERSONA_NAME', form.name);
  text = upsertEnvLocal(text, 'CHAT_A_DIAL_WARMTH', String(form.warmth));
  text = upsertEnvLocal(text, 'CHAT_A_DIAL_EXPRESSIVENESS', String(form.expressiveness));
  text = upsertEnvLocal(text, 'CHAT_A_DIAL_VOLATILITY', String(form.volatility));
  writeFileSync(path, text, 'utf8');
}

// ═══════════════════════════════ 三语种控制 + 朗读(本批次) ═══════════════════════════════
//
// 显示/合成/复刻三独立语种 + 朗读(文字回复 → 渲染层 Web Audio)。语种解析(follow/翻译/默认)
// 在 ipc-contract 纯函数里钉死;main 只做编排:回合后据语种解耦合成 PCM 块,经 IPC.ttsAudio 推渲染层;
// 用户发新消息 / 点停 / 新回合 → abort 在途合成 + 发 IPC.ttsAudioStop(渲染层立即停播清队列)。

/** 朗读是否开启(env CHAT_A_DESKTOP_SPEAK=on/off);**默认值随 TTS 可用性**:可用→开,不可用→关。 */
function isSpeakOn(handle: AppHandle): boolean {
  const raw = (handle.env['CHAT_A_DESKTOP_SPEAK'] ?? '').trim().toLowerCase();
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  // 未配置 → 随可用性(默认:TTS 可用即开)。
  return isSpeakAvailable(handle.ttsConfig.kind);
}

/** 朗读是否可用(TTS provider 非 fake)。 */
function speakAvailable(handle: AppHandle): boolean {
  return isSpeakAvailable(handle.ttsConfig.kind);
}

/**
 * "随心情说话"开关(env CHAT_A_TTS_EMOTION_FROM_MOOD=on/1/true/yes;默认 off)。
 * 启用 → 朗读按当前 PAD 心情注入情绪指令(仅 cosyvoice 引擎实际消费;qwen 忽略)。默认关 = 逐字回归。
 */
function isEmotionFromMood(handle: AppHandle): boolean {
  const raw = (handle.env['CHAT_A_TTS_EMOTION_FROM_MOOD'] ?? '').trim().toLowerCase();
  return raw === 'on' || raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * 「同会话流式朗读」开关(env CHAT_A_TTS_STREAM_READOUT=on/1/true/yes;默认 off)(承 §3.2)。
 * 启用 + TTS 引擎支持同会话流式喂(cosyvoice)→ 句切逐句喂同一会话、首句即出声、复刻音色不漂移;
 * 关 / 引擎不支持 → 回落整段一次合成(逐字回归)。流式合成抛错也降级整段(speakReply 内 catch)。
 */
function isStreamReadoutOn(handle: AppHandle): boolean {
  const raw = (handle.env['CHAT_A_TTS_STREAM_READOUT'] ?? '').trim().toLowerCase();
  return raw === 'on' || raw === '1' || raw === 'true' || raw === 'yes';
}

/** 当前三语种 + 朗读开关 + 可用性(供 lang:get 返回与初值回填)。 */
function buildLangForm(handle: AppHandle): LangForm {
  const env = handle.env;
  return {
    displayLang: normalizeLangCode(env['CHAT_A_DISPLAY_LANG']),
    ttsLang: normalizeTtsLang(env['CHAT_A_TTS_LANG']),
    cloneRefLang: normalizeLangCode(env['CHAT_A_VOICE_CLONE_REF_LANG']),
    speak: isSpeakOn(handle),
    speakAvailable: speakAvailable(handle),
  };
}

/**
 * 持久化三语种 + 朗读开关到项目根 .env.local(保留其它行;仿 persistPersona):
 *   CHAT_A_DISPLAY_LANG / CHAT_A_TTS_LANG / CHAT_A_VOICE_CLONE_REF_LANG / CHAT_A_DESKTOP_SPEAK
 * 运行时已由 handle.applyLang 即时生效;此处只为跨重启留存。写盘失败抛错由上层吞掉(§3.2)。
 *
 * 注:语音模式输出语种 CHAT_A_VOICE_OUTPUT_LANG **不再**由本面板写(此前被强绑 = displayLang)。
 * 输出语种已是设置面板的独立可写项(与显示文字语种、输入 STT 语种、voiceId 正交,见 persistOutputLang),
 * 语言面板改显示语种不再覆盖它,避免两面板互相打架。
 */
function persistLang(form: LangForm): void {
  const path = join(process.cwd(), '.env.local');
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // 文件不存在 → 从空文本新建。
  }
  text = upsertEnvLocal(text, 'CHAT_A_DISPLAY_LANG', form.displayLang);
  text = upsertEnvLocal(text, 'CHAT_A_TTS_LANG', form.ttsLang);
  text = upsertEnvLocal(text, 'CHAT_A_VOICE_CLONE_REF_LANG', form.cloneRefLang);
  text = upsertEnvLocal(text, 'CHAT_A_DESKTOP_SPEAK', form.speak ? 'on' : 'off');
  writeFileSync(path, text, 'utf8');
}

/**
 * 持久化语音输出语种(设置面板可写项)到项目根 .env.local 的 CHAT_A_VOICE_OUTPUT_LANG(保留其它行)
 * + 即时设入进程 env(语音模式装配 loadVoiceProfile 读出 → TTS opts.language;无需重启)。
 * 入参已经 normalizeLangCode 规整(''=自动 → 写空值,voice-profile 视作不强制)。写盘失败抛错由上层吞掉。
 */
function persistOutputLang(handle: AppHandle, lang: string): void {
  handle.env['CHAT_A_VOICE_OUTPUT_LANG'] = lang; // 本进程即时生效。
  const path = join(process.cwd(), '.env.local');
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // 文件不存在 → 从空文本新建。
  }
  writeFileSync(path, upsertEnvLocal(text, 'CHAT_A_VOICE_OUTPUT_LANG', lang), 'utf8');
}

/**
 * 朗读控制器:管在途合成的 AbortController,保证「同一时刻只朗读一条」+ 可干净打断。
 * - `begin()`:abort 旧的、发 ttsAudioStop 清渲染层队列、起新 controller 并返回其 signal;
 * - `stop()`:abort 当前 + 发 ttsAudioStop(用户点停 / 退出)。
 */
class SpeakController {
  #ac: AbortController | undefined;
  constructor(private readonly emitStop: () => void) {}
  begin(): AbortSignal {
    this.stop(); // 打断上一条在途朗读(新消息抢占)。
    this.#ac = new AbortController();
    return this.#ac.signal;
  }
  stop(): void {
    if (this.#ac !== undefined) {
      try {
        this.#ac.abort();
      } catch {
        /* 幂等 */
      }
      this.#ac = undefined;
      this.emitStop();
    }
  }
}

/**
 * 把 TTS provider 适配成 runSpeakReply 需要的 synthesize 端口(PcmChunk → TtsAudioChunk):
 * 逐句合成,language 空则省略(自动);voiceId 取 voice-profile(复刻闭环复用)。
 */
function makeSynthesize(
  tts: TtsProvider,
  env: NodeJS.ProcessEnv,
  instruction?: string,
): (sentence: string, ttsLang: string, signal: AbortSignal) => AsyncIterable<TtsAudioChunk> {
  const profile = loadVoiceProfile(env);
  return async function* synth(sentence, ttsLang, signal) {
    const opts: TtsOptions = {
      ...(ttsLang.length > 0 ? { language: ttsLang } : {}),
      ...(profile.voiceId !== undefined ? { voiceId: profile.voiceId } : {}),
      // 随心情说话:speakReply 据当前 PAD 心情算出的 per-call 情绪指令(开关启用时才有值);
      // 条件展开 → 关闭/无心情时键不出现(exactOptional,逐字回归)。仅 cosyvoice 消费,qwen 忽略。
      ...(instruction !== undefined && instruction.length > 0 ? { instruction } : {}),
    };
    try {
      for await (const chunk of tts.synthesize(sentence, opts, signal)) {
        yield { pcm: chunk.samples, sampleRate: chunk.sampleRate };
      }
    } catch (e) {
      // 单句合成失败:记一条(便于排查 TTS 模型/音色配置问题),向上抛由 runSpeakReply 跳过该句(§3.2)。
      if (!signal.aborted) console.warn('[speak] TTS 合成失败(跳过本句):', e instanceof Error ? e.message : e);
      throw e;
    }
  };
}

/**
 * 把支持流式喂的 TTS provider 适配成 ipc-contract 的 {@link SpeakStreamSession}(承 §3.2):
 * 开一条同会话 synthesizeStream(语种/voiceId/心情指令经 opts 透传)→ push/finish/abort 直通,
 * chunks 把 PcmChunk → TtsAudioChunk。仅 supportsStreamingFeed 的引擎(cosyvoice)可调。
 */
function makeStreamSession(
  tts: TtsProvider,
  env: NodeJS.ProcessEnv,
  instruction: string | undefined,
): (ttsLang: string) => SpeakStreamSession {
  const profile = loadVoiceProfile(env);
  return (ttsLang: string): SpeakStreamSession => {
    if (!supportsStreamingFeed(tts)) {
      // 调用方应先判 supportsStreamingFeed;兜底:不支持即抛,由上层 catch 降级整段。
      throw new Error('TTS 引擎不支持同会话流式喂(回落整段)');
    }
    const opts: TtsOptions = {
      ...(ttsLang.length > 0 ? { language: ttsLang } : {}),
      ...(profile.voiceId !== undefined ? { voiceId: profile.voiceId } : {}),
      ...(instruction !== undefined && instruction.length > 0 ? { instruction } : {}),
    };
    const session = tts.synthesizeStream(opts);
    return {
      push: (text) => session.push(text),
      finish: () => session.finish(),
      abort: () => session.abort(),
      chunks: {
        async *[Symbol.asyncIterator]() {
          for await (const chunk of session.chunks) {
            yield { pcm: chunk.samples, sampleRate: chunk.sampleRate };
          }
        },
      },
    };
  };
}

/**
 * 朗读分句:整段回复**一次合成**(不再逐句切)。
 * 逐句=每句一个独立 WS 合成调用,复刻音色逐句音色漂移→听感「多个音色混杂」;qwen-tts-realtime 本就
 * 流式(整段也边合边出音),整段一次合成既消除漂移/重叠,音色又一致。回复短(陪伴对话),一次合成首音延迟可接受。
 */
function splitReplySentences(text: string): readonly string[] {
  const t = text.trim();
  return t.length > 0 ? [t] : [];
}

/**
 * 算「随心情说话」的 per-call 情绪指令(§6 PAD → §4.1 TTS 情感):
 * 开关启用时读当前 PAD 心情的 voiceInstruction;关 / 读失败 → undefined(无指令、逐字回归,§3.2)。
 * 仅 cosyvoice 引擎实际消费。
 */
function computeMoodInstruction(handle: AppHandle): string | undefined {
  if (!isEmotionFromMood(handle)) return undefined;
  try {
    // 先同步到本回合已保存的活 PAD(显示引擎只读、不 advance,不 reload 会读到开机 stale 值)。
    handle.persona.reload();
    const vi = handle.persona.tone().voiceInstruction;
    return vi.length > 0 ? vi : undefined;
  } catch {
    return undefined; // 读心情失败 → 无指令(不崩)。
  }
}

/** 翻译通道:用文字链路同一 handle.llm 发一条 system + user(显示 reply)→ 译文喂 TTS。 */
function makeTranslate(
  handle: AppHandle,
  signal: AbortSignal,
): (displayText: string, targetLang: string) => Promise<string> {
  return (displayText, targetLang) =>
    translateForSpeech(
      { complete: (system, user) => completeOnce(handle, system, user, signal) },
      displayText,
      targetLang,
    );
}

/**
 * 朗读一条**整段回复**(§4.1,本批次):若朗读开启且 TTS 可用,据语种解耦算 spokenText(必要时翻译)
 * → 分句 → 逐句合成 → 每块经 IPC.ttsAudio 推渲染层。signal 由 SpeakController 给:被打断即停。
 *
 * **流式门控(§3.2)**:CHAT_A_TTS_STREAM_READOUT 开 + 引擎支持同会话流式喂(cosyvoice)→ 走
 * {@link runStreamSpeakReply}(整段后句切、同会话逐句喂、首句即出声、音色不漂移);
 * 流式抛错 / 引擎不支持 / 门控关 → 回落整段一次合成(§3.2 优雅降级)。
 *
 * ⚠️ R7 首音:此函数在整段 reply 后跑,**第一步**(整段后句切流式喂)首音 ≈ 整段生成时间——R7 未真解;
 * 真正解 R7 的「边生成边喂」走 {@link speakReplyFromTokens}(同语种挂 onToken)。
 * 任何错误吞掉(有声尽力、绝不崩,§3.2)。
 */
async function speakReply(handle: AppHandle, reply: string, signal: AbortSignal): Promise<void> {
  if (reply.trim().length === 0) return;
  if (!isSpeakOn(handle) || !speakAvailable(handle)) return;
  const env = handle.env;
  const displayLang = normalizeLangCode(env['CHAT_A_DISPLAY_LANG']);
  const ttsLang = (env['CHAT_A_TTS_LANG'] ?? '').trim();
  const moodInstruction = computeMoodInstruction(handle);

  // 流式路:门控开 + 引擎支持同会话流式喂 → 试同会话逐句喂;失败降级整段(下面 fallback)。
  if (isStreamReadoutOn(handle) && supportsStreamingFeed(handle.tts)) {
    try {
      await runStreamSpeakReply(
        {
          newSplitter: () => makeSentenceFeed(),
          openSession: makeStreamSession(handle.tts, env, moodInstruction),
          translate: makeTranslate(handle, signal),
          emitAudio: (chunk) => emit(IPC.ttsAudio, chunk),
        },
        reply,
        displayLang,
        ttsLang,
        signal,
      );
      return; // 流式成功:不再走整段路。
    } catch (err) {
      if (signal.aborted) return; // 被打断 → 不降级、不再合成。
      console.warn('[speak] 流式朗读失败,降级整段一次合成:', err instanceof Error ? err.message : err);
      // 落到下面整段路(§3.2 优雅降级)。
    }
  }

  // 整段一次合成路(门控关 / 引擎不支持 / 流式降级)。
  try {
    await runSpeakReply(
      {
        splitSentences: splitReplySentences,
        synthesize: makeSynthesize(handle.tts, env, moodInstruction),
        translate: makeTranslate(handle, signal),
        emitAudio: (chunk) => emit(IPC.ttsAudio, chunk),
      },
      reply,
      displayLang,
      ttsLang,
      signal,
    );
  } catch (err) {
    console.warn('[speak] 朗读链路失败(不影响文字回复):', err instanceof Error ? err.message : err);
    // 朗读链路任何失败不影响文字气泡(已定型),只吞掉(§3.2)。
  }
}

/** 新建一个 runtime SentenceSplitter,适配成 ipc-contract 的 {@link SentenceFeed}(push 返新整句 / flush 残余)。 */
function makeSentenceFeed(): SentenceFeed {
  const splitter = new SentenceSplitter();
  return {
    push: (text) => splitter.push(text),
    flush: () => splitter.flush(),
  };
}

/**
 * **第二步(真解 R7,§3.2)**:同语种(无翻译)边生成边喂——把回合 onToken 接进 SentenceSplitter,
 * 出一句即喂同一条流式会话,首句到齐即出声,远早于整段。
 *
 * 仅在:朗读开 + TTS 可用 + 门控开 + 引擎支持流式 + **plan 不需翻译(同语种/自动)** 时启用;
 * 否则返回 undefined(调用方回落整段后 speakReply:翻译需整段、整段合成等)。
 * 返回 {@link TokenStreamReadout}:把它的 onToken tee 进 convo.send、回合后 done() 收尾。
 * 失败(consumed reject)由调用方降级整段。
 */
function speakReplyFromTokens(
  handle: AppHandle,
  signal: AbortSignal,
): TokenStreamReadout | undefined {
  if (!isSpeakOn(handle) || !speakAvailable(handle)) return undefined;
  if (!isStreamReadoutOn(handle) || !supportsStreamingFeed(handle.tts)) return undefined;
  const env = handle.env;
  const displayLang = normalizeLangCode(env['CHAT_A_DISPLAY_LANG']);
  const ttsLang = (env['CHAT_A_TTS_LANG'] ?? '').trim();
  const plan = resolveSpokenPlan(displayLang, ttsLang);
  // 异语种需整段翻译 → 不走边生成边喂(回落整段后 speakReply 流式/整段)。
  if (plan.needsTranslation) return undefined;
  const moodInstruction = computeMoodInstruction(handle);
  try {
    return makeTokenStreamReadout(
      {
        newSplitter: () => makeSentenceFeed(),
        openSession: makeStreamSession(handle.tts, env, moodInstruction),
        emitAudio: (chunk) => emit(IPC.ttsAudio, chunk),
      },
      plan.ttsLang,
      signal,
    );
  } catch {
    return undefined; // 开会话失败(如不支持)→ 回落整段路。
  }
}

/**
 * 用 handle.llm 做一次性补全(翻译通道用):流式累积成完整文本。signal 透传以便被打断真停。
 * 失败/被打断由 translateForSpeech 兜底降级为原文。
 */
async function completeOnce(
  handle: AppHandle,
  system: string,
  user: string,
  signal: AbortSignal,
): Promise<string> {
  let acc = '';
  for await (const token of handle.llm.stream(
    { system, messages: [{ role: 'user', content: user }] },
    signal,
  )) {
    acc += token;
  }
  return acc;
}

/** 订阅总线:UI 状态派生 + 回合后心情 + 语音转写,推给渲染层。 */
function wireBus(handle: AppHandle): () => void {
  const tracker = new StateTracker();
  const offTracker = tracker.start(handle.bus);
  const offChange = tracker.onChange((s) => emit(IPC.state, s));
  // 回合结束后读当前心情推给渲染层(低频,回合级)。
  const offTurnEnd = handle.bus.on('turn:end', () => {
    try {
      // 先把只读显示引擎同步到本回合 Conversation 内部引擎已保存的活 PAD(否则恒显开机心情);
      // reload 是一次 store 读、失败不致命(下面 catch 兜),§6 活 mood。
      handle.persona.reload();
      emit(IPC.mood, toMoodSummary(handle.persona.tone()));
    } catch {
      /* 读心情失败不影响主链路(§3.2) */
    }
  });
  // 语音转写(STT final)→ 渲染层可显示用户说的话。
  const offStt = handle.bus.on('stt:final', (e) => emit(IPC.transcript, e.data.text));
  return () => {
    offTracker();
    offChange();
    offTurnEnd();
    offStt();
  };
}

/** 注册渲染→主的 IPC handler。 */
function registerIpc(handle: AppHandle): void {
  // 文字回合:流式回 token + 最终 reply;出错回友好降级文案(主进程绝不崩,§3.2)。
  // 朗读(本批次):用户发新消息即打断上一条在途朗读(begin 内部 abort 旧的 + 发 ttsAudioStop);
  // 本回合拿到完整 reply 后,若朗读开启且 TTS 可用 → 据语种解耦合成 PCM 推渲染层(speakReply 内部自判)。
  ipcMain.handle(IPC.send, async (_e, text: string) => {
    const signal = speakCtl?.begin() ?? new AbortController().signal; // 新消息抢占在途朗读。
    await runSendTurn(
      {
        send: async (t, onToken) => {
          // 朗读第二步(真解 R7,§3.2):同语种 + 流式门控开 → 把 onToken tee 进句切流式会话,
          // 边生成边喂、首句即出声。否则 readout=undefined,回落整段后 speakReply。
          const readout = speakReplyFromTokens(handle, signal);
          const reply = readout
            ? await handle.convo.send(t, (tok) => {
                onToken(tok); // 仍逐 token 推渲染层(文字气泡)。
                readout.onToken(tok); // 同时喂朗读句切流式会话。
              })
            : await handle.convo.send(t, onToken);
          if (readout) {
            readout.done(); // 回合结束:flush 残余 + finish 流式会话。
            // 流式消费失败(task-failed/WS)→ 降级整段一次合成(§3.2);成功/被打断则不重复发声。
            readout.consumed.catch(() => {
              if (!signal.aborted) void speakReply(handle, reply, signal);
            });
          } else {
            // 回合体内拿到完整 reply:不阻塞 reply emit(先定型气泡再发声),朗读后台跑(整段后流式/整段)。
            void speakReply(handle, reply, signal);
          }
          return reply;
        },
        emit: (ch, p) => emit(ch, p),
      },
      text,
    );
  });

  // 换一段新对话(长期记忆仍保留)。换段也停在途朗读(上一段的声音不该跨段续播)。
  ipcMain.handle(IPC.reset, () => {
    speakCtl?.stop();
    handle.reset();
    // 换段后刷新「心情」栏:reload 活 PAD + emit mood(对齐 turn:end / personaUpdate),
    // 否则心情栏停在旧值直到下一回合。reload 只读、失败 try/catch 不崩(§3.1)。
    try {
      handle.persona.reload();
      emit(IPC.mood, toMoodSummary(handle.persona.tone()));
    } catch {
      /* 读心情失败不影响 reset 主链路(§3.2) */
    }
  });

  // 横幅 + 设置面板信息(含语音输出语种回填值)。
  ipcMain.handle(IPC.getInfo, () => buildAppInfo(handle));

  // 设置面板:写回语音输出语种(CHAT_A_VOICE_OUTPUT_LANG)。规整(''=自动)→ 即时设进程 env + 持久化。
  // 返回规整后的最终值(渲染层据此回填下拉)。持久化失败不影响本次即时生效,仅吞掉(§3.2)。
  ipcMain.handle(IPC.settingsSetOutputLang, (_e, raw: string): string => {
    const lang = normalizeLangCode(raw);
    try {
      persistOutputLang(handle, lang);
    } catch {
      // 写盘失败:进程 env 已即时生效;下次重启可能不续接,但不崩(§3.2)。
      handle.env['CHAT_A_VOICE_OUTPUT_LANG'] = lang;
    }
    return lang;
  });

  // 一键复刻:据引擎(qwen/cosyvoice)读文件/字节 → 创建音色(cosyvoice 含临时上传+异步轮询)→
  // 持久化;轮询期经 IPC.voiceCloneProgress 报进度;全程降级不崩(§3.2)。
  ipcMain.handle(IPC.voiceClone, async (_e, input: VoiceCloneInput) => {
    await runCloneVoice(
      {
        clone: (i) =>
          cloneVoiceViaDashScope(handle, i, (message) =>
            emit(IPC.voiceCloneProgress, { message }),
          ),
        persist: (voiceId) => persistVoiceId(handle, voiceId),
        emit: (ch, p) => emit(ch, p),
      },
      input,
    );
  });

  // 语音开始:先探测 naudiodon 可用性,不可用即优雅降级(不进 startVoiceMode)。
  ipcMain.handle(IPC.voiceStart, async () => {
    try {
      const probe = await probeVoice(() => new NodeAudioDevice());
      if (!probe.available) {
        emit(IPC.voiceStatus, probe);
        return;
      }
      // 可用:用既有 startVoiceMode 跑免提(云端 STT/TTS 或 omni;不引本地模型)。
      const env = handle.env;
      if ((env['CHAT_A_AUDIO_DEVICE'] ?? '').length === 0) env['CHAT_A_AUDIO_DEVICE'] = 'node';
      // 音色复刻闭环:由 env(含复刻写入的 CHAT_A_VOICE_ID)拼 ttsOptions → 注入 → VoiceLoop 合成时用复刻音色。
      const ttsOptions = buildVoiceTtsOptions(env);
      voiceHandle = await startVoiceMode({
        // §7#5「从语音读情绪」:转发全部入参(含 signal 真取消 + prosodyEmotion 语音情绪),
        // 让 STT final 读出的语气情绪经 convo.send → persona.advance 并入 PAD(此前丢 emotion 是缺口)。
        send: (t, onToken, signal, prosodyEmotion) => handle.convo.send(t, onToken, signal, prosodyEmotion),
        composeOmniInstructions: () => handle.composeOmniInstructions(),
        memory: handle.memory,
        bus: handle.bus,
        sessionId: handle.sessionId,
        env,
        // §4.1:复刻得到的 CHAT_A_VOICE_ID(及 voice-profile 其它键)拼成的合成 opts;缺省全空 → undefined(逐字现状)。
        ...(ttsOptions ? { ttsOptions } : {}),
      });
      emit(IPC.voiceStatus, {
        available: true,
        path: voiceHandle.info.path,
        device: voiceHandle.info.device,
      });
    } catch (err) {
      // 任何失败 → 降级通知,文字路不受影响、绝不崩(§3.2)。
      emit(IPC.voiceStatus, {
        available: false,
        reason: `${VOICE_UNAVAILABLE_REASON}(${err instanceof Error ? err.message : String(err)})`,
      });
    }
  });

  // 语音停止(幂等)。同时停在途朗读(语音/朗读两条音频路不该叠播)。
  ipcMain.handle(IPC.voiceStop, () => {
    speakCtl?.stop();
    try {
      voiceHandle?.stop();
    } catch {
      /* 幂等收尾,失败吞 */
    } finally {
      voiceHandle = undefined;
    }
  });

  // —— 人格自定义(代理C) ——
  // 读当前可编辑人格(名字 + 三档),供人格面板初值。
  ipcMain.handle(IPC.personaGet, (): PersonaForm => {
    const v = handle.personaView();
    return { name: v.name, warmth: v.warmth, expressiveness: v.expressiveness, volatility: v.volatility };
  });

  // 应用人格修改:夹取规整 → applyPersona 运行时生效(重装配,保留长期记忆/PAD)→ 可选持久化到 .env.local。
  // 返回规整后的最终人格(渲染层据此回填滑块/名字)。持久化失败不影响运行时生效(已应用),仅吞掉(§3.2)。
  ipcMain.handle(IPC.personaUpdate, (_e, raw: Partial<PersonaForm>): PersonaForm => {
    const current = handle.personaView();
    const form = sanitizePersonaForm(raw, current);
    const applied = handle.applyPersona({
      name: form.name,
      warmth: form.warmth,
      expressiveness: form.expressiveness,
      volatility: form.volatility,
    });
    const result: PersonaForm = {
      name: applied.name,
      warmth: applied.warmth,
      expressiveness: applied.expressiveness,
      volatility: applied.volatility,
    };
    try {
      persistPersona(result);
    } catch {
      // 写盘失败不影响本次运行时生效;下次重启可能不续接,但不崩(§3.2)。
    }
    // 应用后刷新横幅信息(三档/名字已变)与心情(新引擎)。
    emit(IPC.mood, toMoodSummary(handle.persona.tone()));
    return result;
  });

  // —— 记忆查看(代理D)——
  // 只读列出最近 N 条记忆 → 纯格式化为 UI 条目;**绝不触发写/巩固**(listRecent 只读快照)。
  // 读失败优雅降级为空数组(memory.listRecent 内部已吞错;此处再兜底,主进程绝不崩,§3.2)。
  ipcMain.handle(IPC.memoryList, (_e, limit?: number): readonly MemoryItem[] => {
    try {
      return toMemoryItems(handle.memory.listRecent(limit));
    } catch {
      return [];
    }
  });

  // —— 三语种 + 朗读(本批次)——
  // 读当前三语种 + 朗读开关 + 朗读是否可用(语言面板初值)。
  ipcMain.handle(IPC.langGet, (): LangForm => buildLangForm(handle));

  // 应用语种/朗读设置:运行时生效(handle.applyLang:displayLang 重建 convo、其余同步 env)+ 持久化 .env.local。
  // 返回规整后的最终设置(渲染层据此回填下拉/开关)。持久化失败不影响运行时生效,仅吞掉(§3.2)。
  ipcMain.handle(IPC.langSet, (_e, raw: Partial<LangForm>): LangForm => {
    // 规整入参(下拉给的是 ISO 码或 follow/空;经纯函数归一)。
    const next = {
      ...(raw.displayLang !== undefined ? { displayLang: normalizeLangCode(raw.displayLang) } : {}),
      ...(raw.ttsLang !== undefined ? { ttsLang: normalizeTtsLang(raw.ttsLang) } : {}),
      ...(raw.cloneRefLang !== undefined ? { cloneRefLang: normalizeLangCode(raw.cloneRefLang) } : {}),
      ...(raw.speak !== undefined ? { speak: raw.speak } : {}),
    };
    // 切换显示语种/朗读前停在途朗读(语种变了,旧声音不该续播)。
    if (next.displayLang !== undefined || next.speak !== undefined || next.ttsLang !== undefined) {
      speakCtl?.stop();
    }
    handle.applyLang(next);
    const form = buildLangForm(handle);
    try {
      persistLang(form);
    } catch {
      // 写盘失败不影响本次运行时生效;下次重启可能不续接,但不崩(§3.2)。
    }
    return form;
  });
}

// ═══════════════════════════════ 代理B:主动陪伴桥接(autonomy→IPC) ═══════════════════════════════
//
// 北极星「会主动开口」:仅 `CHAT_A_AUTONOMY=on` 时装配主动陪伴桥——idle 触发 → 真候选源(未了话题 +
// idle 想念弧,来自真记忆)→ persona/记忆感知决策(`composeOmniInstructions()` 作决策 system 提示)→
// 仲裁真说 → `emit(IPC.proactiveMessage, ...)` 推渲染层渲染一条自发气泡。**默认关、绝不擅自开口**。
//
// 复用既有 `handle.bus`/`handle.llm`/`handle.memory`/`handle.convo`,不另起大脑;装配失败/降级绝不崩(§3.2)。
// **不涉及 TTS 语种**:主动话只走文字气泡,不经 TTS;后续若发声须沿用既有 TTS `language_type` 输出语种路径。
async function wireProactive(handle: AppHandle): Promise<void> {
  // 启用开关现读(与 client 真装配同一开关 CHAT_A_AUTONOMY=on);off → 不挂任何东西、零开销。
  if (!isProactiveEnabled(handle.env)) return;
  try {
    // 真候选源:未了话题(memory)+ idle 想念弧(装配层在场近似)。用户活跃刷新在场:
    // 文字回合 turn:end / 语音 stt:final 时 markActive,使 idle 弧据真在场计时。
    const presence = createPresencePort();
    const candidateSource = createCompanionCandidateSource({ store: handle.memory, presence });
    const offActive = handle.bus.on('turn:end', () => presence.markActive());
    const offStt = handle.bus.on('stt:final', () => presence.markActive());

    proactiveHandle = await assembleProactiveBridge(handle.env, {
      bus: handle.bus,
      llm: handle.llm,
      // persona/记忆感知决策提示:与文字/omni 链路同源(persona 骨架 + 记忆召回 + 语气),零漂移。
      composeSystemPrompt: () => handle.convo.composeOmniInstructions(),
      candidateSource,
      // 推送通道:仲裁真说 → 归一(裁空白/防空气泡)→ 推渲染层渲染自发气泡。
      onProactiveSpeak: (speech) => {
        const msg = toProactiveMessage(speech);
        if (msg !== null) emit(IPC.proactiveMessage, msg);
      },
    });
    // 桥未起(开关 off 或装配返回 undefined)→ 退订在场刷新,避免悬挂订阅。
    if (proactiveHandle === undefined) {
      offActive();
      offStt();
    }
  } catch (err) {
    // 任何装配失败 → 主动陪伴静默不启用,文字/语音路不受影响、绝不崩(§3.2)。
    console.error('[desktop] 主动陪伴桥装配失败(已降级,不影响其它功能):', err);
    proactiveHandle = undefined;
  }
}

function createWindow(handle: AppHandle): void {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 720,
    title: `和「${handle.seed.name}」聊天`,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 渲染层静态资源在 dist/renderer/index.html(esbuild + 复制产出)。
  void mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'));
  // 页面就绪后推一次复刻区可用性(有 key 才可用),避免渲染层订阅前丢消息。
  mainWindow.webContents.on('did-finish-load', () => {
    emit(IPC.voiceCloneStatus, cloneStatus(handle));
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function bootstrap(): Promise<void> {
  // in-process 装大脑(加载 .env.local + llm + bus + memory + persona + Conversation)。
  appHandle = assembleApp();
  const handle = appHandle;
  // 朗读控制器(class 已声明,此处安全初始化;abort 时发 ttsAudioStop 清渲染层播放队列)。
  speakCtl = new SpeakController(() => emit(IPC.ttsAudioStop));
  registerIpc(handle);
  const offBus = wireBus(handle);

  createWindow(handle);
  // 初始推一次 state + mood(让 UI 一进来就有状态)。
  emit(IPC.state, 'idle');
  try {
    emit(IPC.mood, toMoodSummary(handle.persona.tone()));
  } catch {
    /* ignore */
  }

  // —— 代理B:主动陪伴桥(默认关;CHAT_A_AUTONOMY=on 才挂)。fire-and-forget,失败已内部降级。
  void wireProactive(handle);

  app.on('before-quit', () => {
    offBus();
    try {
      speakCtl?.stop(); // 停在途朗读。
    } catch {
      /* ignore */
    }
    try {
      voiceHandle?.stop();
    } catch {
      /* ignore */
    }
    // —— 代理B:收尾主动陪伴桥(停 idle 定时器 + 退订总线;幂等、失败吞)。
    try {
      proactiveHandle?.stop();
    } catch {
      /* ignore */
    } finally {
      proactiveHandle = undefined;
    }
    void handle.cleanup();
  });
}

// macOS 习惯:窗口全关不退出可重开;此处简化为全平台关窗即可退出。
app.on('window-all-closed', () => {
  app.quit();
});

app.whenReady().then(bootstrap).catch((err) => {
  // 装配失败也不静默崩:打印后退出(GUI 起不来时至少给日志)。
  console.error('[desktop] 启动失败:', err);
  app.quit();
});
