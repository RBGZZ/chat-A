// 鸭子类型假 sherpa 模块(测试夹具):导出顶层 `infer(Float32Array)->number`。
// 供 cli-voice 真路径成功用例验「能挑出推理面并注入真 SileroVadDetector / SmartTurnEouModel」。
// 不依赖任何原生库;返回首样本绝对值(确定性,概率会被工厂钳到 [0,1])。
export function infer(samples) {
  return Math.abs(samples?.[0] ?? 0);
}
