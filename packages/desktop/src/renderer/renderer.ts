/**
 * 渲染层(承 desktop-electron-frontend §6):纯 TS,经 `window.xiaoxue`(preload 安全桥)与主进程通信。
 * 不引重框架;esbuild 打成 `renderer.js`(IIFE)。负责:消息气泡、输入发送、流式 token 追加、
 * 语音开关、状态栏(state + 心情)。
 */
import type {
  XiaoxueApi,
  MoodSummary,
  UiState,
  VoiceStatus,
  VoiceCloneInput,
  VoiceCloneResult,
  VoiceCloneStatus,
  // —— 代理B:主动消息类型 ——
  ProactiveMessage,
  PersonaForm, // 代理C
  MemoryItem, // 代理D
  LangForm, // 三语种 + 朗读
  TtsAudioChunk, // 朗读 PCM 块
} from './api';

declare global {
  interface Window {
    readonly xiaoxue: XiaoxueApi;
  }
}

const xiaoxue = window.xiaoxue;

const $messages = document.getElementById('messages') as HTMLElement;
const $input = document.getElementById('input') as HTMLTextAreaElement;
const $send = document.getElementById('send') as HTMLButtonElement;
const $voice = document.getElementById('voice') as HTMLButtonElement;
const $state = document.getElementById('state') as HTMLElement;
const $mood = document.getElementById('mood') as HTMLElement;
const $name = document.getElementById('name') as HTMLElement;
const $provider = document.getElementById('provider') as HTMLElement;
const $cloneFile = document.getElementById('clone-file') as HTMLInputElement;
const $cloneGo = document.getElementById('clone-go') as HTMLButtonElement;
const $cloneStatus = document.getElementById('clone-status') as HTMLElement;
const $cloneHint = document.getElementById('clone-hint') as HTMLElement;

/** 复刻区是否可用(由 onCloneStatus 决定:无 key → 禁用)。 */
let cloneAvailable = false;
/** 复刻进行中(防重复点击)。 */
let cloning = false;

/** 当前正在接收流式 token 的小雪气泡(null = 没有进行中的回合)。 */
let pendingBubble: HTMLElement | null = null;
let voiceOn = false;

const STATE_TEXT: Record<UiState, string> = {
  idle: '空闲',
  listening: '在听',
  thinking: '在想…',
  speaking: '在说…',
};

const EMOTION_TEXT: Record<string, string> = {
  joyful: '愉悦',
  content: '平和',
  neutral: '平静',
  down: '低落',
  irritated: '烦躁',
};

function addBubble(kind: 'user' | 'xiao' | 'error', text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = `bubble ${kind}`;
  el.textContent = text;
  $messages.appendChild(el);
  $messages.scrollTop = $messages.scrollHeight;
  return el;
}

function scrollToBottom(): void {
  $messages.scrollTop = $messages.scrollHeight;
}

function sendCurrent(): void {
  const text = $input.value.trim();
  if (text.length === 0 || pendingBubble !== null) return;
  $input.value = '';
  autoGrow();
  addBubble('user', text);
  // 占位小雪气泡,流式 token 往里追加。
  pendingBubble = addBubble('xiao', '');
  pendingBubble.classList.add('pending');
  void xiaoxue.send(text);
}

function autoGrow(): void {
  $input.style.height = 'auto';
  $input.style.height = `${Math.min($input.scrollHeight, 120)}px`;
}

// ── 事件绑定 ──
$send.addEventListener('click', sendCurrent);
$input.addEventListener('input', autoGrow);
$input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendCurrent();
  }
});

$voice.addEventListener('click', () => {
  if ($voice.disabled) return;
  if (voiceOn) {
    void xiaoxue.voiceStop();
    voiceOn = false;
    $voice.classList.remove('on');
    $voice.title = '语音对话';
  } else {
    void xiaoxue.voiceStart();
    // 真实可用性由 onVoiceStatus 决定(可能降级);此处先乐观高亮,降级回调会纠正。
  }
});

// ── 订阅主进程推送 ──
xiaoxue.onToken((token) => {
  if (pendingBubble === null) pendingBubble = addBubble('xiao', '');
  pendingBubble.textContent = (pendingBubble.textContent ?? '') + token;
  scrollToBottom();
});

xiaoxue.onReply((reply) => {
  if (pendingBubble !== null) {
    // 以最终回复定型(token 累积一般已等于 reply;此处兜底确保一致)。
    if ((pendingBubble.textContent ?? '').length === 0) pendingBubble.textContent = reply;
    pendingBubble.classList.remove('pending');
    pendingBubble = null;
  }
  scrollToBottom();
});

