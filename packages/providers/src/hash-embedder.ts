import type { Embedder } from './embedder';

export interface HashEmbedderOptions {
  /** 向量维度(默认 384,对齐调研的轻量本地嵌入档 FastEmbed 384 维)。 */
  readonly dimension?: number;
}

/**
 * 确定性 Hash Embedder(承 §5.7 "Hash 仅离线兜底" + 调研 Nexus `local-hash-v1` 范式)。
 *
 * 用途:无依赖、可复现的离线兜底 + 单测桩(对应 FakeLlm 在 LLM 侧的角色)。
 * **不是**真语义嵌入——同义词/联想能力为零,退化是噪声而非"人味"(§5.9 戒律);
 * 仅在无网络/无本地模型时保住"可跑通"的最低保真。
 *
 * 算法(零依赖、纯函数):
 * - 按 unicode 码点切 token,对每个 token 用 FNV-1a 32 位哈希定位到一个维度并累加权重;
 * - 同输入 → 同向量(确定性);不同输入 → 极大概率不同向量;
 * - 末尾做 L2 归一化(余弦相似度友好,与向量库召回口径一致)。
 */
export class HashEmbedder implements Embedder {
  readonly id = 'hash';
  readonly name = 'local-hash-v1';
  readonly dimension: number;

  constructor(opts: HashEmbedderOptions = {}) {
    const dim = opts.dimension ?? 384;
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error(`hash embedder dimension 必须为正整数,收到 ${dim}`);
    }
    this.dimension = dim;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => this.#embedOne(t));
  }

  /** 单段文本 → 归一化向量(确定性)。 */
  #embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimension).fill(0);
    for (const token of tokenize(text)) {
      const h = fnv1a32(token);
      // 用哈希低位定维度,高位定符号(+1/-1),让向量有正负、分布更均匀。
      const idx = h % this.dimension;
      const sign = (h & 0x80000000) !== 0 ? -1 : 1;
      const slot = vec[idx];
      if (slot !== undefined) vec[idx] = slot + sign;
    }
    return l2normalize(vec);
  }
}

/** 按 unicode 码点切 token:CJK 单字成 token,连续 ASCII 字母数字成词(简单稳定即可)。 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let word = '';
  for (const ch of text.toLowerCase()) {
    const code = ch.codePointAt(0) ?? 0;
    const isAsciiWord = (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
    if (isAsciiWord) {
      word += ch;
      continue;
    }
    if (word) {
      tokens.push(word);
      word = '';
    }
    // 非空白的非 ASCII 字符(如 CJK)单独成 token。
    if (ch.trim()) tokens.push(ch);
  }
  if (word) tokens.push(word);
  return tokens;
}

/** FNV-1a 32 位哈希(无符号);零依赖、确定性。 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV prime 32:用 Math.imul 做 32 位乘法,>>> 0 转回无符号。
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** L2 归一化;全零向量原样返回(避免除零)。 */
function l2normalize(vec: number[]): number[] {
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  if (sumSq === 0) return vec;
  const norm = Math.sqrt(sumSq);
  return vec.map((v) => v / norm);
}
