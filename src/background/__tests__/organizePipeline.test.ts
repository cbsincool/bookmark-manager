import { describe, it, expect } from 'vitest';
import {
  buildHierarchicalClusters,
  buildSemanticClusters,
  assignToSkeleton,
  mergeSkeletonByPath,
  groupOverflow,
  mergeDirectoryTree,
} from '../organizeEngine';
import type { SkeletonNode, OverflowItem } from '../organizeEngine';
import type { BookmarkNode } from '@/shared/types';
import { MAX_NEW_DIRS_CAP } from '@/shared/constants';

const vec = (...values: number[]): Float32Array => new Float32Array(values);

/** 归一化，方便按“与某方向的夹角”构造向量 */
const unit = (...values: number[]): Float32Array => {
  const norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0));
  return new Float32Array(values.map((v) => v / norm));
};

const node = (path: string, centroid: Float32Array): SkeletonNode => ({
  path,
  memberIds: [],
  centroid,
  isOverflow: false,
});

const item = (id: string, vector: Float32Array): OverflowItem => ({
  id,
  vector,
  title: id,
});

const bm = (id: string, title: string): BookmarkNode => ({
  id,
  title,
  url: 'https://example.com',
  path: '',
});

describe('buildSemanticClusters', () => {
  const vectors = [
    { id: 'a1', vector: unit(1, 0.02, 0, 0) },
    { id: 'a2', vector: unit(1, 0.01, 0, 0) },
    { id: 'a3', vector: unit(0.98, 0, 0, 0) },
    { id: 'b1', vector: unit(0, 0, 1, 0.02) },
    { id: 'b2', vector: unit(0, 0, 1, 0.01) },
    { id: 'b3', vector: unit(0, 0, 0.98, 0) },
  ];
  const bookmarks = vectors.map((v) => bm(v.id, `${v.id} 教程`));

  it('is deterministic across runs', () => {
    // 首质心原先是 Math.random()，同一份输入两次整理结果不同
    const first = buildSemanticClusters(vectors, bookmarks, 2, { minClusterSize: 1 });
    const second = buildSemanticClusters(vectors, bookmarks, 2, { minClusterSize: 1 });
    expect(second.map((c) => c.bookmarkIds)).toEqual(first.map((c) => c.bookmarkIds));
  });

  it('exposes a centroid usable for cosine comparison', () => {
    const [cluster] = buildSemanticClusters(vectors, bookmarks, 2, { minClusterSize: 1 });
    expect(cluster.centroid.length).toBe(4);
  });

  it('keeps clusters below the requested minimum size out of the result', () => {
    const clusters = buildSemanticClusters(vectors, bookmarks, 2, { minClusterSize: 99 });
    expect(clusters).toEqual([]);
  });

  it('ignores vectors whose dimension does not match the majority', () => {
    // 索引里混有迁移前的 384 维向量时：若质心落在少数派的维度上，其余点算欧氏
    // 距离会得到 NaN，而 `NaN < minDist` 恒为 false —— 全部落进第 0 簇
    const mixed = [
      { id: 'stale1', vector: vec(1, 0) },
      { id: 'a1', vector: unit(1, 0.02, 0, 0) },
      { id: 'a2', vector: unit(0.98, 0.01, 0, 0) },
      { id: 'b1', vector: unit(0, 0, 1, 0.02) },
      { id: 'b2', vector: unit(0, 0, 0.98, 0.01) },
    ];
    const clusters = buildSemanticClusters(mixed, mixed.map((v) => bm(v.id, v.id)), 2, {
      minClusterSize: 1,
    });

    const grouped = clusters.flatMap((c) => c.bookmarkIds);
    expect(grouped).not.toContain('stale1');
    expect(grouped.sort()).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(clusters).toHaveLength(2);
  });
});