xiaoxue.onError((err) => {
  if (pendingBubble !== null) {
    pendingBubble.remove();
    pendingBubble = null;
  }
  addBubble('error', err.text);
});

xiaoxue.onState((state: UiState) => {
  $state.textContent = STATE_TEXT[state] ?? state;
  $state.className = `state ${state}`;
});

xiaoxue.onMood((mood: MoodSummary) => {
  const label = EMOTION_TEXT[mood.emotion] ?? mood.emotion;
  $mood.textContent = `心情:${label}`;
});

xiaoxue.onTranscript((text) => {
  // 语音模式下把用户说的话也作为用户气泡显示。
  if (text.trim().length > 0) addBubble('user', text);
});

xiaoxue.onVoiceStatus((status: VoiceStatus) => {
  if (status.available) {
    voiceOn = true;
    $voice.disabled = false;
    $voice.classList.add('on');
    $voice.title = '语音对话进行中(点击停止)';
  } else {
    voiceOn = false;
    $voice.disabled = true;
    $voice.classList.remove('on');
    $voice.title = status.reason ?? '语音不可用';
  }
});

// ── 启动:取横幅信息 ──
void xiaoxue.getInfo().then((info) => {
  $name.textContent = info.name;
  $provider.textContent = info.isFake
    ? '(FakeLLM 占位 · 在 .env.local 填 CHAT_A_DASHSCOPE_API_KEY 启用真模型)'
    : `${info.provider} / ${info.model}`;
  document.title = `和「${info.name}」聊天`;
});

// ── 一键复刻 ──

/** 复刻按钮可用性:可用(有 key)+ 已选文件 + 非进行中 才允许点。 */
function refreshCloneButton(): void {
  const hasFile = ($cloneFile.files?.length ?? 0) > 0;
  $cloneGo.disabled = !cloneAvailable || !hasFile || cloning;
}

$cloneFile.addEventListener('change', refreshCloneButton);

$cloneGo.addEventListener('click', () => {
  if ($cloneGo.disabled) return;
  const file = $cloneFile.files?.[0];
  if (file === undefined) return;
  cloning = true;
  refreshCloneButton();
  $cloneStatus.textContent = '正在复刻…(上传录音、云端创建专属音色,请稍候)';
  void buildCloneInput(file)
    .then((input) => xiaoxue.voiceClone(input))
    .catch((err: unknown) => {
      // 读文件失败等本地错误也走友好降级,不卡死按钮。
      cloning = false;
      refreshCloneButton();
      $cloneStatus.textContent = `复刻没成功——${err instanceof Error ? err.message : String(err)}`;
    });
});

/** 把选中的 File 转成复刻载荷:优先 Electron 注入的 .path,否则回落字节。 */
async function buildCloneInput(file: File): Promise<VoiceCloneInput> {
  const path = (file as File & { path?: string }).path;
  if (typeof path === 'string' && path.length > 0) return { path };
  const buf = await file.arrayBuffer();
  return { bytes: new Uint8Array(buf), mime: file.type || 'application/octet-stream' };
}

xiaoxue.onCloneStatus((status: VoiceCloneStatus) => {
  cloneAvailable = status.available;
  if (!status.available) {
    $cloneHint.textContent = status.reason ?? '声音复刻当前不可用';
  }
  refreshCloneButton();
});

xiaoxue.onCloneResult((result: VoiceCloneResult) => {
  cloning = false;
  refreshCloneButton();
  $cloneStatus.textContent = result.message;
  $cloneStatus.className = `clone-status ${result.ok ? 'ok' : 'err'}`;
});

