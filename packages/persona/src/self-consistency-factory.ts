import type { LlmProvider } from '@chat-a/providers';
import { DefaultSelfConsistencyGuard } from './self-consistency';
import { LlmSelfConsistencyGuard } from './llm-self-consistency';
import type {
  SelfConsistencyConfig,
  SelfConsistencyDecision,
  SelfConsistencyGuard,
} from './types';

/**
 * 自我一致性 Guard 装配工厂(承 companion-coherence-wiring,§6.1)。
 *
 * 收敛"mode → **启用态** Guard 实例"的映射,杜绝调用方(cli)散落 `enabled:true` 配置字面量
 * (Guard 内核缺省 `enabled=false`,若不显式启用则对一切输入返回 `{drift:false}`,等价没接)。
 *
 * - `'off'`(默认)/ 其它:返回 `undefined`(不创建、不注入;缺省安全,回合行为字面不变)。
 * - `'on'`:确定性 `DefaultSelfConsistencyGuard`(纯字符串扫描,微秒级,无网络)。
 * - `'llm'`:`LlmSelfConsistencyGuard`(opt-in;失败降级不锚定,§3.2);**需提供 `provider`**,
 *   缺 provider 时安全回落 `undefined`(不崩)。
 *
 * `strictness` 缺省 `core-only`(保守,仅 name + 核心档锚);`onDecision`/`onError` 透传。
 */
export type SelfConsistencyMode = 'off' | 'on' | 'llm';

/** 把任意输入归一为合法 mode(大小写不敏感、去空白);非法/缺省 → 'off'。 */
export function parseSelfConsistencyMode(raw: string | undefined): SelfConsistencyMode {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'on' || v === 'llm' ? v : 'off';
}

export interface CreateSelfConsistencyGuardOptions {
  /** LLM 实现所需 provider(`mode==='llm'` 必给;缺则回落 undefined)。 */
  readonly provider?: LlmProvider;
  /** 锚点严格度;缺省 core-only(保守)。 */
  readonly strictness?: SelfConsistencyConfig['strictness'];
  /** 判定 trace sink(§8.1,可选)。 */
  readonly onDecision?: (d: SelfConsistencyDecision) => void;
  /** LLM 调用失败上报(可选;mode==='llm' 用)。 */
  readonly onError?: (err: unknown) => void;
}

/**
 * 按 mode 创建**启用态** Guard;`off`/非法/(llm 缺 provider)→ undefined(不注入,缺省安全)。
 */
export function createSelfConsistencyGuard(
  mode: SelfConsistencyMode,
  opts: CreateSelfConsistencyGuardOptions = {},
): SelfConsistencyGuard | undefined {
  const strictness = opts.strictness ?? 'core-only';
  const config: SelfConsistencyConfig = { enabled: true, strictness };
  if (mode === 'on') {
    return new DefaultSelfConsistencyGuard({
      config,
      ...(opts.onDecision ? { onDecision: opts.onDecision } : {}),
    });
  }
  if (mode === 'llm') {
    if (opts.provider === undefined) return undefined; // 缺 provider:安全回落不注入(不崩)。
    return new LlmSelfConsistencyGuard({
      provider: opts.provider,
      config,
      ...(opts.onDecision ? { onDecision: opts.onDecision } : {}),
      ...(opts.onError ? { onError: opts.onError } : {}),
    });
  }
  return undefined; // off / 其它:缺省安全。
}
