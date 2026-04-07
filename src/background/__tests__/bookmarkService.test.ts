import { describe, it, expect } from 'vitest';
import { flattenBookmarkTree, getBookmarkPath } from '../bookmarkService';

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