// ═══════════════════════════════ 代理B:主动消息(自发气泡) ═══════════════════════════════
//
// 小雪主动开口(autonomy 引擎在空闲时经真 persona/记忆生成):渲染成一条带「主动」细标记的小雪气泡。
// 与用户回合的 pendingBubble **互不干扰**——主动气泡是独立追加的定型气泡(不进 pendingBubble),
// 即便此刻正有用户回合在流式接收 token,也各渲染各的。加 `proactive` class 供 CSS 细标记。
xiaoxue.onProactive((msg: ProactiveMessage) => {
  if (msg.text.trim().length === 0) return; // 防空气泡(主进程已归一,这里再兜一层)
  const bubble = addBubble('xiao', msg.text);
  bubble.classList.add('proactive');
  // 抢占场景(打断在说者)给更显眼的标记,便于追溯主动性强弱。
  if (msg.preempted) bubble.classList.add('preempted');
  scrollToBottom();
});
// ── 人格自定义(代理C)──:名字 + 三档滑块,保存即运行时生效(主进程重装配,长期记忆保留)。
const $pName = document.getElementById('persona-name') as HTMLInputElement;
const $pWarmth = document.getElementById('persona-warmth') as HTMLInputElement;
const $pExpr = document.getElementById('persona-expressiveness') as HTMLInputElement;
const $pVol = document.getElementById('persona-volatility') as HTMLInputElement;
const $pWarmthVal = document.getElementById('persona-warmth-val') as HTMLElement;
const $pExprVal = document.getElementById('persona-expressiveness-val') as HTMLElement;
const $pVolVal = document.getElementById('persona-volatility-val') as HTMLElement;
const $pSave = document.getElementById('persona-save') as HTMLButtonElement;
const $pStatus = document.getElementById('persona-status') as HTMLElement;

/** 把表单滑块/数字回显;label 跟随滑块值刷新(两位小数)。 */
function renderPersonaForm(form: PersonaForm): void {
  $pName.value = form.name;
  $pWarmth.value = String(form.warmth);
  $pExpr.value = String(form.expressiveness);
  $pVol.value = String(form.volatility);
  refreshPersonaLabels();
}

/** 三档滑块值标签(实时反映拖动)。 */
function refreshPersonaLabels(): void {
  $pWarmthVal.textContent = Number($pWarmth.value).toFixed(2);
  $pExprVal.textContent = Number($pExpr.value).toFixed(2);
  $pVolVal.textContent = Number($pVol.value).toFixed(2);
}

$pWarmth.addEventListener('input', refreshPersonaLabels);
$pExpr.addEventListener('input', refreshPersonaLabels);
$pVol.addEventListener('input', refreshPersonaLabels);

$pSave.addEventListener('click', () => {
  if ($pSave.disabled) return;
  $pSave.disabled = true;
  $pStatus.textContent = '正在应用…';
  $pStatus.className = 'muted';
  const form: PersonaForm = {
    name: $pName.value.trim(),
    warmth: Number($pWarmth.value),
    expressiveness: Number($pExpr.value),
    volatility: Number($pVol.value),
  };
  void xiaoxue
    .updatePersona(form)
    .then((applied) => {
      // 用主进程规整后的最终值回填(夹取/空名回落已发生),并刷新横幅名字。
      renderPersonaForm(applied);
      $name.textContent = applied.name;
      document.title = `和「${applied.name}」聊天`;
      $pStatus.textContent = `已生效:${applied.name}(温暖 ${applied.warmth.toFixed(2)} · 表达 ${applied.expressiveness.toFixed(2)} · 波动 ${applied.volatility.toFixed(2)})`;
      $pStatus.className = 'persona-status ok';
    })
    .catch((err: unknown) => {
      $pStatus.textContent = `保存没成功——${err instanceof Error ? err.message : String(err)}`;
      $pStatus.className = 'persona-status err';
    })
    .finally(() => {
      $pSave.disabled = false;
    });
});

// 启动:取当前人格回填面板。
void xiaoxue.getPersona().then(renderPersonaForm);
// ───────────────────────────── 记忆查看 + 设置 + 换段对话(代理D) ─────────────────────────────

const $reset = document.getElementById('reset') as HTMLButtonElement;
const $memory = document.getElementById('memory') as HTMLElement;
const $memoryList = document.getElementById('memory-list') as HTMLElement;
const $memoryEmpty = document.getElementById('memory-empty') as HTMLElement;
const $memoryToggle = document.getElementById('memory-toggle') as HTMLButtonElement;
const $memoryRefresh = document.getElementById('memory-refresh') as HTMLButtonElement;
const $settings = document.getElementById('settings') as HTMLElement;
const $settingsToggle = document.getElementById('settings-toggle') as HTMLButtonElement;
const $setProvider = document.getElementById('set-provider') as HTMLElement;
const $setModel = document.getElementById('set-model') as HTMLElement;
const $setMemory = document.getElementById('set-memory') as HTMLElement;
const $setOutputLang = document.getElementById('set-output-lang') as HTMLSelectElement;
const $setOutputLangStatus = document.getElementById('set-output-lang-status') as HTMLElement;

