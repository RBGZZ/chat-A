import type { SttProvider } from './stt';
import type { SttConfig } from './stt-config';
import { FakeStt } from './fake-stt';
import { OpenAiCompatStt } from './openai-compat-stt';
import { WhisperLocalStt } from './whisper-local-stt';
import type { SpawnFn } from './whisper-local-stt';

/**
 * 运行时注入的 STT 端口(R1 注入式接缝)。
 * worktree 不装原生二进制/模型,真引擎经此端口由运行时注入;省略则相应 kind 明确报错(非崩)。
 */
export interface SttPorts {
  /** whisper-local 的子进程端口(SpawnFn);运行时包一层 node:child_process spawn 调 whisper.cpp/faster-whisper CLI。 */
  readonly spawn?: SpawnFn;
}

/** 后端工厂:某一 kind 的子配置(+ 注入端口) → 具体 SttProvider。 */
type SttFactory<K extends SttConfig['kind']> = (
  config: Extract<SttConfig, { kind: K }>,
  ports: SttPorts,
) => SttProvider;

/**
 * 按判别联合 `kind` 索引的工厂表(承 §4.3 语音 Provider 可换性;镜像 embedder-registry)。
 * 加新引擎 = 加一个 kind 分支(config) + 在此登记工厂,**createStt 核心零改动**、无 if/else 散落。
 */
const registry: { [K in SttConfig['kind']]: SttFactory<K> } = {
  fake: (cfg) =>
    new FakeStt({
      ...(cfg.languages !== undefined ? { capabilities: { languages: cfg.languages } } : {}),
    }),
  'openai-compat': (cfg) =>
    new OpenAiCompatStt({
      id: cfg.id ?? 'openai-compat',
      model: cfg.model,
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      ...(cfg.language !== undefined ? { language: cfg.language } : {}),
      ...(cfg.responseFormat !== undefined ? { responseFormat: cfg.responseFormat } : {}),
      ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
      ...(cfg.languages !== undefined ? { languages: cfg.languages } : {}),
    }),
  // 本地引擎(faster-whisper / whisper.cpp / sherpa-onnx):注入了 spawn 端口才建真适配,
  // 否则明确报错"需运行时端口"(非"尚未接入"——接缝已就位,缺的是运行时注入,§4.3 R1)。
  'whisper-local': (cfg, ports) => {
    if (ports.spawn === undefined) {
      throw new Error(
        `whisper-local STT 需运行时提供 spawn 端口(SttPorts.spawn);config 已就位:model=${cfg.model}。` +
          `请用 createStt(config, { spawn }) 注入(运行时包 node:child_process spawn 调 whisper.cpp/faster-whisper CLI)。`,
      );
    }
    return new WhisperLocalStt({
      id: cfg.id ?? 'whisper-local',
      model: cfg.model,
      spawn: ports.spawn,
      ...(cfg.device !== undefined ? { device: cfg.device } : {}),
      ...(cfg.computeType !== undefined ? { computeType: cfg.computeType } : {}),
      ...(cfg.language !== undefined ? { language: cfg.language } : {}),
      ...(cfg.beamSize !== undefined ? { beamSize: cfg.beamSize } : {}),
      ...(cfg.vadFilter !== undefined ? { vadFilter: cfg.vadFilter } : {}),
      ...(cfg.requiresCuda !== undefined ? { requiresCuda: cfg.requiresCuda } : {}),
      ...(cfg.sampleRate !== undefined ? { sampleRate: cfg.sampleRate } : {}),
      ...(cfg.languages !== undefined ? { languages: cfg.languages } : {}),
    });
  },
};

export function listSttKinds(): readonly SttConfig['kind'][] {
  return Object.keys(registry) as SttConfig['kind'][];
}

/**
 * 由配置解析具体 SttProvider(零代码切换接缝)。
 * 判别联合保证类型收窄;未知 kind 编译期排除,运行期再兜一道(防 JS 侧脏数据)。
 *
 * `ports`(可选)注入运行时端口:本地引擎(whisper-local)经此拿到真 spawn;
 * 未注入时该 kind 明确报错(非崩),云端/fake 不受影响。
 */
export function createStt(config: SttConfig, ports: SttPorts = {}): SttProvider {
  const factory = registry[config.kind] as SttFactory<SttConfig['kind']> | undefined;
  if (factory === undefined) {
    throw new Error(
      `unknown STT kind "${(config as { kind: string }).kind}"; registered: ${listSttKinds().join(', ')}`,
    );
  }
  return factory(config, ports);
}
