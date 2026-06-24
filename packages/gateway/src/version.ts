/**
 * gateway 协议版本协商(承 §8):大脑兼容**当前 + 前一次**版本,过旧明确拒绝。
 *
 * 当前 gateway 线协议版本独立于 `protocol` 的 `PROTOCOL_VERSION`(信封 schema 版本):
 * 二者可各自演进。本 change 首版二者同为 `0.1.0`;`COMPATIBLE_PROTOCOL_VERSIONS` 列大脑接受集
 * (current + current-1),新增版本时只追加,旧版淘汰时从尾部移除(数据迁移纪律,留前 1 次兼容窗)。
 */

/** gateway 线协议当前版本(终端 hello 声明、大脑回执携带)。 */
export const GATEWAY_PROTOCOL_VERSION = '0.1.0';

/** 大脑接受的版本集合(current + 前 1 次;首版只有 current)。 */
export const COMPATIBLE_PROTOCOL_VERSIONS: readonly string[] = [GATEWAY_PROTOCOL_VERSION];

/** 终端声明的版本是否被大脑接受(兼容窗内)。 */
export function isCompatibleVersion(version: string): boolean {
  return COMPATIBLE_PROTOCOL_VERSIONS.includes(version);
}
