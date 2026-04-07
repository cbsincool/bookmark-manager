import type { BookmarkNode, DomainCluster } from '@/shared/types';
import { extractDomain } from '@/shared/urlUtils';

export function buildDomainClusters(
  bookmarks: readonly BookmarkNode[],
  minCount: number,
): DomainCluster[] {
  const domainMap = new Map<string, string[]>();

  for (const bm of bookmarks) {
    const domain = extractDomain(bm.url);
    const existing = domainMap.get(domain);
    if (existing) {
      existing.push(bm.id);
    } else {
      domainMap.set(domain, [bm.id]);
    }
  }

  return Array.from(domainMap.entries())
    .filter(([_, ids]) => ids.length >= minCount)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([domain, ids]) => ({
      domain,
      count: ids.length,
      bookmarkIds: ids,
      suggestedFolderName: suggestFolderName(domain),
      selected: false,
    }));
}

function suggestFolderName(domain: string): string {
  let name = domain
    .replace(/^(www|docs|blog|api|dev)\./i, '')
    .replace(/\.(com|org|net|io|dev|co)$/i, '');

  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function computeDirectoryCohesion(
  vectors: readonly Float32Array[],
): number {
  if (vectors.length < 2) return 1.0;

  let totalSim = 0;
  let count = 0;

  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (let k = 0; k < vectors[i].length; k++) {
        dot += vectors[i][k] * vectors[j][k];
        normA += vectors[i][k] * vectors[i][k];
        normB += vectors[j][k] * vectors[j][k];
      }
      const denom = Math.sqrt(normA) * Math.sqrt(normB);
      totalSim += denom === 0 ? 0 : dot / denom;
      count++;
    }
  }

  return count === 0 ? 1.0 : totalSim / count;
}

export function computeDirectoryVector(
  vectors: readonly Float32Array[],
): Float32Array {
  if (vectors.length === 0) return new Float32Array(384);

  const dim = vectors[0].length;
  const avg = new Float32Array(dim);

  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      avg[i] += v[i];
    }
  }

  for (let i = 0; i < dim; i++) {
    avg[i] /= vectors.length;
  }

  // Normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    norm += avg[i] * avg[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      avg[i] /= norm;
    }
  }

  return avg;
}
