import { describe, it, expect } from 'vitest';
import { SAMPLE_RATE_HZ, CHANNELS, SAMPLES_PER_FRAME, type PcmFrame } from '@chat-a/protocol';
import { decodeWav, encodeWav } from '../src/audio/wav';
import { WavFileAudioDevice, framesFromSamples } from '../src/audio/wav-file-audio-device';

/** 同步排程(确定性测试):立即调用,免真定时器。 */
const syncSchedule = (cb: () => void): void => {
  cb();
};

function frame(ts: number, fill = 0): PcmFrame {
  const samples = new Int16Array(SAMPLES_PER_FRAME);
  samples.fill(fill);
  return { samples, sampleRate: SAMPLE_RATE_HZ, channels: CHANNELS, timestampMs: ts };
}

describe('audio/wav 编解码', () => {
  it('encode→decode 往返还原样本/采样率/声道', () => {
    const samples = Int16Array.from([0, 100, -100, 32767, -32768, 5]);
    const bytes = encodeWav(samples, 24_000, 1);
    const decoded = decodeWav(bytes);
    expect(decoded.sampleRate).toBe(24_000);
    expect(decoded.channels).toBe(1);
    expect(Array.from(decoded.samples)).toEqual(Array.from(samples));
  });

  it('非 RIFF/WAVE → 明确报错', () => {
    expect(() => decodeWav(new Uint8Array([1, 2, 3, 4]))).toThrow(/RIFF\/WAVE/);
  });
});

describe('audio/framesFromSamples', () => {
  it('切成 160 样本/帧,时间戳逐帧 +10ms,尾部补零', () => {
    const samples = new Int16Array(SAMPLES_PER_FRAME + 5); // 1 整帧 + 5 样本
    const frames = framesFromSamples(samples, 0);
    expect(frames).toHaveLength(2);
    expect(frames[0]?.timestampMs).toBe(0);
    expect(frames[1]?.timestampMs).toBe(10);
    expect(frames[0]?.samples.length).toBe(SAMPLES_PER_FRAME);
    expect(frames[1]?.samples.length).toBe(SAMPLES_PER_FRAME); // 补零到整帧
  });
});

describe('audio/WavFileAudioDevice', () => {
  it('采集:注入帧逐帧回调(同步排程)', () => {
    const dev = new WavFileAudioDevice({
      inputFrames: [frame(0), frame(10), frame(20)],
      schedule: syncSchedule,
    });
    const got: PcmFrame[] = [];
    dev.captureStart((f) => got.push(f));
    expect(got).toHaveLength(3);
    expect(got[1]?.timestampMs).toBe(10);
  });

  it('播放:累积块 → flush 产出可解码 WAV', () => {
    const dev = new WavFileAudioDevice({ schedule: syncSchedule });
    dev.play({ samples: Int16Array.from([1, 2, 3]), sampleRate: 24_000, channels: 1 });
    dev.play({ samples: Int16Array.from([4, 5]), sampleRate: 24_000, channels: 1 });
    const wav = dev.flush();
    expect(wav).toBeDefined();
    const decoded = decodeWav(wav!);
    expect(decoded.sampleRate).toBe(24_000);
    expect(Array.from(decoded.samples)).toEqual([1, 2, 3, 4, 5]);
  });

  it('close 后 capture/play 安全 no-op', () => {
    const dev = new WavFileAudioDevice({ inputFrames: [frame(0)], schedule: syncSchedule });
    dev.close();
    const got: PcmFrame[] = [];
    dev.captureStart((f) => got.push(f));
    dev.play({ samples: Int16Array.from([1]), sampleRate: 24_000, channels: 1 });
    expect(got).toHaveLength(0);
    expect(dev.playedSamples).toHaveLength(0);
  });

  it('id 为 wav;playStop 计数', () => {
    const dev = new WavFileAudioDevice({ schedule: syncSchedule });
    expect(dev.id).toBe('wav');
    dev.playStop();
    dev.playStop();
    expect(dev.playStopCount).toBe(2);
  });
});
