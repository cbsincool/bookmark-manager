import type { BookmarkNode, DomainCluster, OrganizeStats } from '@/shared/types';
import { extractDomain } from '@/shared/urlUtils';
import { suggestDirectoryName } from '@/shared/directoryNaming';
import { cosineSimilarity } from '@/shared/vectorSearch';
import {
  SKELETON_SMALL_N,
  ASSIGN_ACCEPT_THRESHOLD,
  OVERFLOW_ACCEPT_RATIO,
  OVERFLOW_COHESION_MIN,
  MIN_FRAGMENT_FOR_DIR,
  DOMAIN_FALLBACK_MIN,
  maxNewDirectories,
} from '@/shared/constants';

/**
 * Compute optimal K for K-means clustering based on bookmark count.
 * Formula: k = round(sqrt(n/5)), clamped to [2, 30].
 *
 * 少于 SKELETON_SMALL_N 条时取 k=1：否则 k=2 会切出两个各 2-3 条的簇，
 * 被最小簇长过滤后全部落进「未分类」——4~7 条书签的整理结果恒为空。
 */
export function computeOptimalK(bookmarkCount: number): number {
  if (bookmarkCount < SKELETON_SMALL_N) return 1;
  const k = Math.round(Math.sqrt(bookmarkCount / 5));
  return Math.max(2, Math.min(30, k));
}

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
      selected: false,
    }));
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

// --- 整理流程：骨架 → 归位 → 溢出 → 汇合 ---

/**
 * 骨架节点：目录路径 + 成员 + 中心向量。
 * 中心向量只在后台内部流转——`Float32Array` 过不了 `chrome.runtime.sendMessage`
 * （会被 JSON 序列化成 `{0:..,1:..}` 并丢掉 length），绝不能进 proposal。
 */
export interface SkeletonNode {
  readonly path: string;
  readonly memberIds: readonly string[];
  readonly centroid: Float32Array;
  readonly isOverflow: boolean;
}

export interface AssignmentBucket {
  readonly path: string;
  readonly ids: readonly string[];
}

export interface AssignResult {
  readonly assigned: readonly AssignmentBucket[];
  readonly overflowIds: readonly string[];
  readonly warning?: OrganizeStats['warning'];
}

interface NearestHit {
  readonly id: string;
  readonly path: string;
  readonly similarity: number;
}

function nearestSkeleton(
  vectors: readonly { id: string; vector: Float32Array }[],
  skeleton: readonly SkeletonNode[],
): NearestHit[] {
  return vectors.map(({ id, vector }) => {
    let bestPath = skeleton[0].path;
    let bestSim = -Infinity;
    for (const node of skeleton) {
      const sim = cosineSimilarity(vector, node.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestPath = node.path;
      }
    }
    return { id, path: bestPath, similarity: bestSim };
  });
}

function bucketize(
  hits: readonly NearestHit[],
  skeleton: readonly SkeletonNode[],
): AssignmentBucket[] {
  const buckets = new Map<string, string[]>(skeleton.map((s) => [s.path, []]));
  for (const hit of hits) buckets.get(hit.path)?.push(hit.id);

  return skeleton
    .map((s) => ({ path: s.path, ids: buckets.get(s.path) ?? [] }))
    .filter((b) => b.ids.length > 0);
}

/**
 * 阶段二：逐条书签与骨架目录中心比对，达标者归位，不达标者进溢出池。
 *
 * 不依赖 K-means 的簇标签——聚类只负责造出目录骨架，具体归属由逐条的
 * 余弦相似度决定（同一份骨架下新增的书签也能走这条路径）。
 */
export function assignToSkeleton(
  vectors: readonly { id: string; vector: Float32Array }[],
  skeleton: readonly SkeletonNode[],
  threshold: number = ASSIGN_ACCEPT_THRESHOLD,
): AssignResult {
  if (vectors.length === 0) return { assigned: [], overflowIds: [] };
  if (skeleton.length === 0) {
    return { assigned: [], overflowIds: vectors.map((v) => v.id) };
  }

  const hits = nearestSkeleton(vectors, skeleton);

  // 与所有目录的相似度恒为 0：`cosineSimilarity` 对维度不匹配返回 0
  // （遗留的 384 维向量混在 1024 维索引里）。此时阈值比较没有意义，全部按最近邻归位。
  if (hits.every((h) => h.similarity === 0)) {
    return { assigned: bucketize(hits, skeleton), overflowIds: [], warning: 'vector-dim-mismatch' };
  }

  const overflowIds = hits.filter((h) => h.similarity < threshold).map((h) => h.id);

  // 溢出超过六成说明阈值与这批数据不匹配，继续硬套只会得到一片「未分类」
  if (overflowIds.length / vectors.length > OVERFLOW_ACCEPT_RATIO) {
    return { assigned: bucketize(hits, skeleton), overflowIds: [], warning: 'threshold-too-high' };
  }

  return { assigned: bucketize(hits.filter((h) => h.similarity >= threshold), skeleton), overflowIds };
}

