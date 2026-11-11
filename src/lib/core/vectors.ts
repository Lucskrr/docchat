/**
 * Utilidades de vetores para a busca semântica.
 *
 * Os embeddings são guardados no DynamoDB como binário Float32 (4 bytes por dimensão):
 * 768 dimensões ocupam 3 KB, contra ~15 KB como lista de números.
 */
export function encodeVector(values: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(values).buffer);
}

export function decodeVector(bytes: Uint8Array): Float32Array {
  // Copia para um buffer alinhado: o Uint8Array recebido pode ser uma fatia de um buffer maior.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error(`dimensões diferentes: ${a.length} x ${b.length}`);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface Scored<T> {
  item: T;
  score: number;
}

/** Retorna os k itens mais parecidos com a consulta, do maior para o menor score. */
export function topK<T>(
  query: ArrayLike<number>,
  items: T[],
  getVector: (item: T) => ArrayLike<number>,
  k: number,
  minScore = 0,
): Scored<T>[] {
  return items
    .map((item) => ({ item, score: cosineSimilarity(query, getVector(item)) }))
    .filter((s) => s.score >= minScore)
    .sort((x, y) => y.score - x.score)
    .slice(0, k);
}
