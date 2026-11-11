import { describe, it, expect, beforeEach } from 'vitest';
import { FakeBookmarks } from './helpers/fakeBookmarks';
import { pruneEmptiedFolders } from '../bookmarkService';

describe('pruneEmptiedFolders', () => {
  let fake: FakeBookmarks;
  let bar: string;

  beforeEach(() => {
    fake = new FakeBookmarks();
    fake.install();
    bar = fake.barId;
  });

  it('deletes a folder that this run emptied, and reports its id', async () => {
    // 报出 id 是调用方清目录向量的依据：目录没了、向量还在，
    // 实时归档就会把新书签往一个不存在的目录搬
    const folder = fake.addFolder('工作', bar);
    const { pruned, removedIds } = await pruneEmptiedFolders(new Set([folder]));

    expect(pruned).toBe(1);
    expect(removedIds).toEqual([folder]);
    expect(fake.exists(folder)).toBe(false);
  });

  it('keeps a folder that still has bookmarks', async () => {
    const folder = fake.addFolder('工作', bar);
    fake.addBookmark('还在', 'https://a.com', folder);

    const { pruned, removedIds } = await pruneEmptiedFolders(new Set([folder]));

    expect(pruned).toBe(0);
    expect(removedIds).toEqual([]);
    expect(fake.exists(folder)).toBe(true);
  });

  it('never deletes a bookmark id even if one reaches the candidate set', async () => {
    // chrome.bookmarks.getChildren() 对书签返回空数组，所以书签 id 一旦混进候选集，
    // 两道「非空目录」检查都会放行、然后被直接删掉。这条断言就是那道类型兜底。
    const folder = fake.addFolder('工作', bar);
    const bookmark = fake.addBookmark('一条书签', 'https://a.com', folder);

    const { pruned } = await pruneEmptiedFolders(new Set([bookmark]));

    expect(pruned).toBe(0);
    expect(fake.exists(bookmark)).toBe(true);
  });

  it('cascades to an ancestor that only became empty because its child was pruned', async () => {
    // 实测的残留：子目录被删后父目录空了，但父目录不在「直接丢过书签」的集合里，
    // 于是永远轮不到它——一次整理能在收藏夹里留下几十个空壳
    const outer = fake.addFolder('技术', bar);
    const inner = fake.addFolder('存储', outer);

    const { pruned, removedIds } = await pruneEmptiedFolders(new Set([inner]));

    expect(pruned).toBe(2);
    expect(removedIds).toEqual([inner, outer]);
    expect(fake.exists(inner)).toBe(false);
    expect(fake.exists(outer)).toBe(false);
  });

  it('stops at the bookmark bar instead of deleting the roots', async () => {
    const outer = fake.addFolder('技术', bar);

    await pruneEmptiedFolders(new Set([outer]));

    expect(fake.exists(bar)).toBe(true);
  });

  it('leaves an unrelated empty folder alone', async () => {
    // 用户自己留的占位目录（「稍后阅读」）不该因为跑了一次整理就被删掉
    const kept = fake.addFolder('稍后阅读', bar);
    const emptied = fake.addFolder('工作', bar);

    await pruneEmptiedFolders(new Set([emptied]));

    expect(fake.exists(kept)).toBe(true);
    expect(fake.exists(emptied)).toBe(false);
  });

  it('never prunes a folder passed in keepIds, even after cascading up to it', async () => {
    // 允许移出时，用户点名整理的那个文件夹自己也会被搬空。
    // 级联如果一路吃到它，整理完目标文件夹就没了——那不是用户要的结果
    const scope = fake.addFolder('硬件', bar);
    const inner = fake.addFolder('存储', scope);

    const { pruned, removedIds } = await pruneEmptiedFolders(new Set([inner]), new Set([scope]));

    expect(pruned).toBe(1);
    expect(removedIds).toEqual([inner]);
    expect(fake.exists(inner)).toBe(false);
    expect(fake.exists(scope)).toBe(true);
  });

  it('does not count or report a removal that failed', async () => {
    // 计数只加在真正删掉之后：`.catch(() => {})` 之后再 ++ 会把失败也报成「清理了 N 个」，
    // 而失败时目录其实还在，调用方还会误删它的目录向量
    const folder = fake.addFolder('工作', bar);
    const chromeMock = (globalThis as unknown as { chrome: { bookmarks: Record<string, unknown> } }).chrome;
    chromeMock.bookmarks.remove = async () => {
      throw new Error('boom');
    };

    const { pruned, removedIds } = await pruneEmptiedFolders(new Set([folder]));

    expect(pruned).toBe(0);
    expect(removedIds).toEqual([]);
    expect(fake.exists(folder)).toBe(true);
  });
});
