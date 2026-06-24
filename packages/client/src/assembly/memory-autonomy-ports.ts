/**
 * memory → autonomy 端口适配器(companion-live-wiring,装配层,承 §7 / §3.1)。
 *
 * autonomy 包 standalone 只认端口接口(`OpenThreadPort` / `PresencePort`,§3.1 依赖倒置),
 * 真记忆适配由**装配层**用 `@chat-a/memory` 公开 API 实现并注入。本文件即该适配:
 *   - `createOpenThreadPort(store)`:基于 `store.openThreads()` 把 `MemoryRecord` 映射成 `OpenThread`
 *     (未了话题跟进的真候选来源,§7#2)。
 *   - `createPresencePort({ clock })`:memory **无直接「用户上次活跃」真相源**,故实现成**最小可用**的
 *     进程内在场近似(idle 情绪弧的来源,§7#idle)。
 *
 * 关键约束:只依赖 `@chat-a/memory` 公开类型 + `@chat-a/autonomy` 端口类型,**不 import 别模块内部**
 * (§3.1);读取失败优雅降级(空列表 / 安全缺省,不抛,§3.2);仅 autonomy on 时构造(off 零开销)。
 */
import type { MemoryStore, MemoryRecord } from '@chat-a/memory';
import {
  combinedCandidateSource,
  idleArcCandidateSource,
  openThreadCandidateSource,
  systemClock,
  type Clock,
  type OpenThread,
  type OpenThreadPort,
  type PresencePort,
  type ProactiveCandidateSource,
} from '@chat-a/autonomy';

/** memory store 的最小读面(本适配只用 openThreads;窄化便于假实现单测)。 */
export type OpenThreadStore = Pick<MemoryStore, 'openThreads'>;

/** memory 无人物归属(agent 主语记忆)时,OpenThread.personId 的占位回落(对齐 memory 默认主用户 id)。 */
export const DEFAULT_PRESENCE_PERSON_ID = 'primary';

/**
 * 把一条记忆映射成 OpenThread:
 *   - `id → String(id)`(autonomy 端口要字符串 id)
 *   - `text → topic`(未了话题正文即主题摘要)
 *   - `personId`(透传;agent 主语无归属 → 回落主用户占位 id)
 *   - `lastSeenAtMs → lastMentionedAtMs`
 * memory 无 `dueAtMs` / `personName` 数据 → **省略**这两个可选位(候选源 scoreThread 在无 dueAtMs 时
 * 走新鲜度窗,行为正确)。
 */
function recordToOpenThread(rec: MemoryRecord): OpenThread {
  return {
    id: String(rec.id),
    topic: rec.text,
    personId: rec.personId ?? DEFAULT_PRESENCE_PERSON_ID,
    lastMentionedAtMs: rec.lastSeenAtMs,
  };
}

/**
 * open-thread 端口适配:`listOpenThreads()` 调 `store.openThreads(limit)` 并映射。
 * `store.openThreads` 本身已优雅降级(失败返回 []);本适配再包一层 try 兜底,绝不抛(§3.2)。
 */
export function createOpenThreadPort(store: OpenThreadStore, limit?: number): OpenThreadPort {
  return {
    async listOpenThreads(): Promise<OpenThread[]> {
      try {
        const rows = limit === undefined ? store.openThreads() : store.openThreads(limit);
        return rows.map(recordToOpenThread);
      } catch {
        return []; // 读失败:候选回路不中断(§3.2)
      }
    },
  };
}

/** {@link createPresencePort} 入参:注入时钟(确定性测试);缺省 systemClock。 */
export interface PresencePortOptions {
  readonly clock?: Clock;
}

/** 装配层在场适配:除满足 {@link PresencePort} 外,额外暴露 `markActive()` 供总线/输入回合刷新在场。 */
export interface ManagedPresencePort extends PresencePort {
  /** 用户活跃(开口 / 文字输入)时调用:刷新 lastActive 并轮转 episode(once-per-episode 去重键)。 */
  markActive(): void;
}

/**
 * 在场端口适配(**最小可用,带取舍说明**):
 *
 * memory **没有「用户上次活跃于何时」的真相源**(`MemoryStore` 无 lastActive;`people` 表的
 * relationship_state 只记亲密度,不逐次记互动时间戳)。因此这里不强行从 memory 反推,而是在
 * **装配层维护一个进程内在场近似**:
 *   - `lastUserActiveAtMs`:构造时取「现在」;`markActive()` 由总线用户语音终稿 / 文字输入回合刷新。
 *   - `currentEpisodeId()`:用「上次活跃时刻」作 episode 键——同一段连续空闲内不变,用户再次活跃
 *     (markActive)即轮转为新值,满足 idle 情绪弧的 once-per-episode 去重语义。
 *
 * 未来若引入真在场源(presence 服务 / 总线在场事件),**替换本适配即可**,autonomy 与候选源零改(§3.1)。
 * 任何读取不抛(§3.2)。
 */
export function createPresencePort(options?: PresencePortOptions): ManagedPresencePort {
  const clock = options?.clock ?? systemClock;
  let lastUserActiveAtMs = clock.now();
  return {
    lastUserActiveAtMs(): number {
      return lastUserActiveAtMs;
    },
    currentEpisodeId(): string {
      // 同一活跃点内稳定;markActive 轮转 → 新 episode(once-per-episode 去重键)。
      return `idle:${lastUserActiveAtMs}`;
    },
    markActive(): void {
      lastUserActiveAtMs = clock.now();
    },
  };
}

/** {@link createCompanionCandidateSource} 入参。 */
export interface CompanionCandidateSourceDeps {
  /** 未了话题来源(memory)。 */
  readonly store: OpenThreadStore;
  /** idle 情绪弧的在场来源(装配层近似)。 */
  readonly presence: PresencePort;
  /** 注入时钟(确定性测试);缺省 systemClock。 */
  readonly clock?: Clock;
  /** open-thread 取数上限(透传 store.openThreads;省略用 memory 配置默认)。 */
  readonly openThreadLimit?: number;
}

/**
 * 伴侣真候选源(缝 3):合并「未了话题跟进」+「idle 想念弧」两源喂主动决策回路(§7)。
 * 候选只是**喂料**——决策 LLM 仍是唯一「是否值得说」裁决(schema/概率闸/退 silent/落 trace 全不变);
 * combined 源已隔离单源抛错(§3.2)。仅 autonomy on 时构造(off 零开销)。
 */
export function createCompanionCandidateSource(
  deps: CompanionCandidateSourceDeps,
): ProactiveCandidateSource {
  const clock = deps.clock ?? systemClock;
  const openThreadPort = createOpenThreadPort(deps.store, deps.openThreadLimit);
  return combinedCandidateSource([
    openThreadCandidateSource(openThreadPort, clock),
    idleArcCandidateSource(deps.presence, clock),
  ]);
}
