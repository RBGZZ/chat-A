/**
 * CLI 设备选择壳(注入 readline question/write,可单测):列设备 → 读序号 → 返回设备;
 * 选定后把设备名 upsert 进 .env.local。非法/取消 → 返回 null(装配层回退系统默认,§3.2)。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { AudioDeviceInfo } from './device-registry';
import type { CreateAudioDeviceDeps } from '../cli-voice';
import { upsertEnvLocal } from '../env-file';

export function formatDeviceMenu(kind: 'input' | 'output', devices: readonly AudioDeviceInfo[]): string {
  const title = kind === 'input' ? '请选择麦克风(输入设备):' : '请选择扬声器(输出设备):';
  const lines = devices.map(
    (d, i) => `  [${i}] ${d.name}  (${d.hostApi}, ${d.defaultSampleRate}Hz)`,
  );
  return `${title}\n${lines.join('\n')}\n请输入序号 › `;
}

export function makeCliAudioSelect(io: {
  question: (q: string) => Promise<string>;
  write: (s: string) => void;
  envPath: string;
}): CreateAudioDeviceDeps {
  return {
    promptSelect: async (kind, devices) => {
      const ans = (await io.question(formatDeviceMenu(kind, devices))).trim();
      // 空回车(非交互空串 / 用户直接回车):明确回退系统默认,绝不误选 0 号设备。
      if (ans.length === 0) {
        io.write('（未选择，回退系统默认设备）\n');
        return null;
      }
      // 严格只接受纯数字序号(拒绝 '1.5' / '  ' / 'zzz' 等):避免 Number('1.5')=1.5 等被 floor/误判。
      if (!/^\d+$/.test(ans)) {
        io.write('(输入无效,已回退系统默认设备)\n');
        return null;
      }
      const idx = Number(ans);
      if (!Number.isInteger(idx) || idx < 0 || idx >= devices.length) {
        io.write('(输入无效,已回退系统默认设备)\n');
        return null;
      }
      return devices[idx]!;
    },
    persistSelection: (kind, dev) => {
      try {
        let text = '';
        try {
          text = readFileSync(io.envPath, 'utf8');
        } catch {
          text = '';
        }
        const nameKey = kind === 'input' ? 'CHAT_A_AUDIO_INPUT_DEVICE_NAME' : 'CHAT_A_AUDIO_OUTPUT_DEVICE_NAME';
        const hostKey = kind === 'input' ? 'CHAT_A_AUDIO_INPUT_DEVICE_HOST' : 'CHAT_A_AUDIO_OUTPUT_DEVICE_HOST';
        text = upsertEnvLocal(text, nameKey, dev.name);
        text = upsertEnvLocal(text, hostKey, dev.hostApi);
        writeFileSync(io.envPath, text, 'utf8');
        io.write(`(已记住${kind === 'input' ? '麦克风' : '扬声器'}:${dev.name})\n`);
      } catch {
        /* 持久化失败不致命:本次仍用所选设备(§3.2) */
      }
    },
  };
}