describe('assignToSkeleton', () => {
  const skeleton = [node('编程', unit(1, 0, 0, 0)), node('运维', unit(0, 1, 0, 0))];

  it('assigns each bookmark to the nearest directory above the threshold', () => {
    const result = assignToSkeleton(
      [
        { id: 'v1', vector: unit(1, 0, 0, 0) },
        { id: 'v2', vector: unit(0, 1, 0, 0) },
      ],
      skeleton,
      0.55,
    );

    expect(result.overflowIds).toEqual([]);
    expect(result.assigned).toEqual([
      { path: '编程', ids: ['v1'] },
      { path: '运维', ids: ['v2'] },
    ]);
  });

  it('sends bookmarks that match no directory into the overflow pool', () => {
    const result = assignToSkeleton(
      [
        { id: 'v1', vector: unit(1, 0, 0, 0) },
        { id: 'v2', vector: unit(0, 0, 1, 0) },
      ],
      skeleton,
      0.55,
    );

    expect(result.overflowIds).toEqual(['v2']);
    expect(result.assigned).toEqual([{ path: '编程', ids: ['v1'] }]);
  });

  it('falls back to nearest-neighbour when every similarity is zero', () => {
    // 维度不一致时 cosineSimilarity 恒返回 0（遗留的 384 维向量混在 1024 维索引里）
    const mismatched = [node('编程', vec(1, 0, 0)), node('运维', vec(0, 1, 0))];
    const result = assignToSkeleton(
      [{ id: 'v1', vector: unit(1, 0, 0, 0) }],
      mismatched,
      0.55,
    );

    expect(result.warning).toBe('vector-dim-mismatch');
    expect(result.overflowIds).toEqual([]);
    expect(result.assigned[0].ids).toEqual(['v1']);
  });

  it('falls back to nearest-neighbour when almost everything overflows', () => {
    // 相似度都在 0.2~0.4，达不到 0.55 的阈值，但又不是全 0
    const below = (n: number) => unit(0.3, 0.2, 0.9, n);
    const vectors = [0, 1, 2, 3, 4].map((i) => ({ id: `v${i}`, vector: below(i * 0.001) }));
    const result = assignToSkeleton(vectors, skeleton, 0.55);

    expect(result.warning).toBe('threshold-too-high');
    expect(result.overflowIds).toEqual([]);
    expect(result.assigned.flatMap((b) => b.ids)).toHaveLength(5);
  });

  it('returns everything as overflow when the skeleton is empty', () => {
    const result = assignToSkeleton([{ id: 'v1', vector: unit(1, 0, 0, 0) }], [], 0.55);
    expect(result.overflowIds).toEqual(['v1']);
    expect(result.assigned).toEqual([]);
  });
});

describe('groupOverflow', () => {
  it('returns nothing for an empty pool', () => {
    expect(groupOverflow([])).toEqual({ groups: [], unassignedIds: [] });
  });

  it('does not create one directory per bookmark', () => {
    // 20 条互不相似的书签——逐条建目录会得到 20 个碎片目录，硬上限兜住
    const items = Array.from({ length: 20 }, (_, i) =>
      item(`v${i}`, unit(...Array.from({ length: 20 }, (_, d) => (d === i ? 1 : 0.01)))),
    );
    const result = groupOverflow(items);

    expect(result.groups.length).toBeLessThanOrEqual(MAX_NEW_DIRS_CAP);
    expect(result.groups.length).toBeLessThan(items.length);
    expect(result.groups.length + result.unassignedIds.length).toBe(items.length);
  });

  it('groups a tight cluster of bookmarks into one directory', () => {
    const items = [
      item('a1', unit(1, 0.01, 0, 0)),
      item('a2', unit(1, 0.02, 0, 0)),
      item('a3', unit(0.99, 0, 0, 0)),
      item('a4', unit(1, 0.03, 0, 0)),
    ];
    const result = groupOverflow(items);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].ids).toHaveLength(4);
    expect(result.unassignedIds).toEqual([]);
  });

  it('accounts for every input bookmark exactly once', () => {
    const items = Array.from({ length: 9 }, (_, i) =>
      item(`v${i}`, unit(...Array.from({ length: 9 }, (_, d) => (d === i ? 1 : 0.05)))),
    );
    const result = groupOverflow(items);

    const seen = [...result.groups.flatMap((g) => g.ids), ...result.unassignedIds];
    expect(seen.sort()).toEqual(items.map((i) => i.id).sort());
  });

  it('gives a lone outlier its own directory', () => {
    const result = groupOverflow([item('solo', unit(1, 0, 0, 0))]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].ids).toEqual(['solo']);
  });

  it('is monotonic: two dissimilar outliers get two directories, not zero', () => {
    // 此前 1 条会建目录、2 条反而不建（单条簇豁免 + 两条簇被凝聚度解散），
    // 数量多了结果反而更差
    const two = groupOverflow([item('x', unit(1, 0, 0, 0)), item('y', unit(0, 1, 0, 0))]);
    expect(two.groups).toHaveLength(2);
    expect(two.groups.map((g) => g.ids[0]).sort()).toEqual(['x', 'y']);
    expect(two.unassignedIds).toEqual([]);
  });

  it('keeps two similar outliers together in one directory', () => {
    const result = groupOverflow([
      item('a1', unit(1, 0.01, 0, 0)),
      item('a2', unit(1, 0.02, 0, 0)),
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].ids).toHaveLength(2);
  });

  it('carries the titles of each group through for naming', () => {
    const items = [
      item('a1', unit(1, 0.01, 0, 0)),
      item('a2', unit(1, 0.02, 0, 0)),
    ];
    const result = groupOverflow(items);
    expect([...result.groups[0].titles].sort()).toEqual(['a1', 'a2']);
  });
});

