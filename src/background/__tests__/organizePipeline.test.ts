import { describe, it, expect } from 'vitest';
import { buildSemanticClusters, buildDomainClusters, mergeDirectoryTree } from '../organizeEngine';
import {
  buildBatchClassifyPrompt,
  parseBatchClassifyResponse,
  chunkItems,
} from '../aiClassifier';
import type { BookmarkNode } from '@/shared/types';

const vec = (...values: number[]): Float32Array => new Float32Array(values);

/** 归一化，方便按“与某方向的夹角”构造向量 */
const unit = (...values: number[]): Float32Array => {
  const norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0));
  return new Float32Array(values.map((v) => v / norm));
};

const bm = (id: string, title = id): BookmarkNode => ({
  id,
  title,
  url: 'https://example.com',
  path: '',
});

describe('buildSemanticClusters', () => {
  // 现在只用来**给批次排序**（把相似的书签排在一起），不再决定目录结构，
  // 所以这里只锁「确定性」和「成员不重不漏」两条契约
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
    // 首质心原先是 Math.random()，同一份输入两次结果不同，端到端无法复现
    const first = buildSemanticClusters(vectors, bookmarks, 2, { minClusterSize: 1 });
    const second = buildSemanticClusters(vectors, bookmarks, 2, { minClusterSize: 1 });
    expect(second.map((c) => c.bookmarkIds)).toEqual(first.map((c) => c.bookmarkIds));
  });

  it('accounts for every bookmark exactly once', () => {
    const clusters = buildSemanticClusters(vectors, bookmarks, 2, { minClusterSize: 1 });
    const ids = clusters.flatMap((c) => c.bookmarkIds);
    expect(ids.sort()).toEqual(vectors.map((v) => v.id).sort());
  });

  it('exposes a centroid usable for cosine comparison', () => {
    const [cluster] = buildSemanticClusters(vectors, bookmarks, 2, { minClusterSize: 1 });
    expect(cluster.centroid.length).toBe(4);
  });

  it('drops vectors whose dimension does not match the majority', () => {
    // 索引里混有迁移前的 384 维向量时：若质心落在少数派维度上，其余点算欧氏距离
    // 会得到 NaN，而 `NaN < minDist` 恒为 false —— 全部落进第 0 簇
    const mixed = [
      { id: 'stale1', vector: vec(1, 0) },
      { id: 'a1', vector: unit(1, 0.02, 0, 0) },
      { id: 'a2', vector: unit(0.98, 0.01, 0, 0) },
      { id: 'b1', vector: unit(0, 0, 1, 0.02) },
      { id: 'b2', vector: unit(0, 0, 0.98, 0.01) },
    ];
    const clusters = buildSemanticClusters(mixed, mixed.map((v) => bm(v.id)), 2, {
      minClusterSize: 1,
    });

    const grouped = clusters.flatMap((c) => c.bookmarkIds);
    expect(grouped).not.toContain('stale1');
    expect(grouped.sort()).toEqual(['a1', 'a2', 'b1', 'b2']);
  });
});

