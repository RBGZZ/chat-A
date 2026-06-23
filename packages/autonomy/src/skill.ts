/**
 * BaseSkill 接缝(承 §7 / neuro-ecosystem-findings §5「通用 SkillScheduler + BaseSkill 框架」)。
 *
 * autonomy 不做单一 Monologue 循环,而是**可插拔后台技能**(主动跟进/反对/情绪姿态/
 * 夜间沉淀各一 skill)。本切片只定义接缝 + 调度地基,**不实现任何具体技能**
 * (那是后续切片;那些技能要调 LLM/记忆,本期 standalone 不接)。
 *
 * 生命周期钩子(均**可选**、可返回 Promise):
 * - `initialize`:技能首次被启用前恰调一次(一次性建资源)。
 * - `start`:每次从"未启动"转为"启动"时调(可多次:被 stop 后再启用会再 start)。
 * - `tick`:启用期间每个调度 tick 调一次(技能在此做后台工作 / requestSpeak)。
 * - `stop`:从"启动"转为"禁用"时调(释放/暂停)。
 * - `onConfigReload`:收到配置热更信号时调(技能各自做幂等重读,不强制重启)。
 *
 * 注:`tick` 返回 Promise 时受 per-skill inflight 锁约束(未结算则跳过下一 tick),
 * 见 `SkillScheduler`。
 */
export interface BaseSkill {
  /** 技能唯一标识(用于 enabled 现读、inflight 锁、追溯)。 */
  readonly id: string;

  initialize?(): void | Promise<void>;
  start?(): void | Promise<void>;
  tick?(): void | Promise<void>;
  stop?(): void | Promise<void>;
  onConfigReload?(): void | Promise<void>;
}
