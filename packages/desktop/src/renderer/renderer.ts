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
