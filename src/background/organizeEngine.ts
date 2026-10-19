import type { BookmarkNode, DomainCluster, OrganizeStats } from '@/shared/types';
import { extractDomain } from '@/shared/urlUtils';
import { suggestDirectoryName } from '@/shared/directoryNaming';
import { cosineSimilarity } from '@/shared/vectorSearch';
import {
  ASSIGN_ACCEPT_THRESHOLD,
  OVERFLOW_ACCEPT_RATIO,
  OVERFLOW_COHESION_MIN,
  maxNewDirectories,
  UNCLASSIFIED_DIR,
  TARGET_BOOKMARKS_PER_DIR,
  TOP_LEVEL_DIVISOR,
  MAX_LEAF_SIZE,
  MIN_SPLITTABLE_SIZE,
  MAX_TOP_CLUSTERS,
  MAX_SUB_CLUSTERS,
} from '@/shared/constants';

/**
 * 判断某个 URL 是否为「官网门户」——根域名页（https://react.dev/）或 index 页。
 * 这类页面是该站点的入口，不含具体主题内容。
 */
export function isPortalUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (!u.protocol.startsWith('http')) return false;
    const pathParts = u.pathname.split('/').filter(Boolean);
    if (pathParts.length === 0) return true;
    // /index.html, /index.php, /index.htm, /index.asp, etc. are equivalent to root
    if (pathParts.length === 1 && /^index\.(html?|php|aspx?|jsp)$/i.test(pathParts[0])) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Build domain clusters from bookmarks.
 * When minCount=1, returns ALL domains (user selects which to use as directories).
 *
 * 门户页不再是独立步骤，而是作为域名簇的一个属性：选中该域名时，
 * 其根页/索引页一并归入该域名的目录。
 */
export function buildDomainClusters(
  bookmarks: readonly BookmarkNode[],
  minCount: number,
  rootPath = '',
): DomainCluster[] {
  const domainMap = new Map<string, BookmarkNode[]>();

  for (const bm of bookmarks) {
    const domain = extractDomain(bm.url);
    const existing = domainMap.get(domain);
    if (existing) {
      existing.push(bm);
    } else {
      domainMap.set(domain, [bm]);
    }
  }

  return Array.from(domainMap.entries())
    .filter(([_, items]) => items.length >= minCount)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([domain, items]) => ({
      domain,
      count: items.length,
      bookmarkIds: items.map((bm) => bm.id),
      suggestedFolderName: suggestFolderName(domain),
      hasPortal: items.some((bm) => isPortalUrl(bm.url)),
      existingFolder: filedUnderFolder(items, rootPath, suggestFolderName(domain)),
      selected: false,
    }));
}

/**
 * 该域名的书签若已全部收在「名字与目录名对应」的那个目录里，返回它的路径。
 *
 * 判据是「集中在**对应的**目录里」，不是「集中在同一个目录里」——
 * 后者会把「全塞在『杂项』这种大杂烩目录」也算成已归位，而那恰恰最需要整理。
 * 散在书签栏根下（rootPath）同样不算。
 */
function filedUnderFolder(
  items: readonly BookmarkNode[],
  rootPath: string,
  folderName: string,
): string | undefined {
  const parents = new Set(items.map((bm) => bm.path));
  if (parents.size !== 1) return undefined;

  const [only] = parents;
  if (!only || only === rootPath) return undefined;

  const leaf = only.split('/').pop() ?? '';
  return leaf.toLowerCase() === folderName.toLowerCase() ? only : undefined;
}

function suggestFolderName(domain: string): string {
  const name = domain
    .replace(/^(www|docs|blog|api|dev)\./i, '')
    .replace(/\.(com|org|net|io|dev|co)$/i, '');

  return name.charAt(0).toUpperCase() + name.slice(1);
}

// --- K-means ---

export interface SemanticCluster {
  readonly topicName: string;
  readonly bookmarkIds: string[];
  /** 簇中心（成员均值），归位阶段用它算余弦 */
  readonly centroid: Float32Array;
}

interface KMeansResult {
  readonly assignments: readonly number[];
  readonly centroids: readonly Float32Array[];
}

