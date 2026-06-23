/**
 * Embedder 接缝(§5.7 接缝 7)——语义嵌入来源。
 *
 * 设计要点(与 LlmProvider 完全对称):
 * - 业务层只依赖此接口;换 embedder = **改 config + 重建向量索引**,召回逻辑不动(§5.7)。
 *   向量库是 SQLite 真相源的**派生、可重建**索引(§5.2),所以换模型只是重建一次性成本。
 * - `id`/`name` **仅供 trace/日志**(§8.1),业务逻辑不得据此分支。
 * - `dimension` 是**能力声明位**:记忆层据此选向量列宽(§5.5 "多宽度向量列",如 1536/1024/768/384)→
 *   换 embedder 不改 schema(强化接缝 7)。本切片只暴露声明,不接 profile/选列(后续串行步)。
 * - 失败降级位:实现内部对网络/解析失败做容错(沿用 LLM 侧错误范式);
 *   "选维度 / 换实现 / Hash 离线兜底"的编排留给上层 profile(§5.6)按需接,接口已能承接。
 */
export interface Embedder {
  /** embedder 标识(如 'openai-compat' / 'hash')——**仅供 trace/日志**,业务不得据此分支。 */
  readonly id: string;
  /** 模型/算法名(如 'bge-m3' / 'local-hash-v1')——**仅供 trace/日志**。 */
  readonly name: string;
  /**
   * 输出向量维度——**能力声明位**(§5.5/§5.7)。
   * 记忆层据此选向量列宽;换维度 = 改 config + 重建索引,召回逻辑不动。
   */
  readonly dimension: number;
  /**
   * 批量嵌入:输入 N 段文本 → 输出 N 个向量(顺序与输入一一对应,每个长度 == dimension)。
   * 批量为核心形态(嵌入热点常成批:一次召回的候选、一段对话的多条记忆)。
   * 空输入返回空数组(不发请求)。
   */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}