// —— 换段对话:换新 session(长期记忆保留)+ 清空消息区,给一条分隔提示 ——
$reset.addEventListener('click', () => {
  void xiaoxue.reset();
  // 清空当前对话气泡;丢弃进行中的占位气泡(若有)。
  pendingBubble = null;
  $messages.replaceChildren();
  addBubble('xiao', '（开了新的一段对话——我还记得我们之前聊过的事。）');
});

// —— 记忆只读查看:渲染一批 MemoryItem 到列表 ——
function renderMemories(items: readonly MemoryItem[]): void {
  $memoryList.replaceChildren();
  $memoryEmpty.hidden = items.length > 0;
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'memory-item';
    const text = document.createElement('div');
    text.className = 'memory-text';
    text.textContent = it.text;
    const meta = document.createElement('div');
    meta.className = 'memory-meta muted';
    const when = new Date(it.lastSeenAtMs).toLocaleString('zh-CN', { hour12: false });
    meta.textContent = `${it.kindLabel} · 重要度 ${it.importance.toFixed(2)} · ${when}`;
    li.append(text, meta);
    $memoryList.appendChild(li);
  }
}

/** 拉取最近记忆并渲染(只读;主进程绝不触发写/巩固)。失败静默(不崩、不打扰对话)。 */
function refreshMemories(): void {
  void xiaoxue
    .listMemories(50)
    .then(renderMemories)
    .catch(() => {
      $memoryEmpty.hidden = false;
    });
}

$memoryToggle.addEventListener('click', () => {
  const show = $memory.hidden;
  $memory.hidden = !show;
  if (show) refreshMemories(); // 展开时拉一次最新。
});
$memoryRefresh.addEventListener('click', refreshMemories);

// —— 设置面板:只读展示 getInfo() 已有的 provider/model/记忆后端 ——
$settingsToggle.addEventListener('click', () => {
  $settings.hidden = !$settings.hidden;
});

void xiaoxue.getInfo().then((info) => {
  $setProvider.textContent = info.isFake ? `${info.provider}(占位）` : info.provider;
  $setModel.textContent = info.model;
  $setMemory.textContent = info.memory;
  // 可写项:语音输出语种回填当前值(''=自动)。
  $setOutputLang.value = info.outputLang;
});

// —— 设置面板可写项:语音输出语种 —— 选/改即写回 .env.local + 即时生效(下次语音模式装配读到)。
$setOutputLang.addEventListener('change', () => {
  $setOutputLangStatus.textContent = '正在应用…';
  void xiaoxue
    .setOutputLang($setOutputLang.value)
    .then((applied) => {
      $setOutputLang.value = applied; // 用规整后的最终值回填。
      $setOutputLangStatus.textContent = '已保存(语音模式下次启动生效)。';
    })
    .catch((err: unknown) => {
      $setOutputLangStatus.textContent = `保存没成功——${err instanceof Error ? err.message : String(err)}`;
    });
});

// ═══════════════════════════════ 朗读:最小 Web Audio 播放器(本批次) ═══════════════════════════════
//
// 收 tts:audio 的 Int16 PCM@sampleRate → Float32 → 用 AudioContext 排队**无缝**播放(把每块按上一块的
// 结束时刻接续调度,避免缝隙);tts:audio-stop 立即停并清队列。重采样靠 AudioContext 自身(用块自带
// sampleRate 建 buffer,浏览器输出时自动重采样到 ctx.sampleRate),~60 行、零外部依赖、不依赖 web-voice 包。
class PcmPlayer {
  #ctx: AudioContext | null = null;
  /** 下一块应开始播放的时刻(ctx.currentTime 基准);保证块间无缝接续。 */
  #nextStartAt = 0;
  /** 在播的源节点集合(stop 时全部断开)。 */
  readonly #sources = new Set<AudioBufferSourceNode>();

