import { describe, it, expect } from 'vitest';
import type { StreamingSttPort, StreamingSttSession, VoicePath } from '../src/voice-loop';
import type { PcmChunk } from '@chat-a/providers';

describe('StreamingSttPort 接缝', () => {
  it('可实现端口:openSession 返回带 pushAudio/close 的会话', () => {
    const pushed: PcmChunk[] = [];
    const port: StreamingSttPort = {
      openSession(handlers) {
        // 立刻回一个 final,验证 handler 形状
        handlers.onFinal('你好', { label: 'happy' }, 'zh');
        const session: StreamingSttSession = {
          pushAudio: (c) => pushed.push(c),
          close: () => {},
        };
        return session;
      },
    };
    let finalText = '';
    const s = port.openSession({
      onSpeechStarted() {},
      onPartial() {},
      onFinal(t) { finalText = t; },
      onError() {},
    });
    s.pushAudio({ samples: new Int16Array(160), sampleRate: 16000, channels: 1 });
    s.close();
    expect(finalText).toBe('你好');
    expect(pushed.length).toBe(1);
  });

  it("VoicePath 接受 'stt-stream'", () => {
    const p: VoicePath = 'stt-stream';
    expect(p).toBe('stt-stream');
  });
});
