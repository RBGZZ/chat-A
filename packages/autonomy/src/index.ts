/**
 * `@chat-a/autonomy` —— 后台自主引擎(承 canonical §7)。
 *
 * 地基引擎(fake 时钟/事件源驱动测试,确定性内核可写 golden):
 * - 优先级事件队列(单消费者、高优先级先出、同级 FIFO)。
 * - SkillScheduler + BaseSkill 接缝(单循环 reconcile、enabled 现读、生命周期、inflight 锁、异常隔离)。
 * - requestSpeak 输出仲裁(单一 is_speaking 硬闸 + 优先级抢占)。
 * - no-action 预算节流(扣减 + 合成"再想一次" + 外部重置清空自言自语)。
 *
 * 接线层(autonomy-runtime-wiring,承 §7 / §3.1 / §8.1):
 * - 决策 LLM(silent|speak|idle):schema 约束边界调用 + 衰减概率闸 + persona guardrail,失败退 silent。
 * - ProactiveTurnRunner:候选 → 决策 LLM → `Arbiter.requestSpeak`(注入闭包,不 import VoiceLoop)。
 * - 决策 trace 接缝(`AutonomyDecisionSink`):每决策落 §8.1(接线层提供 SQLite 实现)。
 * - signal:* 适配器:经 A 层总线消费感知/计时信号入队(与 external-interaction-mvp 契约对齐)。
 * - `CHAT_A_AUTONOMY=on|off`(缺省 off):关闭时接线层不挂调度,VoiceLoop 行为逐字不变。
 *
 * 默认全关、可配。
 */
export * from './types';
export * from './config';
export * from './priority-queue';
export * from './skill';
export * from './scheduler';
export * from './arbiter';
export * from './budget';
export * from './open-thread';
export * from './open-thread-skill';
export * from './idle-emotion-arc';
export * from './idle-emotion-arc-skill';
export * from './decision-trace';
export * from './decision-llm';
export * from './proactive-turn';
export * from './candidate-source';
export * from './signal-adapter';
