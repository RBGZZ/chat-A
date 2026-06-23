/**
 * 接缝 1 `AudioTransport`(承 §2 拓扑 / §3 七接缝 / §4.2 B 层帧):
 * 承载**音频帧在"终端↔大脑"间的双向传输**的最小契约。这是隔离接缝——
 * 业务核心(runtime/cognition)只依赖本接口,不感知背后是进程内直通、WebSocket(§8)
 * 还是(备选)WebRTC;切换部署形态 B↔A 只换实现 + 改配置,消费者零改动(§3.1)。
 *
 * 为何独立于事件总线(§4.2 / bus-events 顶注):音频帧是 **B 层高频流式数据**,
 * 不上 A 层模块总线(高频 + deepFreeze 成本 + 破坏分层)。故复用 `frames.ts` 的
 * 音频帧类型(`audio:input` / `tts:chunk`,均带显式 `AudioFormat` + `pcm.ts` 样本),
 * 经本传输流转,而非 `BusEvent`。
 *
 * 方向(承 §2「单一边界」/ §4.2 音频硬约定):
 *   - 上行 终端→大脑:`audio:input`(麦克风,16kHz / mono / s16le,见 STT_AUDIO_FORMAT)。
 *   - 下行 大脑→终端:`tts:chunk`(合成音频,24kHz / mono,见 TTS_AUDIO_FORMAT)。
 * 同一接口双向复用:`sendAudio` 发本端的帧,`onAudio` 收对端来的帧;终端侧与大脑侧
 * 各持一个实例,语义对称(终端 send 上行/收下行,大脑 send 下行/收上行)。
 *
 * 背压(承 §4.2.2):**A/传输层不设队列**——有界缓冲 / 背压 / 打断丢弃是 B 层帧管线的事。
 * 本接口只做"投递"语义,不承诺缓冲与重排。
 */
import type { Frame } from './frames';

/**
 * 经 AudioTransport 流转的帧:**限定为音频帧**(`audio:input` / `tts:chunk`)。
 * 复用 `Frame` 判别联合并按 `type` 收窄——非音频帧(`stt:partial`/`llm:token`)走帧管线,
 * 不跨终端↔大脑边界,故在类型层即排除,避免误把转写/token 塞进音频通道。
 */
export type AudioFrame = Extract<Frame, { type: 'audio:input' | 'tts:chunk' }>;

/** 收到对端音频帧时的回调(同步签名;实现可同步或异步投递,见 InProcessAudioTransport)。 */
export type AudioListener = (frame: AudioFrame) => void;

/** 注销监听:`onAudio` 返回此函数,调用即移除对应 listener(借总线 pub/sub 惯例)。 */
export type Unsubscribe = () => void;

/**
 * 接缝 1 契约:音频帧双向传输的最小面。真实现(WebSocket,§8)后续接;
 * 本切片只定接口 + 进程内实现(InProcessAudioTransport)。
 */
export interface AudioTransport {
  /**
   * 发送一帧音频到对端(终端→大脑上行 或 大脑→终端下行,按持有方而定)。
   * 不设队列 / 不承诺缓冲(§4.2.2):背压是 B 层帧管线的事。
   * `close()` 之后调用应为 no-op(优雅降级,§3.2:永不崩)。
   */
  sendAudio(frame: AudioFrame): void;

  /**
   * 订阅对端发来的音频帧;返回注销函数。多次订阅 = 多 listener,各自独立。
   * `close()` 之后订阅应为 no-op(返回的注销函数仍可安全调用)。
   */
  onAudio(listener: AudioListener): Unsubscribe;

  /** 关闭传输:清理 listener、释放底层资源(进程内实现即清空 listener 集)。幂等。 */
  close(): void;
}

/**
 * 进程内直通实现(承 §2「本地单机(进程内)」形态 / §9 P0;亦为测试桩)。
 * `sendAudio` 即把帧投递给已注册 listener;不跨网络、不序列化、不设队列(§4.2.2:
 * 背压是 B 层帧管线的事,A/传输层不缓冲)。后续 WebSocketTransport(§8)实现同一接口。
 *
 * 投递语义:**默认同步**(`async: false`,适合确定性测试 / 单进程低延迟);
 * 置 `async: true` 则经 `queueMicrotask` 异步投递(模拟网络异步、避免 send 调用栈过深)。
 * 单进程模式两端各持一个实例,用一对实例对接即成"上行/下行"双向通道(见 `pipe`)。
 *
 * 容错(承 §3.2 永不崩):单个 listener 抛错被捕获(只告警不杀),不影响其它 listener;
 * 投递期间快照 listener 集,故 listener 内 onAudio/close 不破坏本次遍历。
 */
export class InProcessAudioTransport implements AudioTransport {
  /** 已注册 listener;close 后置空并标记 closed。 */
  private listeners = new Set<AudioListener>();
  private closed = false;
  private readonly async: boolean;

  /** `async=true` 经微任务异步投递;默认 false 同步直通(测试友好)。 */
  constructor(options?: { readonly async?: boolean }) {
    this.async = options?.async === true;
  }

  sendAudio(frame: AudioFrame): void {
    if (this.closed) return; // close 后 no-op(优雅降级)
    // 快照:避免 listener 内增删 listener 影响本次遍历;无 listener 即静默丢弃(不抛)。
    const targets = [...this.listeners];
    if (this.async) {
      queueMicrotask(() => {
        for (const l of targets) this.deliver(l, frame);
      });
    } else {
      for (const l of targets) this.deliver(l, frame);
    }
  }

  onAudio(listener: AudioListener): Unsubscribe {
    if (this.closed) return () => {}; // close 后订阅 no-op,返回安全的空注销
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }

  /** 单 listener 投递 + 容错:抛错只告警不杀邻居(§3.2)。 */
  private deliver(listener: AudioListener, frame: AudioFrame): void {
    try {
      listener(frame);
    } catch (err) {
      // 进程内桩:不引第三方日志依赖(protocol 零依赖),退到 console.warn。
      console.warn('[InProcessAudioTransport] listener 抛错(已捕获,不影响其它 listener):', err);
    }
  }
}
