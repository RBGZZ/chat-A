export * from './bus';
export * from './conversation';
export * from './turn-shared';
export * from './tool-calling-strategy';
export * from './frame-processor';
export * from './audio-pacer';
export * from './query-embed';
export * from './voice-loop';
export * from './backchannel-controller';
export * from './user-emotion-tag';
export * from './sentence-splitter';
export * from './sentence-aggregator';
export * from './classifier-processor';
export * from './attention';
export * from './voice-turn-state';
// §4.1 双语原生输出:把哨兵常量与显示段抽取从 cognition 透出,供 client(app.ts 装配 dualOutput/displayExtractor)
// 与 desktop(流式分流器/定型)复用同一真相源,避免各处硬编码哨兵串。
export { DUAL_OUTPUT_SENTINEL, extractDisplaySegment } from '@chat-a/cognition';
