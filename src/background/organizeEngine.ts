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

/**
 * 分层聚类：先分一级目录，再在每个一级目录内部细分一层。
 *
 * 单层 K-means 的簇数只能靠书签总数猜，猜出来的粒度很粗——1643 条书签给 18 个
 * 目录，每目录 91 条。这里改为按「目标每目录条数」反推簇数，并在大类内再切一刀，
 * 使叶子目录落在目标区间内。层级由代码确定，不依赖模型遵守 prompt。
 */
export interface HierarchicalCluster {
  readonly top: SemanticCluster;
  /** 二级簇。为空表示这个大类不再细分（成员本来就不多） */
  readonly children: readonly SemanticCluster[];
}

export function buildHierarchicalClusters(
  vectors: readonly { id: string; vector: Float32Array }[],
  bookmarks: readonly BookmarkNode[],
  options?: { targetPerDir?: number; maxTop?: number; maxSub?: number },
): HierarchicalCluster[] {
  const target = options?.targetPerDir ?? TARGET_BOOKMARKS_PER_DIR;
  const maxTop = options?.maxTop ?? MAX_TOP_CLUSTERS;
  const maxSub = options?.maxSub ?? MAX_SUB_CLUSTERS;

  const n = vectors.length;
  if (n === 0) return [];

  const k1 = Math.max(2, Math.min(maxTop, Math.round(Math.sqrt(n / target))));
  const tops = buildSemanticClusters(vectors, bookmarks, k1, { minClusterSize: 1 });
  if (tops.length === 0) return [];

  const vectorById = new Map(vectors.map((v) => [v.id, v.vector]));

  return tops.map((top) => {
    const memberVectors = top.bookmarkIds
      .map((id) => ({ id, vector: vectorById.get(id) }))
      .filter((v): v is { id: string; vector: Float32Array } => v.vector !== undefined);

    const k2 = Math.max(0, Math.min(maxSub, Math.round(memberVectors.length / target)));
    if (k2 < 2) return { top, children: [] };

    const subs = buildSemanticClusters(memberVectors, bookmarks, k2, { minClusterSize: 1 });
    // 只分出一个子簇等于没分
    return { top, children: subs.length >= 2 ? subs : [] };
  });
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

/** 成员向量的均值，作为目录中心 */
export function averageVectors(vectors: readonly Float32Array[]): Float32Array {
  const dim = vectors[0]?.length ?? 0;
  const avg = new Float32Array(dim);
  let used = 0;

  for (const v of vectors) {
    if (v.length !== dim) continue; // 维度不一致的陈旧向量直接跳过
    for (let d = 0; d < dim; d++) avg[d] += v[d];
    used++;
  }

  if (used > 0) {
    for (let d = 0; d < dim; d++) avg[d] /= used;
  }
  return avg;
}

/**
 * 以**现有目录结构**为骨架。
 *
 * 这是「重复整理安全」的关键。若骨架来自每次重新聚类，连目标目录本身都会变，
 * 书签必然被大规模搬动——原来的「已归类标记」只是给这个不稳定性打的补丁。
 * 改用现有目录做骨架后：归得对的书签自然匹配到自己所在的目录，移动变成空操作；
 * 归错的才会匹配到别的目录从而被移走。「正确的不动、错误的被纠正」是结构上
 * 必然成立的，不靠任何记账。
 *
 * 空目录与还没有向量的目录直接跳过（它们没法参与相似度比对）。
 */
export function buildSkeletonFromFolders(
  folders: readonly { readonly path: string; readonly bookmarkIds: readonly string[] }[],
  vectorMap: ReadonlyMap<string, Float32Array>,
): SkeletonNode[] {
  const nodes: SkeletonNode[] = [];

  for (const folder of folders) {
    const vectors = folder.bookmarkIds
      .map((id) => vectorMap.get(id))
      .filter((v): v is Float32Array => v !== undefined);
    if (vectors.length === 0) continue;

    nodes.push({
      path: folder.path,
      memberIds: folder.bookmarkIds,
      centroid: averageVectors(vectors),
      isOverflow: false,
    });
  }

  return nodes;
}

/**
 * 按路径合并骨架节点。
 *
 * 路径重复会让 `bucketize` 把同一个桶产出两次，于是同一批书签被写进多个目录、
 * 统计口径直接翻倍（实测「成员 76 / 去重后 40」）。重复的来源有两个：
 * 分层命名时两个子类拿到同一个名字；Chrome 允许同级出现同名文件夹。
 */
export function mergeSkeletonByPath(nodes: readonly SkeletonNode[]): SkeletonNode[] {
  const byPath = new Map<string, { memberIds: string[]; centroids: Float32Array[]; isOverflow: boolean }>();

  for (const node of nodes) {
    const entry = byPath.get(node.path) ?? { memberIds: [], centroids: [], isOverflow: node.isOverflow };
    entry.memberIds.push(...node.memberIds);
    entry.centroids.push(node.centroid);
    byPath.set(node.path, entry);
  }

  return Array.from(byPath.entries()).map(([path, entry]) => ({
    path,
    memberIds: entry.memberIds,
    centroid: averageVectors(entry.centroids),
    isOverflow: entry.isOverflow,
  }));
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
 * 用户要的行为是「内容不同的网页，重新生成一个文件夹放进去」。这里用两道闸门收敛：
 *   ① 二次聚类的簇数有硬上限（`maxNewDirectories`）
 *   ② 凝聚度低于 `OVERFLOW_COHESION_MIN` 的簇视为硬凑，**拆成单条各自成组**
 * 最终组数超上限时按规模降序保留，落选的条目由调用方并入「未分类」。
 *
 * 「拆成单条」而不是「整簇丢弃」，是为了让行为单调可解释：簇内本来就不相关，
 * 每条各占一个目录正是「内容不同就新建目录」的字面含义。此前对单条簇开豁免、
 * 对两条簇做凝聚度解散，导致「1 条建目录、2 条反而不建」——数量多了结果反而更差。
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

      // 单条簇没有凝聚度可言（computeDirectoryCohesion 对 <2 条返回 1.0），
      // 统一走同一条判断，避免再出现「规模不同、规则不同」
      const cohesion = computeDirectoryCohesion(ids.map((id) => byId.get(id)!.vector));
      if (cohesion < OVERFLOW_COHESION_MIN) {
        for (const id of ids) groups.push([id]);
        continue;
      }
      groups.push(ids);
    }
  }

  return groups;
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
    tree[UNCLASSIFIED_DIR] = [...(tree[UNCLASSIFIED_DIR] ?? []), ...unassignedIds];
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
