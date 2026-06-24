/**
 * `runVoiceLoop` —— 把 {@link AudioDevice} 桥接到 {@link VoiceLoop}(经 InProcessAudioTransport)。
 *
 * 拓扑(单进程,§2 本地形态):设备与 VoiceLoop **共享一个** InProcessAudioTransport,各按帧类型过滤:
 *   - 上行:设备麦克风帧(PcmFrame) → `audio:input` 帧 → `transport.sendAudio` → VoiceLoop 听;
 *           (VoiceLoop 自身忽略下行 tts:chunk,见 voice-loop.ts #onAudio。)
 *   - 下行:VoiceLoop TTS → `tts:chunk` 帧 → transport 回环 → 本桥接 `onAudio` 收 tts:chunk → 设备播放;
 *           (设备侧只认 tts:chunk,上行 audio:input 由本桥接过滤掉,不回灌设备。)
 * `turn:interrupt` 时 VoiceLoop 调 `transport.clearBuffer()` 排空在途下行;本桥接据 bus 的
 * `turn:interrupt` 事件触发 `device.playStop()`(让扬声器即时停),对齐核心打断(§4)。
 *
 * 设计:**不改 VoiceLoop / 不改 transport**,纯装配。返回一个 `stop()` 收尾函数(停采集 + stop loop + 关设备/总线)。
 */
import {
  InProcessAudioTransport,
  makeDataFrame,
  STT_AUDIO_FORMAT,
  type AudioFrame,
  type AudioTransport,
  type PcmFrame,
} from '@chat-a/protocol';
import { LightVoiceBus, VoiceLoop } from '@chat-a/runtime';
import type { VoiceLoopDeps } from '@chat-a/runtime';
import type { AudioDevice } from './audio-device';

/** runVoiceLoop 入参:设备 + 组装 VoiceLoop 所需依赖(transport/bus 由本函数建,故从 deps 排除)。 */
export interface RunVoiceLoopDeps {
  readonly device: AudioDevice;
  /** VoiceLoop 依赖,但 `transport` / `bus` 由 runner 自建并接到设备,故此处不需提供。 */
  readonly loopDeps: Omit<VoiceLoopDeps, 'transport' | 'bus'>;
  /** 复用既有 bus(cli 想与文字链路共享总线时传);缺省 runner 新建一个。 */
  readonly bus?: LightVoiceBus;
  /**
   * 复用既有 transport:缺省进程内 {@link InProcessAudioTransport}(单机形态,行为逐字不变);
   * websocket 档由 cli-voice 传入 `@chat-a/gateway` 的 `WebSocketTransport`(终端侧),
   * 二者都满足 {@link AudioTransport} 契约,本函数零业务改动(§3.1 接缝隔离)。
   */
  readonly transport?: AudioTransport;
}

export interface VoiceLoopHandle {
  readonly loop: VoiceLoop;
  readonly bus: LightVoiceBus;
  readonly transport: AudioTransport;
  /** 收尾:停采集 → 停 loop → 关设备/总线(幂等)。 */
  stop(): void;
}

/** 把 16kHz mono s16le 的麦克风帧封成上行 `audio:input` AudioFrame。 */
function toInputFrame(pcm: PcmFrame): AudioFrame {
  return makeDataFrame('audio:input', { audio: pcm, format: STT_AUDIO_FORMAT });
}

/**
 * 启动语音闭环:接好设备↔transport↔VoiceLoop↔设备,开始监听麦克风。
 * 返回句柄(含 loop / bus / transport + stop)。
 */
export function runVoiceLoop(deps: RunVoiceLoopDeps): VoiceLoopHandle {
  const bus = deps.bus ?? new LightVoiceBus();
  const transport = deps.transport ?? new InProcessAudioTransport();
  const device = deps.device;

  const loop = new VoiceLoop({ ...deps.loopDeps, transport, bus });

  // 下行:transport 回环出的 tts:chunk → 设备扬声器(忽略上行 audio:input,避免回灌)。
  const unsubDown = transport.onAudio((frame) => {
    if (frame.type !== 'tts:chunk') return;
    device.play({
      samples: frame.payload.samples,
      sampleRate: frame.payload.format.sampleRate,
      channels: frame.payload.format.channels,
    });
  });

  // 打断:VoiceLoop emit turn:interrupt → 扬声器即时停(对齐 transport.clearBuffer)。
  const unsubInterrupt = bus.on('turn:interrupt', () => {
    try {
      device.playStop();
    } catch {
      /* 停播失败不致命 */
    }
  });

  loop.start();

  // 上行:麦克风帧 → audio:input → transport(VoiceLoop 听)。
  const stopCapture = device.captureStart((pcm) => {
    transport.sendAudio(toInputFrame(pcm));
  });

  let stopped = false;
  return {
    loop,
    bus,
    transport,
    stop(): void {
      if (stopped) return;
      stopped = true;
      try {
        stopCapture();
      } catch {
        /* ignore */
      }
      loop.stop();
      unsubDown();
      unsubInterrupt();
      try {
        device.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/** runTerminalBridge 入参:终端设备 + 终端侧 transport(WebSocket)。 */
export interface RunTerminalBridgeDeps {
  readonly device: AudioDevice;
  /** 终端侧传输(WS):上行麦克风帧、下行收 tts:chunk;**大脑/VoiceLoop 在另一进程**。 */
  readonly transport: AudioTransport;
}

/** 终端桥句柄:停 = 停采集 + 收尾(不关 transport,由调用方掌控其生命周期)。 */
export interface TerminalBridgeHandle {
  stop(): void;
}

/**
 * 终端桥(B 架构「终端」侧,§2):**只接设备↔transport**,不在本进程跑 VoiceLoop/大脑。
 *   - 上行:麦克风帧 → `audio:input` → `transport.sendAudio`(经 WS 送大脑)。
 *   - 下行:`transport.onAudio` 收 tts:chunk → 设备播放(generation 丢弃在 transport 内已做)。
 *   - 打断:用户再开口由大脑侧 VoiceLoop 判定并下发 interrupt;终端侧 transport 收 interrupt 抬代际,
 *     播放即时停由设备 playStop——本桥监听 transport 下行帧自然停旧帧,playStop 接缝可后续接。
 *
 * 与 {@link runVoiceLoop} 的区别:无 bus / 无 VoiceLoop —— 终端是「哑」收发端,符合 B 方案「大脑在服务端」。
 */
export function runTerminalBridge(deps: RunTerminalBridgeDeps): TerminalBridgeHandle {
  const { device, transport } = deps;

  // 下行:transport 收到大脑下发的 tts:chunk → 设备扬声器(上行 audio:input 不会回灌终端)。
  const unsubDown = transport.onAudio((frame) => {
    if (frame.type !== 'tts:chunk') return;
    device.play({
      samples: frame.payload.samples,
      sampleRate: frame.payload.format.sampleRate,
      channels: frame.payload.format.channels,
    });
  });

  // 上行:麦克风帧 → audio:input → transport(经 WS 送大脑 STT)。
  const stopCapture = device.captureStart((pcm) => {
    transport.sendAudio(toInputFrame(pcm));
  });

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      try {
        stopCapture();
      } catch {
        /* ignore */
      }
      unsubDown();
      try {
        device.close();
      } catch {
        /* ignore */
      }
    },
  };
}