export interface OverflowItem {
  readonly id: string;
  readonly vector: Float32Array;
  readonly title: string;
  readonly domain: string;
}

export interface OverflowGroup {
  readonly ids: readonly string[];
  readonly titles: readonly string[];
}

export interface OverflowResult {
  readonly groups: readonly OverflowGroup[];
  readonly unassignedIds: readonly string[];
}

/**
 * 阶段三：为溢出的书签成组建目录。
 *
 * 用户要的行为是「内容不同的网页，重新生成一个文件夹放进去」，
 * 但逐条建目录会产生一堆只有一条书签的碎片目录。这里用四道闸门收敛：
 *   ① 二次聚类的簇数有硬上限（`maxNewDirectories`）
 *   ② 多条簇的凝聚度低于 `OVERFLOW_COHESION_MIN` 视为硬凑，解散为碎片
 *   ③ 碎片池不足 `MIN_FRAGMENT_FOR_DIR` 条就不做域名兜底
 *   ④ 碎片按域名成组，同域名少于 `DOMAIN_FALLBACK_MIN` 条的不建目录
 * 最终落选的条目由调用方并入「未分类」。
 */
export function groupOverflow(items: readonly OverflowItem[]): OverflowResult {
  if (items.length === 0) return { groups: [], unassignedIds: [] };

  const maxDirs = maxNewDirectories(items.length);
  const byId = new Map(items.map((i) => [i.id, i]));

  const candidates = clusterOverflow(items, maxDirs);

  // 超出上限的组按规模降序保留，落选的并入未分类
  const kept = [...candidates].sort((a, b) => b.length - a.length).slice(0, maxDirs);
  const accepted = new Set(kept.flat());

  return {
    groups: kept.map((ids) => ({
      ids,
      titles: ids.map((id) => byId.get(id)?.title ?? '').filter(Boolean),
    })),
    unassignedIds: items.filter((i) => !accepted.has(i.id)).map((i) => i.id),
  };
}

/** 返回候选目录分组的成员 id 列表（尚未命名） */
function clusterOverflow(items: readonly OverflowItem[], maxDirs: number): string[][] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const vectors = items.map((i) => ({ id: i.id, vector: i.vector }));
  const k = Math.max(1, Math.min(maxDirs, Math.round(Math.sqrt(items.length / 4)) || 1));

  const groups: string[][] = [];
  const result = runKMeans(vectors, k);

  if (result) {
    for (let c = 0; c < k; c++) {
      const ids = items.filter((_, i) => result.assignments[i] === c).map((i) => i.id);
      if (ids.length === 0) continue;
      // 单条成簇不判凝聚度——它本来就该单独一个目录
      if (ids.length >= 2) {
        const cohesion = computeDirectoryCohesion(ids.map((id) => byId.get(id)!.vector));
        if (cohesion < OVERFLOW_COHESION_MIN) continue;
      }
      groups.push(ids);
    }
  }

  // 被解散的成员落到碎片池，按域名兜底成组
  const grouped = new Set(groups.flat());
  const fragments = items.filter((i) => !grouped.has(i.id));
  if (fragments.length < MIN_FRAGMENT_FOR_DIR) return groups;

  const byDomain = new Map<string, string[]>();
  for (const item of fragments) {
    byDomain.set(item.domain, [...(byDomain.get(item.domain) ?? []), item.id]);
  }

  return [
    ...groups,
    ...Array.from(byDomain.values()).filter((ids) => ids.length >= DOMAIN_FALLBACK_MIN),
  ];
}

/**
 * 阶段四：骨架目录与溢出目录汇合成最终的 directoryTree。
 * 同名路径合并；空目录不产出（否则预览页会出现「未分类 (0)」）。
 */
export function mergeDirectoryTree(
  entries: readonly { path: string; ids: readonly string[] }[],
  unassignedIds: readonly string[],
): Record<string, string[]> {
  const tree: Record<string, string[]> = {};

  for (const { path, ids } of entries) {
    if (ids.length === 0) continue;
    tree[path] = [...(tree[path] ?? []), ...ids];
  }

  if (unassignedIds.length > 0) {
    tree['未分类'] = [...(tree['未分类'] ?? []), ...unassignedIds];
  }

  return tree;
}

export function computeDirectoryCohesion(
  vectors: readonly Float32Array[],
): number {
  if (vectors.length < 2) return 1.0;

  let totalSim = 0;
  let count = 0;

  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      totalSim += cosineSimilarity(vectors[i], vectors[j]);
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
