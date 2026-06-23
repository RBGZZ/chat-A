import type { Embedder } from './embedder';

export interface OpenAiCompatEmbedderOptions {
  /** embedder 标识(如 'openai' / 'bge-m3' 服务)——仅供 trace/日志(§8.1)。 */
  readonly id: string;
  /** 模型串(如 'text-embedding-3-small' / 'bge-m3' / 'Qwen3-Embedding-0.6B')。 */
  readonly model: string;
  readonly apiKey: string;
  /** OpenAI 兼容端点根(如 'https://api.openai.com/v1'),末尾斜杠会被去掉。 */
  readonly baseURL: string;
  /**
   * 输出维度——**能力声明位**(§5.7)。必填:记忆层据此选向量列宽,运行时不应靠"探测一次"才知道。
   * 若服务支持 `dimensions` 入参(如 OpenAI v3 / 部分自托管),会随请求下发以裁剪到此维度。
   */
  readonly dimension: number;
}

/**
 * OpenAI 兼容 embedding Provider(POST /embeddings)。
 *
 * 覆盖云端(OpenAI 等)与本地 OpenAI 兼容服务(BGE-M3 / Qwen3-Embedding-0.6B 经 vLLM / TEI / Ollama
 * 等以 OpenAI 协议暴露)——换 baseURL + model + key + dimension 即可,系统对具体厂商无感(§5.7);
 * id/model 仅供 trace。用原生 fetch,无第三方依赖(与 OpenAiCompatLlm 对称)。
 *
 * 容错(沿用 LLM 侧错误范式):
 * - HTTP 非 2xx → 抛带 status/正文片段的 Error;
 * - 响应缺向量 / 维度不符 → 抛 Error(上层 profile 据此决定是否降级到 Hash 兜底,§5.6/§5.7)。
 */
export class OpenAiCompatEmbedder implements Embedder {
  readonly id: string;
  readonly name: string;
  readonly dimension: number;
  readonly #apiKey: string;
  readonly #baseURL: string;

  constructor(opts: OpenAiCompatEmbedderOptions) {
    if (!Number.isInteger(opts.dimension) || opts.dimension <= 0) {
      throw new Error(`openai-compat embedder dimension 必须为正整数,收到 ${opts.dimension}`);
    }
    this.id = opts.id;
    this.name = opts.model;
    this.dimension = opts.dimension;
    this.#apiKey = opts.apiKey;
    this.#baseURL = opts.baseURL.replace(/\/+$/, '');
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];

    const res = await fetch(`${this.#baseURL}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
      body: JSON.stringify({
        model: this.name,
        input: texts,
        // 显式下发目标维度:支持的服务会裁剪,不支持的会忽略(我们再在解析处校验)。
        dimensions: this.dimension,
      }),
      ...(signal ? { signal } : {}),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `${this.id} HTTP ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
      );
    }

    const data = (await res.json()) as {
      data?: ReadonlyArray<{ embedding?: readonly number[] | null; index?: number }>;
    };
    return this.#parseEmbeddings(data, texts.length);
  }

  /** 解析 /embeddings 响应:按 index 排序对齐输入,校验条数与维度(任何不符即抛,交上层降级)。 */
  #parseEmbeddings(
    data: { data?: ReadonlyArray<{ embedding?: readonly number[] | null; index?: number }> },
    expected: number,
  ): number[][] {
    const rows = data.data;
    if (!rows || rows.length !== expected) {
      throw new Error(`${this.id} embeddings 条数不符:期望 ${expected},得到 ${rows?.length ?? 0}`);
    }
    // 多数服务按输入顺序返回;为稳妥按 index 归位(缺 index 则退化为原序)。
    const out = new Array<number[] | undefined>(expected);
    rows.forEach((row, i) => {
      const at = typeof row.index === 'number' ? row.index : i;
      const emb = row.embedding;
      if (!emb || emb.length !== this.dimension) {
        throw new Error(
          `${this.id} 向量维度不符:期望 ${this.dimension},得到 ${emb?.length ?? 0}(index ${at})`,
        );
      }
      if (at < 0 || at >= expected) {
        throw new Error(`${this.id} 返回的 index 越界:${at}`);
      }
      out[at] = [...emb];
    });
    // 校验全部就位(无空洞 / 无重复 index 导致的缺项)。
    const result: number[][] = [];
    for (let i = 0; i < expected; i++) {
      const v = out[i];
      if (v === undefined) throw new Error(`${this.id} 返回缺少 index ${i} 的向量`);
      result.push(v);
    }
    return result;
  }
}
