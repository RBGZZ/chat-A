import { describe, it, expect } from 'vitest';
import { QwenAsrRealtimeStt } from '../src/qwen-asr-realtime-stt';

// 最小 FakeWs:记录 send 的 JSON,可手动触发 open/message。
function makeFakeWs() {
  const sent: any[] = [];
  let onOpen = () => {};
  let onMsg = (_d: unknown) => {};
  const ws = {
    on(ev: string, cb: any) {
      if (ev === 'open') onOpen = cb;
      else if (ev === 'message') onMsg = cb;
    },
    send(s: string) { sent.push(JSON.parse(s)); },
    close() {},
  };
  return { ws, sent, fireOpen: () => onOpen(), fireMsg: (o: any) => onMsg(JSON.stringify(o)) };
}

describe('QwenAsrRealtimeStt', () => {
  const base = { id: 'qwen-asr-rt', model: 'qwen3-asr-flash-realtime', apiKey: 'k', baseURL: 'wss://x' };

  it('open→发 session.update(server_vad,pcm,16k);收 speech_started/stopped/partial/final 触发 handlers', () => {
    const f = makeFakeWs();
    const stt = new QwenAsrRealtimeStt({ ...base, wsFactory: () => f.ws as any });
    const events: string[] = [];
    let finalText = '', finalEmotion: any;
    const session = stt.openSession({
      onSpeechStarted: () => events.push('start'),
      onSpeechStopped: () => events.push('stop'),
      onPartial: (t) => events.push('partial:' + t),
      onFinal: (t, e) => { finalText = t; finalEmotion = e; events.push('final'); },
      onError: () => events.push('error'),
    });
    f.fireOpen();
    f.fireMsg({ type: 'session.created' });
    const upd = f.sent.find((m) => m.type === 'session.update');
    expect(upd).toBeTruthy();
    expect(upd.session.input_audio_format).toBe('pcm');
    expect(upd.session.sample_rate).toBe(16000);
    expect(upd.session.turn_detection.type).toBe('server_vad');
    f.fireMsg({ type: 'input_audio_buffer.speech_started' });
    f.fireMsg({ type: 'conversation.item.input_audio_transcription.text', text: '你好', emotion: 'happy', language: 'zh' });
    f.fireMsg({ type: 'input_audio_buffer.speech_stopped' });
    f.fireMsg({ type: 'conversation.item.input_audio_transcription.completed', transcript: '你好世界', emotion: 'happy', language: 'zh' });
    expect(events).toContain('start');
    expect(events).toContain('stop');
    // speech_stopped 早于 final(边界先到、定稿后到)
    expect(events.indexOf('stop')).toBeLessThan(events.indexOf('final'));
    expect(events).toContain('partial:你好');
    expect(finalText).toBe('你好世界');
    expect(finalEmotion).toEqual({ label: 'happy' });
    session.close();
  });

  it('vadThreshold 经 session.update.turn_detection.threshold 下发;不设则省略', () => {
    const f = makeFakeWs();
    const stt = new QwenAsrRealtimeStt({ ...base, wsFactory: () => f.ws as any, vadThreshold: 0.5 });
    stt.openSession({ onSpeechStarted(){}, onSpeechStopped(){}, onPartial(){}, onFinal(){}, onError(){} });
    f.fireOpen(); f.fireMsg({ type: 'session.created' });
    const upd = f.sent.find((m) => m.type === 'session.update');
    expect(upd.session.turn_detection.threshold).toBe(0.5);

    const f2 = makeFakeWs();
    const stt2 = new QwenAsrRealtimeStt({ ...base, wsFactory: () => f2.ws as any });
    stt2.openSession({ onSpeechStarted(){}, onSpeechStopped(){}, onPartial(){}, onFinal(){}, onError(){} });
    f2.fireOpen(); f2.fireMsg({ type: 'session.created' });
    const upd2 = f2.sent.find((m) => m.type === 'session.update');
    expect('threshold' in upd2.session.turn_detection).toBe(false);
  });

  it('pushAudio 发 input_audio_buffer.append(base64)', () => {
    const f = makeFakeWs();
    const stt = new QwenAsrRealtimeStt({ ...base, wsFactory: () => f.ws as any });
    const s = stt.openSession({ onSpeechStarted(){}, onSpeechStopped(){}, onPartial(){}, onFinal(){}, onError(){} });
    f.fireOpen(); f.fireMsg({ type: 'session.created' });
    s.pushAudio({ samples: new Int16Array([1, 2, 3, 4]), sampleRate: 16000, channels: 1 });
    const ap = f.sent.find((m) => m.type === 'input_audio_buffer.append');
    expect(ap).toBeTruthy();
    expect(typeof ap.audio).toBe('string'); // base64
    expect(ap.audio.length).toBeGreaterThan(0);
  });

  it('error 事件 → onError', () => {
    const f = makeFakeWs();
    const stt = new QwenAsrRealtimeStt({ ...base, wsFactory: () => f.ws as any });
    let errd = false;
    stt.openSession({ onSpeechStarted(){}, onSpeechStopped(){}, onPartial(){}, onFinal(){}, onError: () => { errd = true; } });
    f.fireOpen(); f.fireMsg({ type: 'session.created' });
    f.fireMsg({ type: 'error', error: { message: 'boom' } });
    expect(errd).toBe(true);
  });
});
