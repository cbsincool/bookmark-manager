import { describe, it, expect } from 'vitest';
import { buildSemanticClusters, buildDomainClusters, mergeDirectoryTree, foldPathsIntoTopLevel, collapseTinyDirectories, foldNestedTopLevels, foldTutorialTopics } from '../organizeEngine';
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
    expect(tree).toEqual({ 编程: ['a'], 其它: ['x', 'y'] });
  });

  it('honours a custom unclassified path (文件夹整理时要留在该文件夹内部)', () => {
    const tree = mergeDirectoryTree([], ['x'], '工作/其它');
    expect(tree).toEqual({ '工作/其它': ['x'] });
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

  it('scopes user-chosen targets to move-out only, not to every bookmark', () => {
    // 移出目标是**目的地白名单**，不是「所有书签都去这儿」。
    // 早先的措辞写的是「所有书签都必须归入下面这几个目录之一」——照做的话
    // 整个文件夹会被倒进某一个目标目录，与「只有更匹配的才移出去」正好相反。
    const prompt = buildBatchClassifyPrompt(items, ['localhost'], 3, ['localhost']);
    expect(prompt).toContain('允许');
    expect(prompt).toContain('仅限这些，不要另建');
    expect(prompt).toContain('其余书签仍归入');
    expect(prompt).not.toContain('所有书签都必须归入');
  });

  it('tells the model where each bookmark currently sits, so repeat runs stay stable', () => {
    // 模型看不见书签现在在哪，就只能凭标题重猜——同一份书签两次整理结果不同，
    // 实测 34% 的书签在两棵近义目录之间来回搬
    const prompt = buildBatchClassifyPrompt(
      [{ ...items[0], currentPath: '存储/硬盘' }],
      ['存储/硬盘'],
      3,
    );
    expect(prompt).toContain('[现在位于: 存储/硬盘]');
    expect(prompt).toContain('保持稳定');
  });

  it('treats the user-configured category list as a hard top-level allowlist', () => {
    // 软提示治不好「一级目录越攒越多」：模型照样沿用历史遗留的顶层目录。
    // 只有把它写成硬约束，旧的顶层才会被搬空、被清掉。
    const prompt = buildBatchClassifyPrompt(items, [], 3, [], ['技术文档', '兴趣爱好']);
    expect(prompt).toContain('顶层目录只能从下面这些名字里选');
    expect(prompt).toContain('技术文档');
    expect(prompt).toContain('兴趣爱好');
    expect(prompt).toContain('二级目录');
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

describe('foldPathsIntoTopLevel', () => {
  const STORAGE = /存储|RAID|NAS|SAN|硬盘/i;
  const CONTAINERS = new Set(['存储', '存储设备']);

  it('folds a nested storage path into the top-level storage folder', () => {
    // 「存储」独立成一级后，`硬件/存储`、`技术/存储` 仍各留二三十条，
    // 同一个主题被劈成三处
    const { tree, moved } = foldPathsIntoTopLevel(
      { '硬件/存储/RAID': ['a'], '技术/存储': ['b'] },
      '存储', STORAGE, CONTAINERS,
    );
    expect(tree).toEqual({ '存储/RAID': ['a'], 存储: ['b'] });
    expect(moved).toBe(2);
  });

  it('keeps the leaf when it carries information, drops it when it is a container word', () => {
    const { tree } = foldPathsIntoTopLevel(
      { '硬件/存储设备/硬盘': ['a'], '技术/存储设备': ['b'] },
      '存储', STORAGE, CONTAINERS,
    );
    expect(tree).toEqual({ '存储/硬盘': ['a'], 存储: ['b'] });
  });

  it('leaves paths already under the target alone', () => {
    const { tree, moved } = foldPathsIntoTopLevel(
      { '存储/RAID': ['a'], '硬件/CPU': ['b'] },
      '存储', STORAGE, CONTAINERS,
    );
    expect(tree).toEqual({ '存储/RAID': ['a'], '硬件/CPU': ['b'] });
    expect(moved).toBe(0);
  });

  it('only looks below the top level, never the top itself', () => {
    // 顶层就叫「存储」的路径不该被当成分散在别处
    const { moved } = foldPathsIntoTopLevel({ 存储: ['a'] }, '存储', STORAGE, CONTAINERS);
    expect(moved).toBe(0);
  });
});

describe('collapseTinyDirectories — 受保护的顶层', () => {
  it('does not flatten tiny subfolders of a protected top', () => {
    // 合并会把 `Linux/内核`（只有 1 条）并回 `Linux`，
    // 结果是书签全堆在一级目录下——那正是「没分类」的来源
    const tree = { Linux: ['a'], 'Linux/内核': ['b'] };
    const { tree: out, collapsed } = collapseTinyDirectories(tree, 2, new Set(['Linux']));
    expect(out).toEqual({ Linux: ['a'], 'Linux/内核': ['b'] });
    expect(collapsed).toBe(0);
  });

  it('still collapses tiny subfolders of unprotected tops', () => {
    const tree = { 技术: ['a'], '技术/杂项': ['b'] };
    const { tree: out, collapsed } = collapseTinyDirectories(tree, 2);
    expect(out).toEqual({ 技术: ['a', 'b'] });
    expect(collapsed).toBe(1);
  });
});

describe('foldNestedTopLevels', () => {
  const DOMAINS = new Set(['Linux', '存储', '网络', '虚拟化']);

  it('pulls a nested domain top-level back out', () => {
    // 实测 `技术/操作系统/Linux`、`技术/网络/RDMA`：同一个领域出现在两处
    const { tree, folded } = foldNestedTopLevels(
      { '技术/操作系统/Linux': ['a'], '技术/网络/RDMA': ['b'], '技术/网络': ['c'] },
      DOMAINS,
    );
    expect(tree).toEqual({ Linux: ['a'], '网络/RDMA': ['b'], 网络: ['c'] });
    expect(folded).toBe(3);
  });

  it('leaves non-domain tops alone (教程/网络 keeps its meaning)', () => {
    // 教程是内容类型，「网络相关的教程」提走就丢了语义
    const { tree, folded } = foldNestedTopLevels({ '教程/网络': ['a'] }, DOMAINS, new Set(['教程']));
    expect(tree).toEqual({ '教程/网络': ['a'] });
    expect(folded).toBe(0);
  });

  it('does not touch the top level itself', () => {
    const { folded } = foldNestedTopLevels({ '网络/RDMA': ['a'] }, DOMAINS);
    expect(folded).toBe(0);
  });
});

describe('foldTutorialTopics', () => {
  const tree = {
    教程: ['t0'],
    '教程/Python': ['a'],
    '教程/OpenCV': ['b'],
    '教程/硬件': ['c'],
    技术: ['d'],
    '技术/编程语言/Python': Array.from({ length: 20 }, (_, i) => `p${i}`),
    硬件: Array.from({ length: 12 }, (_, i) => `h${i}`),
    图像处理: ['x'],
  };

  it('moves a tutorial subfolder into the domain that already owns it', () => {
    // 「教程/Python」本质是 Python 内容，应该待在 技术/编程语言/Python
    const { tree: out } = foldTutorialTopics(tree, '教程', '其它');
    expect(out['教程/Python']).toBeUndefined();
    expect(out['技术/编程语言/Python']).toContain('a');
  });

  it('moves a tutorial subfolder named after a top-level into that top level', () => {
    const { tree: out } = foldTutorialTopics(tree, '教程', '其它');
    expect(out['教程/硬件']).toBeUndefined();
    expect(out['硬件']).toContain('c');
  });

  it('keeps tutorials whose topic has no home elsewhere', () => {
    // 教程/OpenCV 别处没有对应目录，留在教程里——它本来就是纯教学
    const { tree: out } = foldTutorialTopics(tree, '教程', '其它');
    expect(out['教程/OpenCV']).toEqual(['b']);
    expect(out['教程']).toEqual(['t0']);
  });
});