  /** 懒建 AudioContext(首次播放时,满足浏览器自动播放策略——由用户交互发起的回合触发)。 */
  #ensureCtx(): AudioContext {
    if (this.#ctx === null) {
      this.#ctx = new AudioContext();
      this.#nextStartAt = this.#ctx.currentTime;
    }
    return this.#ctx;
  }

  /**
   * 在用户交互时主动建并 resume AudioContext(满足自动播放策略):AudioContext 在无用户手势时
   * 可能初始挂起,导致朗读 PCM 排入却不出声。发送/点击/键入时调用一次即可让其转入 running。
   */
  resume(): void {
    try {
      void this.#ensureCtx().resume();
    } catch {
      /* 忽略:resume 失败不影响文字 */
    }
  }

  /** 排入一块 PCM:Int16→Float32([-1,1]) → 建单声道 buffer → 接在上一块尾部调度播放。 */
  enqueue(chunk: TtsAudioChunk): void {
    const pcm = chunk.pcm;
    if (pcm.length === 0) return;
    const ctx = this.#ensureCtx();
    void ctx.resume(); // 若被浏览器挂起(自动播放策略),回合由用户交互发起,resume 可成功。
    const f32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f32[i] = (pcm[i] ?? 0) / 32768;
    const buffer = ctx.createBuffer(1, f32.length, chunk.sampleRate);
    buffer.copyToChannel(f32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    // 无缝接续:从 max(now, 上一块结束) 开始。
    const startAt = Math.max(ctx.currentTime, this.#nextStartAt);
    src.start(startAt);
    this.#nextStartAt = startAt + buffer.duration;
    this.#sources.add(src);
    src.onended = (): void => {
      this.#sources.delete(src);
    };
  }

  /** 立即停播并清队列(回合结束/被打断):断开所有在播源,重置调度时刻。 */
  stop(): void {
    for (const src of [...this.#sources]) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        /* 已结束的源 stop 会抛,吞掉 */
      }
    }
    this.#sources.clear();
    if (this.#ctx !== null) this.#nextStartAt = this.#ctx.currentTime;
  }
}

const pcmPlayer = new PcmPlayer();
xiaoxue.onTtsAudio((chunk) => pcmPlayer.enqueue(chunk));
xiaoxue.onTtsAudioStop(() => pcmPlayer.stop());

// 自动播放策略兜底:首次用户交互(发送/点击/键入)时建并 resume AudioContext,
// 确保朗读 PCM 排入后真出声(AudioContext 无用户手势时可能初始挂起)。
const __primeAudio = (): void => pcmPlayer.resume();
$send.addEventListener('click', __primeAudio);
window.addEventListener('pointerdown', __primeAudio);
window.addEventListener('keydown', __primeAudio);

// ═══════════════════════════════ 语言面板:三独立语种 + 朗读开关(本批次) ═══════════════════════════════
const $langDisplay = document.getElementById('lang-display') as HTMLSelectElement;
const $langTts = document.getElementById('lang-tts') as HTMLSelectElement;
const $langCloneRef = document.getElementById('lang-clone-ref') as HTMLSelectElement;
const $speakToggle = document.getElementById('speak-toggle') as HTMLInputElement;
const $speakHint = document.getElementById('speak-hint') as HTMLElement;
const $langStatus = document.getElementById('lang-status') as HTMLElement;
const $langToggle = document.getElementById('lang-toggle') as HTMLButtonElement;
const $lang = document.getElementById('lang') as HTMLElement;

/** 把面板下拉/开关按当前设置回填。 */
function renderLangForm(form: LangForm): void {
  $langDisplay.value = form.displayLang; // ''=自动
  $langTts.value = form.ttsLang; // 'follow'/''/具体
  $langCloneRef.value = form.cloneRefLang;
  $speakToggle.checked = form.speak;
  // 朗读不可用 → 禁开关 + 提示。
  $speakToggle.disabled = !form.speakAvailable;
  $speakHint.textContent = form.speakAvailable
    ? ''
    : '朗读不可用:未配置可用的语音合成(TTS）——文字对话不受影响。';
}

/** 收集面板当前值提交主进程(运行时生效 + 持久化)。 */
function submitLang(): void {
  const form: Partial<LangForm> = {
    displayLang: $langDisplay.value,
    ttsLang: $langTts.value,
    cloneRefLang: $langCloneRef.value,
    speak: $speakToggle.checked,
  };
  $langStatus.textContent = '正在应用…';
  void xiaoxue
    .setLang(form)
    .then((applied) => {
      renderLangForm(applied);
      $langStatus.textContent = '语言设置已生效。';
    })
    .catch((err: unknown) => {
      $langStatus.textContent = `设置没成功——${err instanceof Error ? err.message : String(err)}`;
    });
}

$langDisplay.addEventListener('change', submitLang);
$langTts.addEventListener('change', submitLang);
$langCloneRef.addEventListener('change', submitLang);
$speakToggle.addEventListener('change', submitLang);
$langToggle.addEventListener('click', () => {
  $lang.hidden = !$lang.hidden;
});

// 启动:取当前语种 + 朗读设置回填面板。
void xiaoxue.getLang().then(renderLangForm);
