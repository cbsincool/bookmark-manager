import { describe, it, expect, beforeEach } from 'vitest';
import { FakeBookmarks } from './helpers/fakeBookmarks';
import { captureSnapshot, rollbackToSnapshot } from '../organizeHistory';

describe('organizeHistory', () => {
  let fake: FakeBookmarks;
  let bar: string;

  beforeEach(() => {
    fake = new FakeBookmarks();
    fake.install();
    bar = fake.barId;
  });

  it('captures every node with its parent, so positions can be replayed', async () => {
    const folder = fake.addFolder('技术', bar);
    const bookmark = fake.addBookmark('一条书签', 'https://a.com', folder);

    const snapshot = await captureSnapshot();

    const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
    expect(byId.get(folder)?.parentId).toBe(bar);
    expect(byId.get(bookmark)?.parentId).toBe(folder);
    expect(byId.get(bookmark)?.url).toBe('https://a.com');
    // 虚拟根自身没有 parentId，不入快照
    expect(byId.has('0')).toBe(false);
  });

  it('puts a moved bookmark back where it came from', async () => {
    const source = fake.addFolder('技术', bar);
    const target = fake.addFolder('其他目录', bar);
    const bookmark = fake.addBookmark('一条书签', 'https://a.com', source);

    const snapshot = await captureSnapshot();

    // 模拟一次整理：书签被搬到别的目录
    await chrome.bookmarks.move(bookmark, { parentId: target });

    const result = await rollbackToSnapshot(snapshot);

    expect(result.restored).toBe(1);
    expect(result.failed).toBe(0);
    expect(fake.parentOf(bookmark)).toBe(source);
  });

  it('recreates a folder that the organize run pruned, then restores into it', async () => {
    // 真实顺序：书签先被搬走，源目录空了才被 prune 删掉。
    // 回退必须先把目录建回来，否则书签无处可去。
    const folder = fake.addFolder('技术', bar);
    const bookmark = fake.addBookmark('一条书签', 'https://a.com', folder);

    const snapshot = await captureSnapshot();

    await chrome.bookmarks.move(bookmark, { parentId: bar });
    await chrome.bookmarks.remove(folder);
    expect(fake.exists(folder)).toBe(false);

    const result = await rollbackToSnapshot(snapshot);

    expect(result.foldersRecreated).toBe(1);
    expect(result.restored).toBe(1);
    // 重建后 id 会变，所以按标题找回来——回退全程走 idMap 换算，不能假设 id 不变
    const rebuilt = (await chrome.bookmarks.getChildren(bar)).find((n) => n.title === '技术');
    expect(rebuilt).toBeDefined();
    expect(fake.parentOf(bookmark)).toBe(rebuilt!.id);
    expect(fake.exists(folder)).toBe(false);
  });

  it('rebuilds nested folders parents-first', async () => {
    const outer = fake.addFolder('技术', bar);
    const inner = fake.addFolder('存储', outer);
    const bookmark = fake.addBookmark('一条书签', 'https://a.com', inner);

    const snapshot = await captureSnapshot();

    await chrome.bookmarks.move(bookmark, { parentId: bar });
    await chrome.bookmarks.remove(inner);
    await chrome.bookmarks.remove(outer);

    const result = await rollbackToSnapshot(snapshot);

    expect(result.foldersRecreated).toBe(2);
    const outerNew = (await chrome.bookmarks.getChildren(bar)).find((n) => n.title === '技术');
    const innerNew = (await chrome.bookmarks.getChildren(outerNew!.id)).find((n) => n.title === '存储');
    expect(innerNew).toBeDefined();
    expect(fake.parentOf(bookmark)).toBe(innerNew!.id);
  });

  it('removes the folders the organize run created', async () => {
    const existing = fake.addFolder('技术', bar);
    const bookmark = fake.addBookmark('一条书签', 'https://a.com', existing);

    const snapshot = await captureSnapshot();

    // 整理新建了一个目录，并把书签搬了进去
    const created = fake.addFolder('新建目录', bar);
    await chrome.bookmarks.move(bookmark, { parentId: created });

    const result = await rollbackToSnapshot({ ...snapshot, createdFolderIds: [created] });

    expect(result.restored).toBe(1);
    expect(result.foldersRemoved).toBe(1);
    expect(fake.exists(created)).toBe(false);
    expect(fake.parentOf(bookmark)).toBe(existing);
  });

  it('keeps a created folder that still holds something', async () => {
    // 还原没成功时目录里还留着书签，删掉就等于丢数据——只删空的
    const created = fake.addFolder('新建目录', bar);
    fake.addBookmark('留下的书签', 'https://a.com', created);

    const snapshot = await captureSnapshot();
    const result = await rollbackToSnapshot({ ...snapshot, createdFolderIds: [created] });

    expect(result.foldersRemoved).toBe(0);
    expect(fake.exists(created)).toBe(true);
  });

  it('reports failures instead of throwing when a bookmark is gone', async () => {
    const folder = fake.addFolder('技术', bar);
    const bookmark = fake.addBookmark('一条书签', 'https://a.com', folder);

    const snapshot = await captureSnapshot();
    await chrome.bookmarks.remove(bookmark);

    const result = await rollbackToSnapshot(snapshot);

    expect(result.failed).toBe(1);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.restored).toBe(0);
  });

  it('counts untouched bookmarks as inPlace, not as restored', async () => {
    // 快照含整棵树，无脑搬会把「还原了 2000 条」报给一个实际只动了 1 条的回退，
    // 顺带白跑两千次 IPC
    const folder = fake.addFolder('技术', bar);
    const stays = fake.addBookmark('没动过', 'https://a.com', folder);
    const moves = fake.addBookmark('被搬走了', 'https://b.com', folder);
    fake.addBookmark('别处的', 'https://c.com', bar);

    const snapshot = await captureSnapshot();
    await chrome.bookmarks.move(moves, { parentId: bar });

    const result = await rollbackToSnapshot(snapshot);

    expect(result.restored).toBe(1);
    expect(result.inPlace).toBe(2);
    expect(fake.parentOf(stays)).toBe(folder);
    expect(fake.parentOf(moves)).toBe(folder);
  });

  it('lists the folder ids whose directory vectors went stale', async () => {
    // 回退只该清掉这些目录的向量；整表清空会让实时归档对所有目录一起失效
    const folder = fake.addFolder('技术', bar);
    const bookmark = fake.addBookmark('一条书签', 'https://a.com', folder);

    const snapshot = await captureSnapshot();
    await chrome.bookmarks.move(bookmark, { parentId: bar });
    await chrome.bookmarks.remove(folder);

    const result = await rollbackToSnapshot(snapshot);

    expect(result.affectedFolderIds).toEqual([folder]);
  });

  it('is idempotent: a second run moves nothing', async () => {
    // 失败时后台会保留快照让用户重试，所以重试必须是无害的
    const folder = fake.addFolder('技术', bar);
    const bookmark = fake.addBookmark('一条书签', 'https://a.com', folder);

    const snapshot = await captureSnapshot();
    await chrome.bookmarks.move(bookmark, { parentId: bar });

    await rollbackToSnapshot(snapshot);
    const second = await rollbackToSnapshot(snapshot);

    expect(second.restored).toBe(0);
    expect(second.failed).toBe(0);
    expect(fake.parentOf(bookmark)).toBe(folder);
  });
});
