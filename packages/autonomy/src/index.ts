/**
 * `@chat-a/autonomy` —— 后台自主引擎骨架(standalone,承 canonical §7)。
 *
 * 本切片只造**地基引擎**(fake 时钟/事件源驱动测试),**不接 Conversation/总线/runtime**:
 * - 优先级事件队列(单消费者、高优先级先出、同级 FIFO)。
 * - SkillScheduler + BaseSkill 接缝(单循环 reconcile、enabled 现读、生命周期、inflight 锁、异常隔离)。
 * - requestSpeak 输出仲裁(单一 is_speaking 硬闸 + 优先级抢占)。
 * - no-action 预算节流(扣减 + 合成"再想一次" + 外部重置清空自言自语)。
 *
 * 默认全关、可配;全确定性内核可写 golden。
 */
export * from './types';
export * from './config';
export * from './priority-queue';
export * from './skill';
export * from './scheduler';
export * from './arbiter';
export * from './budget';
