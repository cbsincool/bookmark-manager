import { describe, it, expect, vi, afterEach } from 'vitest';
import { flattenBookmarkTree, getBookmarkPath, getDirectoryPathsUnder, getExistingFolders } from '../bookmarkService';

describe('flattenBookmarkTree', () => {
  it('flattens nested bookmark tree to flat list', () => {
    const tree: chrome.bookmarks.BookmarkTreeNode[] = [
      {
        id: '0', title: 'root', children: [
          {
            id: '1', title: 'Folder A', children: [
              { id: '2', title: 'Page 1', url: 'https://a.com' },
              { id: '3', title: 'Page 2', url: 'https://b.com' },
            ],
          },
          { id: '4', title: 'Page 3', url: 'https://c.com' },
        ],
      },
    ];
    const result = flattenBookmarkTree(tree);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ id: '2', title: 'Page 1', url: 'https://a.com', path: 'root/Folder A' });
    expect(result[2]).toEqual({ id: '4', title: 'Page 3', url: 'https://c.com', path: 'root' });
  });

  it('skips folders (no url)', () => {
    const tree: chrome.bookmarks.BookmarkTreeNode[] = [
      { id: '0', title: 'root', children: [{ id: '1', title: 'EmptyFolder', children: [] }] },
    ];
    const result = flattenBookmarkTree(tree);
    expect(result).toHaveLength(0);
  });
});

describe('getBookmarkPath', () => {
  it('builds path from ancestors', () => {
    const path = getBookmarkPath([
      { id: '0', title: 'Bookmarks Bar' },
      { id: '1', title: 'Dev' },
      { id: '2', title: 'React' },
    ]);
    expect(path).toBe('Bookmarks Bar/Dev/React');
  });
});

/** 书签栏（id=1）下：技术文档/前端/React 一条书签 + 根级一条书签 */
const BAR_SUBTREE = [{
  id: '1',
  title: '书签栏',
  children: [
    {
      id: '10',
      title: '技术文档',
      children: [
        {
          id: '11',
          title: '前端',
          children: [{ id: '12', title: 'React', url: 'https://react.dev' }],
        },
      ],
    },
    { id: '20', title: '散落书签', url: 'https://example.com' },
    { id: '30', title: '空目录', children: [] },
  ],
}] as unknown as chrome.bookmarks.BookmarkTreeNode[];

function stubBar(): void {
  vi.stubGlobal('chrome', {
    bookmarks: { getSubTree: vi.fn().mockResolvedValue(BAR_SUBTREE) },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getDirectoryPathsUnder', () => {
  it('returns paths relative to the root, without the root title prefix', async () => {
    // 基准必须是 rootId 本身：findOrCreateFolderPath(parts, rootId) 建出来的路径
    // 不带 root 的标题。若实现从书签树根开始走，就会多一层「书签栏」前缀——
    // 拿它去比对永远匹配不上（「只使用已有目录」整个失效），实时归档还会
    // 在书签栏里再建一个嵌套的「书签栏」目录。
    stubBar();
    const paths = await getDirectoryPathsUnder('1');

    expect(paths).toEqual(['技术文档', '技术文档/前端', '空目录']);
    for (const path of paths) {
      expect(path.startsWith('书签栏')).toBe(false);
    }
  });
});

describe('getExistingFolders', () => {
  it('lists direct bookmarks per folder and keeps empty folders', async () => {
    stubBar();
    const folders = await getExistingFolders('1');

    expect(folders.map((f) => f.path)).toEqual(['技术文档', '技术文档/前端', '空目录']);
    expect(folders[0].bookmarkIds).toEqual([]); // 直属书签为空（React 在子目录里）
    expect(folders[1].bookmarkIds).toEqual(['12']);
    expect(folders[2].bookmarkIds).toEqual([]);
  });
});