describe('mergeDirectoryTree', () => {
  it('merges entries that share a path', () => {
    const tree = mergeDirectoryTree(
      [
        { path: '编程', ids: ['a'] },
        { path: '编程', ids: ['b'] },
      ],
      [],
    );
    expect(tree).toEqual({ 编程: ['a', 'b'] });
  });

  it('drops empty directories', () => {
    const tree = mergeDirectoryTree([{ path: '空目录', ids: [] }], []);
    expect(tree).toEqual({});
  });

  it('appends unassigned bookmarks to 未分类', () => {
    const tree = mergeDirectoryTree([{ path: '编程', ids: ['a'] }], ['x', 'y']);
    expect(tree).toEqual({ 编程: ['a'], 未分类: ['x', 'y'] });
  });
});

describe('buildHierarchicalClusters', () => {
  /**
   * 造 n 条书签，落在 `topics` 个方向附近。
   *
   * 噪声不能太小：主题若完全正交，未被选作种子的主题只能靠噪声决定归属，
   * 会全部挤进同一个簇——那是合成数据的病态，真实嵌入不是这样。
   */
  function makeCorpus(n: number, topics: number) {
    const dim = topics;
    const noise = 0.35;
    const vectors = Array.from({ length: n }, (_, i) => {
      const topic = i % topics;
      // 确定性的伪随机噪声，避免测试不稳定
      const jitter = (k: number) => {
        const x = Math.sin((i + 1) * 12.9898 + k * 78.233) * 43758.5453;
        return (x - Math.floor(x) - 0.5) * 2 * noise;
      };
      const dir = Array.from({ length: dim }, (_, d) => (d === topic ? 1 : 0) + jitter(d));
      return { id: `b${i}`, vector: unit(...dir) };
    });
    return { vectors, bookmarks: vectors.map((v) => bm(v.id, `${v.id} 标题`)) };
  }

  it('keeps leaf directories near the target size instead of one big dumping ground', () => {
    // 单层聚类时 40 条书签只给 k=3，实测出现 32 条一个目录的垃圾桶
    const { vectors, bookmarks } = makeCorpus(40, 8);
    const groups = buildHierarchicalClusters(vectors, bookmarks, { targetPerDir: 12 });

    const leaves = groups.flatMap((g) =>
      g.children.length > 0 ? g.children.map((c) => c.bookmarkIds.length) : [g.top.bookmarkIds.length],
    );

    expect(leaves.length).toBeGreaterThan(2);
    expect(Math.max(...leaves)).toBeLessThanOrEqual(20);
    expect(leaves.reduce((a, b) => a + b, 0)).toBe(40);
  });

  it('does not subdivide when the sub-level is disabled', () => {
    // organizeMaxDepth=1 表示用户明确不要层级
    const { vectors, bookmarks } = makeCorpus(40, 8);
    const groups = buildHierarchicalClusters(vectors, bookmarks, { maxSub: 0 });
    expect(groups.every((g) => g.children.length === 0)).toBe(true);
  });

  it('accounts for every bookmark exactly once', () => {
    const { vectors, bookmarks } = makeCorpus(60, 6);
    const groups = buildHierarchicalClusters(vectors, bookmarks, { targetPerDir: 10 });

    const seen = groups.flatMap((g) =>
      g.children.length > 0
        ? g.children.flatMap((c) => c.bookmarkIds)
        : [...g.top.bookmarkIds],
    );
    expect(seen.sort()).toEqual(vectors.map((v) => v.id).sort());
  });

  it('returns nothing for an empty corpus', () => {
    expect(buildHierarchicalClusters([], [])).toEqual([]);
  });
});

describe('mergeSkeletonByPath', () => {
  it('merges nodes that share a path so no bucket is emitted twice', () => {
    // 分层命名时两个子类可能拿到同一个名字；Chrome 也允许同级出现同名文件夹。
    // 路径重复会让 bucketize 把同一个桶产出两次，统计口径直接翻倍
    const merged = mergeSkeletonByPath([
      node('机器学习', unit(1, 0, 0, 0)),
      node('机器学习', unit(0, 1, 0, 0)),
      node('前端', unit(0, 0, 1, 0)),
    ]);

    expect(merged.map((n) => n.path)).toEqual(['机器学习', '前端']);
    expect(merged[0].centroid.length).toBe(4);
  });

  it('never lets a bookmark be counted twice', () => {
    const skeleton = mergeSkeletonByPath([
      node('机器学习', unit(1, 0, 0, 0)),
      node('机器学习', unit(0, 1, 0, 0)),
    ]);
    const result = assignToSkeleton(
      [{ id: 'v1', vector: unit(1, 0, 0, 0) }],
      skeleton,
      0.55,
    );

    const ids = result.assigned.flatMap((b) => b.ids);
    expect(ids).toEqual([...new Set(ids)]);
  });
});
