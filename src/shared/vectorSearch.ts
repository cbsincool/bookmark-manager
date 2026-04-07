export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface VectorCandidate {
  readonly id: string;
  readonly vector: Float32Array;
}

export interface ScoredCandidate {
  readonly id: string;
  readonly similarity: number;
}

export function findTopK(
  query: Float32Array,
  candidates: readonly VectorCandidate[],
  k: number,
): ScoredCandidate[] {
  const scored = candidates.map((c) => ({
    id: c.id,
    similarity: cosineSimilarity(query, c.vector),
  }));
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, k);
}

export interface SimilarityItem {
  readonly id: string;
  readonly vector: Float32Array;
  readonly score: number;
}

export function groupBySimilarity(
  items: readonly SimilarityItem[],
  threshold: number,
): SimilarityItem[][] {
  const used = new Set<number>();
  const groups: SimilarityItem[][] = [];

  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const group: SimilarityItem[] = [items[i]];
    used.add(i);

    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
      const sim = cosineSimilarity(items[i].vector, items[j].vector);
      if (sim >= threshold) {
        group.push(items[j]);
        used.add(j);
      }
    }

    groups.push(group);
  }

  return groups;
}