describe('buildDomainClusters — existingFolder', () => {
  const withPath = (id: string, url: string, path: string): BookmarkNode => ({
    id, title: id, url, path,
  });

  it('reports the folder when every bookmark of a domain sits in the matching one', () => {
    // 用于在向导里标出「这个域名已经归好位了，不用再选」
    const clusters = buildDomainClusters(
      [
        withPath('a', 'https://react.dev/1', '书签栏/React'),
        withPath('b', 'https://react.dev/2', '书签栏/React'),
      ],
      1,
      '书签栏',
    );

    expect(clusters[0].existingFolder).toBe('书签栏/React');
  });

  it('does not treat bookmarks loose in the bookmark bar as organized', () => {
    const clusters = buildDomainClusters(
      [withPath('a', 'https://react.dev/1', '书签栏'), withPath('b', 'https://react.dev/2', '书签栏')],
      1,
      '书签栏',
    );

    expect(clusters[0].existingFolder).toBeUndefined();
  });

  it('does not call a catch-all folder "organized" just because everything sits there', () => {
    // 「全塞在同一个目录里」不等于已归位：全堆在「杂项」这种大杂烩目录里
    // 恰恰最需要整理。判据必须是「收在**对应的**目录里」。
    const clusters = buildDomainClusters(
      [
        withPath('a', 'https://react.dev/1', '书签栏/杂项'),
        withPath('b', 'https://react.dev/2', '书签栏/杂项'),
      ],
      1,
      '书签栏',
    );

    expect(clusters[0].suggestedFolderName).toBe('React');
    expect(clusters[0].existingFolder).toBeUndefined();
  });

  it('matches a nested folder by its leaf name', () => {
    const clusters = buildDomainClusters(
      [withPath('a', 'https://react.dev/1', '书签栏/前端/React')],
      1,
      '书签栏',
    );

    expect(clusters[0].existingFolder).toBe('书签栏/前端/React');
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

  it('appends unassigned bookmarks to the unclassified path', () => {
    const tree = mergeDirectoryTree([{ path: '编程', ids: ['a'] }], ['x', 'y']);
    expect(tree).toEqual({ 编程: ['a'], 未分类: ['x', 'y'] });
  });

  it('honours a custom unclassified path (文件夹整理时要留在该文件夹内部)', () => {
    const tree = mergeDirectoryTree([], ['x'], '工作/未分类');
    expect(tree).toEqual({ '工作/未分类': ['x'] });
  });
});

describe('buildBatchClassifyPrompt', () => {
  const items = [{ id: '1', title: 'React Hooks 教程', url: 'https://react.dev/hooks' }];

  it('lists existing directories as preferred targets', () => {
    const prompt = buildBatchClassifyPrompt(items, ['技术文档', '工作相关'], 3);
    expect(prompt).toContain('技术文档');
    expect(prompt).toContain('工作相关');
    expect(prompt).toContain('优先归入');
  });

  it('tells the model there are no directories yet when the set is empty', () => {
    expect(buildBatchClassifyPrompt(items, [], 3)).toContain('目前还没有任何目录');
  });

  it('marks user-chosen targets as a hard constraint, not a suggestion', () => {
    // 只把它列进「已有目录」不够——实测勾了目标，模型自作主张另建了一个目录
    const prompt = buildBatchClassifyPrompt(items, ['localhost'], 3, ['localhost']);
    expect(prompt).toContain('所有书签都必须归入');
    expect(prompt).toContain('不要另建新目录');
  });

  it('never shows a positive example that itself contains a space', () => {
    const examples = buildBatchClassifyPrompt(items, [], 3).matchAll(/^\s+"([^"]+)"\s+←\s+"([^"]+)"/gm);
    const leftSides = [...examples].map((m) => m[1]);
    expect(leftSides.length).toBeGreaterThan(0);
    for (const name of leftSides) expect(name, `正例 "${name}" 含空格`).not.toMatch(/\s/);
  });
});

describe('parseBatchClassifyResponse', () => {
  it('parses a JSON code fence', () => {
    expect(parseBatchClassifyResponse('```json\n{"1": "编程/前端"}\n```', 3)).toEqual({
      '1': '编程/前端',
    });
  });

  it('enforces the naming rules on whatever the model returns', () => {
    // 「禁空格、不中英混排、层级上限」的保证只在这一个出口实现
    const parsed = parseBatchClassifyResponse(
      '{"1": "React Hooks 教程", "2": "a/b/c/d", "3": "飞书 Backup Docs"}',
      2,
    );
    expect(parsed['1']).toBe('ReactHooks');
    expect(parsed['2']).toBe('a/b');
    expect(parsed['3']).toBe('飞书');
  });

  it('drops entries whose path normalizes to empty', () => {
    expect(parseBatchClassifyResponse('{"1": "///"}', 3)).toEqual({});
  });

  it('returns an empty object for malformed input', () => {
    expect(parseBatchClassifyResponse('I cannot do that', 3)).toEqual({});
    expect(parseBatchClassifyResponse('[1,2,3]', 3)).toEqual({});
  });
});

describe('chunkItems', () => {
  it('splits into batches of the given size', () => {
    expect(chunkItems([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns nothing for an empty list', () => {
    expect(chunkItems([], 10)).toEqual([]);
  });
});
