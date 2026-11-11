import { describe, it, expect, beforeEach } from 'vitest';
import { FakeBookmarks } from './helpers/fakeBookmarks';
import { moveBookmarks, mergeFolders, getFolderBookmarks } from '../bookmarkService';

describe('moveBookmarks', () => {
  let fake: FakeBookmarks;
  let bar: string;

  beforeEach(() => {
    fake = new FakeBookmarks();
    fake.install();
    bar = fake.barId;
  });

  it('moves several bookmarks into the target folder', async () => {
    const from = fake.addFolder('来源', bar);
    const to = fake.addFolder('目标', bar);
    const a = fake.addBookmark('a', 'https://a.com', from);
    const b = fake.addBookmark('b', 'https://b.com', from);

    const result = await moveBookmarks([a, b], to);

    expect(result).toEqual({ moved: 2, failed: 0, failures: [] });
    expect(fake.parentOf(a)).toBe(to);
    expect(fake.parentOf(b)).toBe(to);
  });

  it('refuses a bookmark as destination', async () => {
    // chrome.bookmarks.move 会抛，但界面需要一句能看懂的原因
    const folder = fake.addFolder('来源', bar);
    const bookmark = fake.addBookmark('a', 'https://a.com', folder);
    const other = fake.addBookmark('b', 'https://b.com', bar);

    const result = await moveBookmarks([bookmark], other);

    expect(result.moved).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failures[0]).toContain('不是目录');
  });

  it('reports the ones that failed without aborting the rest', async () => {
    const to = fake.addFolder('目标', bar);
    const ok = fake.addBookmark('ok', 'https://a.com', bar);

    const result = await moveBookmarks(['999999', ok], to);

    expect(result.moved).toBe(1);
    expect(result.failed).toBe(1);
  });
});

describe('mergeFolders', () => {
  let fake: FakeBookmarks;
  let bar: string;

  beforeEach(() => {
    fake = new FakeBookmarks();
    fake.install();
    bar = fake.barId;
  });

  it('moves contents into the target and removes the empty source', async () => {
    const target = fake.addFolder('目标', bar);
    const source = fake.addFolder('来源', bar);
    const bookmark = fake.addBookmark('a', 'https://a.com', source);
    const nested = fake.addFolder('子目录', source);

    const result = await mergeFolders([source], target);

    expect(result.moved).toBe(2); // 书签 + 子目录
    expect(result.removed).toBe(1);
    expect(fake.parentOf(bookmark)).toBe(target);
    expect(fake.parentOf(nested)).toBe(target);
    expect(fake.exists(source)).toBe(false);
  });

  it('refuses to merge an ancestor into its own descendant', async () => {
    // 否则会把目标目录自己搬进自己，Chrome 会拒绝或搬出环
    const parent = fake.addFolder('父', bar);
    const child = fake.addFolder('子', parent);

    const result = await mergeFolders([parent], child);

    expect(result.moved).toBe(0);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(fake.exists(parent)).toBe(true);
  });

  it('skips the target itself', async () => {
    const target = fake.addFolder('目标', bar);
    const result = await mergeFolders([target], target);
    expect(result.moved).toBe(0);
    expect(fake.exists(target)).toBe(true);
  });

  it('refuses a bookmark as destination', async () => {
    const bookmark = fake.addBookmark('a', 'https://a.com', bar);
    const source = fake.addFolder('来源', bar);

    const result = await mergeFolders([source], bookmark);

    expect(result.failures[0]).toContain('不是目录');
    expect(fake.exists(source)).toBe(true);
  });

  it('never deletes a source that still has children', async () => {
    // 删非空目录会连带删掉里面的书签——确认空了才删
    const target = fake.addFolder('目标', bar);
    const source = fake.addFolder('来源', bar);
    fake.addBookmark('a', 'https://a.com', source);

    const chromeMock = (globalThis as unknown as { chrome: { bookmarks: Record<string, unknown> } }).chrome;
    chromeMock.bookmarks.move = async () => {
      throw new Error('move denied');
    };

    const result = await mergeFolders([source], target);

    expect(result.removed).toBe(0);
    expect(fake.exists(source)).toBe(true);
  });
});

describe('getFolderBookmarks', () => {
  it('returns only direct bookmarks, not subfolders', async () => {
    const fake = new FakeBookmarks();
    fake.install();
    const folder = fake.addFolder('目录', fake.barId);
    fake.addBookmark('直接', 'https://a.com', folder);
    const sub = fake.addFolder('子目录', folder);
    fake.addBookmark('子目录里', 'https://b.com', sub);

    const rows = await getFolderBookmarks(folder);

    expect(rows.map((r) => r.title)).toEqual(['直接']);
  });
});
