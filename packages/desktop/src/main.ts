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
} from '@chat-a/client';
import { createVoice, QWEN_VOICE_CLONE_DEFAULT_TARGET_MODEL } from '@chat-a/providers';
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
  type AppInfo,
  type VoiceCloneInput,
  type VoiceCloneStatus,
} from './ipc-contract';

let mainWindow: BrowserWindow | null = null;
let appHandle: AppHandle | null = null;
let voiceHandle: VoiceModeHandle | undefined;

/** 向渲染层推一条 IPC(窗口已关则静默丢弃)。 */
function emit(channel: string, payload?: unknown): void {
  mainWindow?.webContents.send(channel, payload);
}

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
 */
async function cloneVoiceViaDashScope(handle: AppHandle, input: VoiceCloneInput): Promise<string> {
  const apiKey = dashKey(handle);
  if (apiKey.length === 0) throw new Error(CLONE_NO_KEY_REASON);
  const configModel = (handle.env['CHAT_A_TTS_MODEL'] ?? '').trim();
  const targetModel =
    configModel.includes('vc') ? configModel : QWEN_VOICE_CLONE_DEFAULT_TARGET_MODEL;
  const audio =
    input.path !== undefined && input.path.length > 0
      ? { path: input.path }
      : input.bytes !== undefined
        ? { data: input.bytes, mime: input.mime ?? 'application/octet-stream' }
        : undefined;
  if (audio === undefined) throw new Error('未选择音频文件;请先选择一段约 15 秒的清晰录音。');
  const { voiceId } = await createVoice(audio, { apiKey, targetModel });
  return voiceId;
}

/**
 * 持久化复刻 voiceId:写项目根 .env.local 的 CHAT_A_VOICE_ID(保留其它行)+ 即时设入当前进程 env
 * (无需重启即可被后续语音模式装配读到)。写盘失败抛错由 runCloneVoice 降级提示。
 */
function persistVoiceId(handle: AppHandle, voiceId: string): void {
  handle.env['CHAT_A_VOICE_ID'] = voiceId; // 本进程即时生效。
  const path = join(process.cwd(), '.env.local');
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // 文件不存在 → 从空文本新建。
  }
  writeFileSync(path, upsertEnvLocal(text, 'CHAT_A_VOICE_ID', voiceId), 'utf8');
}

/** 订阅总线:UI 状态派生 + 回合后心情 + 语音转写,推给渲染层。 */
function wireBus(handle: AppHandle): () => void {
  const tracker = new StateTracker();
  const offTracker = tracker.start(handle.bus);
  const offChange = tracker.onChange((s) => emit(IPC.state, s));
  // 回合结束后读当前心情推给渲染层(低频,回合级)。
  const offTurnEnd = handle.bus.on('turn:end', () => {
    try {
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
  ipcMain.handle(IPC.send, async (_e, text: string) => {
    await runSendTurn(
      { send: (t, onToken) => handle.convo.send(t, onToken), emit: (ch, p) => emit(ch, p) },
      text,
    );
  });

  // 换一段新对话(长期记忆仍保留)。
  ipcMain.handle(IPC.reset, () => {
    handle.reset();
  });

  // 横幅信息。
  ipcMain.handle(IPC.getInfo, () => buildAppInfo(handle));

  // 一键复刻:读文件/字节 → createVoice → 持久化 CHAT_A_VOICE_ID;全程降级不崩(§3.2)。
  ipcMain.handle(IPC.voiceClone, async (_e, input: VoiceCloneInput) => {
    await runCloneVoice(
      {
        clone: (i) => cloneVoiceViaDashScope(handle, i),
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
      voiceHandle = await startVoiceMode({
        send: (t, onToken) => handle.convo.send(t, onToken),
        composeOmniInstructions: () => handle.composeOmniInstructions(),
        memory: handle.memory,
        bus: handle.bus,
        sessionId: handle.sessionId,
        env,
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

  // 语音停止(幂等)。
  ipcMain.handle(IPC.voiceStop, () => {
    try {
      voiceHandle?.stop();
    } catch {
      /* 幂等收尾,失败吞 */
    } finally {
      voiceHandle = undefined;
    }
  });
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

  app.on('before-quit', () => {
    offBus();
    try {
      voiceHandle?.stop();
    } catch {
      /* ignore */
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
