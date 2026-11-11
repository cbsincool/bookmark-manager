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

/**
 * 公共后缀里的两段式（`com.cn`、`co.uk`…）。
 *
 * 不认出来就会把 `blog.sina.com.cn` 收敛成 `Com`——「可注册域名」是后缀**之前**那一段，
 * 后缀切错了名字就整个错位。
 */
const MULTI_PART_SUFFIXES = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'com.tw', 'com.hk',
  'co.jp', 'co.kr', 'co.uk', 'org.uk', 'ac.uk', 'com.au', 'com.sg',
  'com.br', 'co.in', 'com.mx', 'com.tr', 'com.my', 'co.nz',
]);

/**
 * 托管型后缀：每个用户各占一个子域。
 *
 * 必须当成公共后缀，否则 `foo.github.io` 和 `bar.github.io` 会被收敛成同一个
 * `Github` 目录，两个毫不相干的站点被合并。
 */
const HOSTING_SUFFIXES = new Set([
  'github.io', 'gitee.io', 'gitlab.io', 'netlify.app', 'vercel.app',
  'pages.dev', 'workers.dev', 'blogspot.com', 'wordpress.com', 'notion.site',
  'gitbook.io', 'readthedocs.io', 'herokuapp.com', 'azurewebsites.net',
  's3.amazonaws.com',
]);

/** 通用子域前缀：只是站点分区（文档/博客/移动版/语言…），不承载品牌信息 */
const GENERIC_SUBDOMAINS = new Set([
  'www', 'm', 'mp', 'mobile', 'wap', 'touch',
  'docs', 'doc', 'wiki', 'manual', 'help', 'support', 'faq',
  'blog', 'news', 'post', 'article', 'zhuanlan', 'baijiahao', 'wenku', 'pan',
  'api', 'dev', 'developer', 'developers', 'open', 'source', 'git', 'code',
  'en', 'zh', 'cn', 'ja', 'ko', 'ru', 'fr', 'de', 'es', 'pt', 'it', 'hi', 'ar',
  'app', 'web', 'my', 'go', 'get', 'try', 'start', 'learn', 'edu', 'community',
  'forum', 'bbs', 'discuss', 'club', 'group',
  'tech', 'cloud', 'static', 'cdn', 'img', 'pic', 'download', 'dl', 'mirror',
  'shop', 'store', 'mall', 'pay', 'mail', 'smtp', 'admin', 'portal', 'account',
  'login', 'sso', 'auth', 'id', 'passport', 'oa', 'erp', 'crm', 'hr',
  'status', 'monitor', 'stats', 'analytics', 'search', 'test', 'demo', 'beta',
  'staging', 'sandbox', 'old', 'new', 'v1', 'v2', 'os', 'detail', 'item', 't',
]);

function isIpAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function publicSuffixLength(labels: readonly string[]): number {
  const lastTwo = labels.slice(-2).join('.');
  const lastThree = labels.slice(-3).join('.');
  if (HOSTING_SUFFIXES.has(lastThree)) return 3;
  if (MULTI_PART_SUFFIXES.has(lastTwo) || HOSTING_SUFFIXES.has(lastTwo)) return 2;
  return 1;
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * 把域名收敛成「人会给文件夹起的名字」。
 *
 * 原实现只剥固定的 `www|docs|blog|api|dev.` 前缀和 `com|org|net|io|dev|co` 后缀，
 * 于是实测建出来的目录名是 `Zhuanlan.zhihu`、`Mp.weixin.qq`、`Wenku.baidu`、
 * `Sina.com.cn`——全是站点**分区**名，不是站点名。
 *
 * 现在先剥通用子域前缀，再取可注册域名（公共后缀之前的那一段）。
 * 副作用是同一站点的不同子域会收敛到同一个名字（`blog.csdn.net` 与 `www.csdn.net`
 * 都变成 `Csdn`），这正是想要的：它们本来就是一个站，本该进同一个目录。
 */
export function suggestFolderName(domain: string): string {
  const host = domain.trim().toLowerCase();
  if (!host) return domain;

  // 内网 IP 很常见（192.168.1.10），没有「可注册域名」可言，原样保留
  if (isIpAddress(host)) return host;

  const parts = host.split('.');
  if (parts.length <= 2) return capitalize(parts[0]);

  // 剥前缀时至少留两段，否则 zhihu.com 会被剥成 com
  let labels = parts;
  while (labels.length > 2 && GENERIC_SUBDOMAINS.has(labels[0])) {
    labels = labels.slice(1);
  }

  const index = labels.length - publicSuffixLength(labels) - 1;
  return capitalize(labels[index >= 0 ? index : 0]);
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

/**
 * 把散落在其它顶层下的某个主题，折回它自己的一级目录。
 *
 * 规则层只认标题/URL 里的关键词，没命中的同类书签会被模型放回旧子目录——
 * 实测「存储」独立成一级后，`硬件/存储` 和 `技术/存储` 仍各留了二三十条，
 * 同一个主题被劈成三处。
 *
 * 折叠规则按**末级名**决定二级：`硬件/存储/RAID` → `存储/RAID`，
 * `技术/存储` → `存储`（末级只是容器词，没有信息量）。
 */
export function foldPathsIntoTopLevel(
  tree: Record<string, readonly string[]>,
  top: string,
  hints: RegExp,
  containerNames: ReadonlySet<string>,
): { tree: Record<string, string[]>; moved: number } {
  const result: Record<string, string[]> = {};
  let moved = 0;

  for (const [path, ids] of Object.entries(tree)) {
    const parts = path.split('/');
    const alreadyThere = parts[0] === top;
    const matchIndex = parts.findIndex((part, index) => index > 0 && hints.test(part));

    if (alreadyThere || matchIndex < 0) {
      result[path] = [...(result[path] ?? []), ...ids];
      continue;
    }

    const last = parts[parts.length - 1];
    const target = containerNames.has(last) ? top : `${top}/${last}`;
    result[target] = [...(result[target] ?? []), ...ids];
    moved++;
  }

  return { tree: result, moved };
}

/**
 * 把「只装了 1 条书签」的末级目录并回上级。
 *
 * 提示词里写了「少于 3 条不要单独建目录」，但模型经常不管——实测一次全局整理
 * 留下 29 个只装 1 条的目录，收藏夹里点开一层又一层，只为看一条书签。
 * 这一步是确定性的兜底：数量不够的目录不单独存在，内容上移到最近的、**本身就在树里**
 * 的祖先；连祖先都没有就落到一级目录。
 *
 * 只处理**末级**（没有子目录挂在它下面的）路径 —— 有子目录的目录即使自己只有 1 条，
 * 它仍是那棵子树的入口，不能删。
 */
export function collapseTinyDirectories(
  tree: Record<string, readonly string[]>,
  minSize = 2,
  /**
   * 这些顶层下面的子目录不参与合并。
   *
   * 合并的本意是收拾「一个网页一个目录」，但它会把 `Linux/内核`（只有 1 条）
   * 直接并回 `Linux`——结果是书签全堆在一级目录下，等于没整理。
   * 对天生需要二级的主题，宁可留一个只有 1 条的目录。
   */
  protectedTops: ReadonlySet<string> = new Set(),
): { tree: Record<string, string[]>; collapsed: number } {
  const paths = Object.keys(tree);
  const hasChild = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) hasChild.add(parts.slice(0, i).join('/'));
  }

  const destination = (path: string): string => {
    if (!path.includes('/')) return path;
    if (hasChild.has(path)) return path;
    if (protectedTops.has(path.split('/')[0])) return path;
    if ((tree[path]?.length ?? 0) >= minSize) return path;

    const parts = path.split('/');
    for (let i = parts.length - 1; i >= 1; i--) {
      const ancestor = parts.slice(0, i).join('/');
      if (ancestor in tree) return destination(ancestor);
    }
    return parts[0];
  };

  const result: Record<string, string[]> = {};
  let collapsed = 0;
  for (const path of paths) {
    const dest = destination(path);
    if (dest !== path) collapsed++;
    result[dest] = [...(result[dest] ?? []), ...(tree[path] ?? [])];
  }

  return { tree: result, collapsed };
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

/**
 * 把某个顶层下「不该出现的通用子目录名」换成该主题自己的维度词。
 *
 * 实测 `Linux/硬件`(54)、`Linux/编程`(6)：模型把「硬件」「编程」这类
 * 通用领域词当成了 Linux 的二级——它们是别的顶层的事，放在 Linux 下
 * 既和 `Linux/驱动`、`Linux/设备管理` 重复，也让人一眼看不懂。
 */
export function remapSubNames(
  tree: Record<string, readonly string[]>,
  top: string,
  aliases: Readonly<Record<string, string>>,
): { tree: Record<string, string[]>; remapped: number } {
  const result: Record<string, string[]> = {};
  let remapped = 0;

  for (const [path, ids] of Object.entries(tree)) {
    const parts = path.split('/');
    if (parts.length === 2 && parts[0] === top && aliases[parts[1]]) {
      const target = `${top}/${aliases[parts[1]]}`;
      result[target] = [...(result[target] ?? []), ...ids];
      remapped++;
    } else {
      result[path] = [...(result[path] ?? []), ...ids];
    }
  }

  return { tree: result, remapped };
}

/**
 * 把「只有两三条书签」的一级目录并进兜底目录。
 *
 * 二次处理「其它」时允许模型新建顶层，实测它会给 2 条书签造一个「论坛」顶层——
 * 顶层目录是给「领域」用的，两三条不成领域，留在「其它」里比单独立一个更清楚。
 */
export function foldSmallTopLevels(
  tree: Record<string, readonly string[]>,
  minSize: number,
  protectedTops: ReadonlySet<string>,
  fallback: string,
): { tree: Record<string, string[]>; folded: number } {
  const totals = new Map<string, number>();
  for (const [path, ids] of Object.entries(tree)) {
    const top = path.split('/')[0];
    totals.set(top, (totals.get(top) ?? 0) + ids.length);
  }

  const result: Record<string, string[]> = {};
  let folded = 0;
  for (const [path, ids] of Object.entries(tree)) {
    const top = path.split('/')[0];
    const shouldFold = path === top
      && !protectedTops.has(top)
      && (totals.get(top) ?? 0) < minSize;

    const target = shouldFold ? fallback : path;
    if (shouldFold) folded++;
    result[target] = [...(result[target] ?? []), ...ids];
  }

  return { tree: result, folded };
}

/**
 * 把某个顶层下的二级目录名收进「允许集合」。
 *
 * 别名表只能覆盖已知的错法；模型还会时不时造出新的通用词。这里再加一道：
 * 集合外的名字先按包含关系找最接近的，找不到就进兜底目录。
 * 一级目录下面出现一眼看不懂的子目录，比「少了一个子目录」更难接受。
 */
export function normalizeSubfoldersUnderTop(
  tree: Record<string, readonly string[]>,
  top: string,
  allowed: readonly string[],
  aliases: Readonly<Record<string, string>>,
  fallback: string,
): { tree: Record<string, string[]>; renamed: number } {
  const allowedLower = allowed.map((name) => name.toLowerCase());
  const allowedSet = new Set(allowed);

  const pick = (sub: string): string | undefined => {
    if (allowedSet.has(sub)) return sub;
    const alias = aliases[sub];
    if (alias && allowedSet.has(alias)) return alias;

    const lower = sub.toLowerCase();
    for (const name of allowed) {
      const base = name.toLowerCase();
      if (lower.includes(base) || base.includes(lower)) return name;
    }
    // 别名表指向的合法名字也算
    for (const [key, value] of Object.entries(aliases)) {
      if (lower.includes(key.toLowerCase()) && allowedLower.includes(value.toLowerCase())) {
        return allowed.find((name) => name.toLowerCase() === value.toLowerCase());
      }
    }
    return undefined;
  };

  const result: Record<string, string[]> = {};
  let renamed = 0;
  for (const [path, ids] of Object.entries(tree)) {
    const parts = path.split('/');
    if (parts.length === 2 && parts[0] === top) {
      const target = pick(parts[1]) ?? fallback;
      const next = `${top}/${target}`;
      if (target !== parts[1]) renamed++;
      result[next] = [...(result[next] ?? []), ...ids];
    } else {
      result[path] = [...(result[path] ?? []), ...ids];
    }
  }

  return { tree: result, renamed };
}

/**
 * 把「嵌套了另一个一级目录」的路径提回那个一级目录。
 *
 * 实测 `技术/操作系统/Linux`、`技术/网络/RDMA`：模型把同一个领域又挂在了
 * 别的顶层下面，于是「Linux」和「网络」各出现了两处，用户点开两个地方看到同类内容。
 * 提到一级目录后，深层的段保留：`技术/网络/RDMA` → `网络/RDMA`。
 *
 * 只处理**领域型**顶层。`教程` 不在此列——教程是内容类型，`教程/网络` 是
 * 「网络相关的教程」，提走反而丢了它的语义。
 */
export function foldNestedTopLevels(
  tree: Record<string, readonly string[]>,
  domainTops: ReadonlySet<string>,
  skipTops: ReadonlySet<string> = new Set(),
): { tree: Record<string, string[]>; folded: number } {
  const result: Record<string, string[]> = {};
  let folded = 0;

  for (const [path, ids] of Object.entries(tree)) {
    const parts = path.split('/');
    // 内容类型顶层（教程）下的「网络」指的是「网络相关的教程」，不提出去
    const hit = skipTops.has(parts[0])
      ? -1
      : parts.findIndex((part, index) => index > 0 && domainTops.has(part));

    const target = hit < 0
      ? path
      : [parts[hit], ...parts.slice(hit + 1)].join('/');

    if (hit >= 0) folded++;
    result[target] = [...(result[target] ?? []), ...ids];
  }

  return { tree: result, folded };
}

/**
 * 「教程」只收纯教学，其余按领域归。
 *
 * 用户定下的规则：`教程/Python`、`教程/Agent` 这类本质上是 Python / Agent 的内容，
 * 应该待在对应领域里；教程只留跨领域的通用学习材料（学习方法、语言学习…）。
 *
 * 判据是确定的：如果该子目录名在**别的顶层**下已经有一个像样的目录（≥ minMatch 条），
 * 或者它本身就是某个一级目录名，就把书签搬过去；否则留在教程。
 * 这样 `教程/Python` → `技术/编程语言/Python`，而 `教程/OpenCV`（别处没有）保留。
 */
export function foldTutorialTopics(
  tree: Record<string, readonly string[]>,
  tutorialTop: string,
  fallbackTop: string,
  minMatch = 10,
): { tree: Record<string, string[]>; folded: number } {
  const domainTops = new Set(
    Object.keys(tree)
      .map((path) => path.split('/')[0])
      .filter((top) => top !== tutorialTop && top !== fallbackTop),
  );

  // 叶子名 → 别处最大的同名目录
  const best = new Map<string, { path: string; size: number }>();
  for (const [path, ids] of Object.entries(tree)) {
    const parts = path.split('/');
    if (parts[0] === tutorialTop || parts.length < 2) continue;
    const leaf = parts[parts.length - 1];
    const prev = best.get(leaf);
    if (!prev || ids.length > prev.size) best.set(leaf, { path, size: ids.length });
  }

  const result: Record<string, string[]> = {};
  let folded = 0;
  for (const [path, ids] of Object.entries(tree)) {
    const parts = path.split('/');
    if (parts.length === 2 && parts[0] === tutorialTop) {
      const leaf = parts[1];
      if (domainTops.has(leaf)) {
        result[leaf] = [...(result[leaf] ?? []), ...ids];
        folded++;
        continue;
      }
      const hit = best.get(leaf);
      if (hit && hit.size >= minMatch) {
        result[hit.path] = [...(result[hit.path] ?? []), ...ids];
        folded++;
        continue;
      }
    }
    result[path] = [...(result[path] ?? []), ...ids];
  }

  return { tree: result, folded };
}