/** 出现次数最多的向量维度——陈旧的少数派向量（迁移前的 384 维）由此被识别出来 */
function modalDimension(vectors: readonly { vector: Float32Array }[]): number {
  const counts = new Map<number, number>();
  for (const v of vectors) counts.set(v.vector.length, (counts.get(v.vector.length) ?? 0) + 1);

  let best = vectors[0].vector.length;
  let bestCount = -1;
  for (const [dim, count] of counts) {
    if (count > bestCount) {
      best = dim;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 确定性 K-means：首质心取离全局均值最远的点，其余取离已有质心最远的点。
 *
 * 原来的首质心用的是 `Math.random()`——同一份书签两次整理会得到不同结果，
 * 端到端测试无法复现，也让「同样的输入为什么结果变了」无从排查。
 *
 * @returns 样本不足以分成 k 簇时返回 null；维度不一致的向量在 `assignments`
 *          里标为 -1（既不进任何簇，也不参与质心计算）
 */
function runKMeans(
  vectors: readonly { vector: Float32Array }[],
  k: number,
): KMeansResult | null {
  const n = vectors.length;
  if (n === 0 || n < k) return null;

  // 维度不一致的向量必须排除：质心若落在少数派的维度上，其余点算欧氏距离会读到
  // undefined 得到 NaN，而 `NaN < minDist` 恒为 false —— 所有点都会落进第 0 簇，
  // 聚类结果与内容完全无关。索引里混有迁移前的 384 维向量时就会这样。
  const dim = modalDimension(vectors);
  const usable = vectors.map((_, i) => i).filter((i) => vectors[i].vector.length === dim);
  if (usable.length < k) return null;

  const mean = new Float32Array(dim);
  for (const i of usable) {
    const v = vectors[i].vector;
    for (let d = 0; d < dim; d++) mean[d] += v[d];
  }
  for (let d = 0; d < dim; d++) mean[d] /= usable.length;

  const centroids: Float32Array[] = [];
  const usedIndices = new Set<number>();

  let farthestIdx = usable[0];
  let farthestDist = -1;
  for (const i of usable) {
    const dist = euclideanDistance(vectors[i].vector, mean);
    if (dist > farthestDist) {
      farthestDist = dist;
      farthestIdx = i;
    }
  }
  centroids.push(new Float32Array(vectors[farthestIdx].vector));
  usedIndices.add(farthestIdx);

  while (centroids.length < k) {
    let maxDist = -1;
    let bestIdx = usable[0];
    for (const i of usable) {
      if (usedIndices.has(i)) continue;
      let minDistToCentroid = Infinity;
      for (const centroid of centroids) {
        minDistToCentroid = Math.min(
          minDistToCentroid,
          euclideanDistance(vectors[i].vector, centroid),
        );
      }
      if (minDistToCentroid > maxDist) {
        maxDist = minDistToCentroid;
        bestIdx = i;
      }
    }
    centroids.push(new Float32Array(vectors[bestIdx].vector));
    usedIndices.add(bestIdx);
  }

  const maxIter = 20;
  const assignments = new Array<number>(n).fill(-1);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (const i of usable) {
      let minDist = Infinity;
      let bestCluster = 0;
      for (let c = 0; c < k; c++) {
        const dist = euclideanDistance(vectors[i].vector, centroids[c]);
        if (dist < minDist) {
          minDist = dist;
          bestCluster = c;
        }
      }
      if (assignments[i] !== bestCluster) {
        assignments[i] = bestCluster;
        changed = true;
      }
    }

    // 分配不再变化就没有必要继续：n=5000 / k=30 / 1024 维固定跑满 20 轮是
    // 约 3e9 次浮点距离运算，会在 MV3 service worker 里长时间占满线程
    if (!changed && iter > 0) break;

    const counts = new Int32Array(k);
    for (let c = 0; c < k; c++) centroids[c].fill(0);

    for (const i of usable) {
      const c = assignments[i];
      const v = vectors[i].vector;
      for (let d = 0; d < dim; d++) centroids[c][d] += v[d];
      counts[c]++;
    }

    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        for (let d = 0; d < dim; d++) centroids[c][d] /= counts[c];
      }
    }
  }

  return { assignments, centroids };
}

/**
 * Semantic clustering using K-means on embeddings.
 * Returns suggested topic categories based on content similarity
 */
export function buildSemanticClusters(
  vectors: readonly { id: string; vector: Float32Array }[],
  bookmarks: readonly BookmarkNode[],
  k: number,
  options?: { minClusterSize?: number },
): SemanticCluster[] {
  const minClusterSize = options?.minClusterSize ?? 3;
  const result = runKMeans(vectors, k);
  if (!result) return [];

  const { assignments, centroids } = result;
  const titleById = new Map(bookmarks.map((b) => [b.id, b.title]));

  const clusters: SemanticCluster[] = [];
  for (let c = 0; c < k; c++) {
    const bookmarkIds = vectors.filter((_, i) => assignments[i] === c).map((v) => v.id);
    if (bookmarkIds.length < minClusterSize) continue;

    const titles = bookmarkIds.map((id) => titleById.get(id) ?? '').filter(Boolean);
    clusters.push({
      topicName: suggestDirectoryName(titles),
      bookmarkIds,
      centroid: centroids[c],
    });
  }

  return clusters;
}

function euclideanDistance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

export function mergeDirectoryTree(
  entries: readonly { path: string; ids: readonly string[] }[],
  unassignedIds: readonly string[],
  unclassifiedPath: string = UNCLASSIFIED_DIR,
): Record<string, string[]> {
  const tree: Record<string, string[]> = {};

  for (const { path, ids } of entries) {
    if (ids.length === 0) continue;
    tree[path] = [...(tree[path] ?? []), ...ids];
  }

  if (unassignedIds.length > 0) {
    tree[unclassifiedPath] = [...(tree[unclassifiedPath] ?? []), ...unassignedIds];
  }

  return tree;
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
