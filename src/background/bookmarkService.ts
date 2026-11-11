import type { BookmarkNode } from '@/shared/types';

export function flattenBookmarkTree(
  nodes: chrome.bookmarks.BookmarkTreeNode[],
  parentPath = '',
): BookmarkNode[] {
  const results: BookmarkNode[] = [];

  for (const node of nodes) {
    const currentPath = parentPath ? `${parentPath}/${node.title}` : node.title;

    if (node.url) {
      results.push({
        id: node.id,
        title: node.title,
        url: node.url,
        path: parentPath,
        dateAdded: node.dateAdded,
      });
    }

    if (node.children) {
      results.push(...flattenBookmarkTree(node.children, currentPath));
    }
  }

  return results;
}

export function getBookmarkPath(
  ancestors: readonly { id: string; title: string }[],
): string {
  return ancestors.map((a) => a.title).join('/');
}

export async function getAllBookmarks(): Promise<BookmarkNode[]> {
  const tree = await chrome.bookmarks.getTree();
  return flattenBookmarkTree(tree);
}

export async function moveBookmark(id: string, parentId: string): Promise<void> {
  await chrome.bookmarks.move(id, { parentId });
}

export async function removeBookmark(id: string): Promise<void> {
  await chrome.bookmarks.remove(id);
}

export async function createFolder(
  title: string,
  parentId?: string,
): Promise<chrome.bookmarks.BookmarkTreeNode> {
  return chrome.bookmarks.create({ title, parentId });
}

/**
 * 逐层解析路径，返回末级目录 id 以及**本次新建**的目录 id。
 *
 * 匹配目录名时忽略大小写：AI 会为同一个已有目录产出 "GitHub" 和 "Github" 两种写法，
 * 严格相等会建出两个只差大小写的目录（实测出现过 `Github` 184 条 + `GitHub` 2 条）。
 * 忽略大小写是安全的——Chrome 的书签栏本身在 Windows 上就不区分目录名大小写。
 *
 * `createdIds` 是「撤销整理」的依据：回退时要把这些目录删掉，
 * 否则整理会在收藏夹里留下一堆空壳。
 */
export async function findOrCreateFolderPath(
  pathParts: readonly string[],
  rootId: string,
): Promise<{ id: string; createdIds: string[] }> {
  let currentParentId = rootId;
  const createdIds: string[] = [];

  for (const part of pathParts) {
    const children = await chrome.bookmarks.getChildren(currentParentId);
    const existing = children.find(
      (c) => !c.url && c.title.trim().toLowerCase() === part.trim().toLowerCase(),
    );

    if (existing) {
      currentParentId = existing.id;
    } else {
      const created = await createFolder(part, currentParentId);
      createdIds.push(created.id);
      currentParentId = created.id;
    }
  }

  return { id: currentParentId, createdIds };
}

/** 书签栏的 id —— `getTree()` 根节点的第一个子节点。目录路径的基准是它 */
export async function getRootFolderId(): Promise<string> {
  const tree = await chrome.bookmarks.getTree();
  return tree[0]?.children?.[0]?.id ?? '1';
}

/** 一个已存在的目录，路径相对于 rootId，附带**直属**书签（不含子目录里的） */
export interface ExistingFolder {
  readonly path: string;
  readonly bookmarkIds: readonly string[];
}

/**
 * 列出 rootId 下的所有目录及其直属书签。
 *
 * 与 `getAllDirectoryPaths()` 的差别很关键：后者从书签树根开始走，产出的路径带
 * 「书签栏」前缀（`书签栏/技术文档`），而 `findOrCreateFolderPath(parts, rootId)`
 * 建出来的路径不带前缀（`技术文档`）。拿前者去比对后者，永远匹配不上。
 */
export async function getExistingFolders(rootId: string): Promise<ExistingFolder[]> {
  const nodes = await chrome.bookmarks
    .getSubTree(rootId)
    .catch(() => [] as chrome.bookmarks.BookmarkTreeNode[]);

  const folders: ExistingFolder[] = [];

  function walk(
    children: chrome.bookmarks.BookmarkTreeNode[] | undefined,
    parentPath: string,
  ): void {
    for (const child of children ?? []) {
      if (child.url || !child.children) continue;
      const path = parentPath ? `${parentPath}/${child.title}` : child.title;
      folders.push({
        path,
        bookmarkIds: child.children.filter((c) => c.url).map((c) => c.id),
      });
      walk(child.children, path);
    }
  }

  walk(nodes[0]?.children, '');
  return folders;
}

/** 只取路径，供「仅使用已有目录」的白名单比对 */
export async function getDirectoryPathsUnder(rootId: string): Promise<string[]> {
  return (await getExistingFolders(rootId)).map((folder) => folder.path);
}

/**
 * 找出与 folderId **同级**、且名字互为包含关系的目录，作为同一个主题一起处理。
 *
 * 「工作」与「工作相关」这类同级目录本来就是一回事，分开整理只会得到两个
 * 语义重复的目录。这里把它们合成一组：书签一起参与归类，搬空后由执行阶段的
 * prune 清掉空壳，等价于完成了一次合并。
 *
 * 限定同级是有意的——跨层级只靠名字包含判断太容易误伤。
 * 已知边界：像「工作」与「工作流」这种字面包含但主题不同的，也会被并进来；
 * 调用方会把合并结果展示给用户，而不是静默处理。
 */
export async function resolveMergeGroup(
  folderId: string,
): Promise<{ ids: readonly string[]; names: readonly string[] }> {
  const target = (await chrome.bookmarks.get(folderId).catch(() => []))[0];
  if (!target || target.url) return { ids: [], names: [] };

  const siblings = target.parentId
    ? await chrome.bookmarks.getChildren(target.parentId).catch(() => [])
    : [target];

  const base = target.title.trim();
  const group = siblings.filter((node) => {
    if (node.url) return false;
    if (node.id === target.id) return true;
    const title = node.title.trim();
    if (!title || !base) return false;
    return title.includes(base) || base.includes(title);
  });

  return { ids: group.map((node) => node.id), names: group.map((node) => node.title) };
}

/**
 * 某个目录相对于 rootId 的路径（`书签栏/工作` → `工作`）。
 * 用于判断「哪些目录在这个文件夹内部」——路径前缀比对比逐层查父节点简单。
 */
export async function getFolderPathRelativeTo(
  rootId: string,
  folderId: string,
): Promise<string | undefined> {
  const nodes = await chrome.bookmarks
    .getSubTree(rootId)
    .catch(() => [] as chrome.bookmarks.BookmarkTreeNode[]);

  let found: string | undefined;
  const walk = (list: chrome.bookmarks.BookmarkTreeNode[] | undefined, parent: string): void => {
    for (const node of list ?? []) {
      if (node.url || !node.children) continue;
      const path = parent ? `${parent}/${node.title}` : node.title;
      if (node.id === folderId) found = path;
      walk(node.children, path);
    }
  };
  walk(nodes[0]?.children, '');

  return found;
}

/** 某个目录（含所有子目录）下的全部书签 id */
export async function collectSubtreeBookmarkIds(folderId: string): Promise<Set<string>> {
  const nodes = await chrome.bookmarks
    .getSubTree(folderId)
    .catch(() => [] as chrome.bookmarks.BookmarkTreeNode[]);

  const ids = new Set<string>();
  const walk = (list: chrome.bookmarks.BookmarkTreeNode[] | undefined): void => {
    for (const node of list ?? []) {
      if (node.url) ids.add(node.id);
      if (node.children) walk(node.children);
    }
  };

  walk(nodes[0]?.children);
  return ids;
}

/**
 * 删除**本次整理搬空的**目录，连同因它们被删而变空的祖先。
 *
 * 两条边界：
 *  - 不动用户自己留的空目录。判据是「它在整理前是非空的」——只有这样的目录
 *    才可能因为本次整理而变空。整理前就空的目录没有任何子节点被搬走，
 *    自然进不了候选集。
 *  - 只删目录。`chrome.bookmarks.getChildren()` 对**书签**返回空数组，
 *    所以一个书签 id 混进候选集会两道检查都通过、然后被直接删掉。
 *    候选集理论上只含目录，但这里再挡一道——删错一条书签是不可逆的。
 */
export interface PruneResult {
  readonly pruned: number;
  /**
   * 被删掉的目录 id。
   *
   * 调用方要拿它清掉对应的**目录向量**：实时归档按目录 id 找归属，
   * 向量还在但目录已经没了，新收藏的书签就会被搬向一个不存在的 id
   * （`moveBookmark` 抛错、被吞掉，表现成「自动归档偶尔不生效」）。
   * 这里只负责报出来，不碰存储——这一层不该知道 IndexedDB 的存在。
   */
  readonly removedIds: readonly string[];
}

export async function pruneEmptiedFolders(
  emptied: ReadonlySet<string>,
  keepIds: ReadonlySet<string> = new Set(),
): Promise<PruneResult> {
  // 根节点（书签栏 / 其他书签 / 移动设备书签）永远不删。它们的父是虚拟根，
  // 沿 parentId 往上走迟早会碰到它们——不加这道排除就会把书签栏本身算进候选，
  // 而书签栏一旦被搬空（比如整理把东西全挪进子目录）就会被整个删掉。
  const tree = await chrome.bookmarks.getTree();
  const rootIds = new Set((tree[0]?.children ?? []).map((node) => node.id));

  // 候选 = 被搬空过的目录 + 它们的祖先。祖先只有在**确实空掉**时才删，
  // 而「确实空掉」意味着它原本装着被搬走的那棵子树，所以它也是本次搬空的。
  //
  // 但级联会一路吃到用户点名整理的那个文件夹本身（允许移出时它会被搬空），
  // 所以调用方传进来的 keepIds 要一并排除——那是「这次整理的目标」，
  // 不是整理产生的垃圾。
  const candidates = new Set<string>();
  for (const id of emptied) {
    if (rootIds.has(id) || keepIds.has(id)) continue;
    candidates.add(id);

    let current = (await chrome.bookmarks.get(id).catch(() => []))[0];
    while (current?.parentId) {
      const parent = (await chrome.bookmarks.get(current.parentId).catch(() => []))[0];
      if (!parent || rootIds.has(parent.id) || keepIds.has(parent.id)) break;
      candidates.add(parent.id);
      current = parent;
    }
  }

  let pruned = 0;
  const removedIds: string[] = [];
  let changed = true;

  // 每删一个目录都可能让它的父目录变空，所以反复扫到不再有变化为止。
  // 加轮次上限：单轮没有删除就退出，正常情况轮数与树的深度同阶。
  while (changed) {
    changed = false;
    for (const id of candidates) {
      const node = await chrome.bookmarks.get(id).catch(() => []);
      if (node.length === 0) continue; // 已被删除
      if (node[0].url) continue; // 是书签不是目录——绝不能删

      const children = await chrome.bookmarks.getChildren(id).catch(() => null);
      if (children === null || children.length > 0) continue;

      try {
        await chrome.bookmarks.remove(id);
        // 计数只加在真正删掉之后：`.catch(() => {})` 之后再 ++ 会把删除失败
        // 也算成「清理了 N 个目录」，而失败时目录其实还在
        pruned++;
        removedIds.push(id);
        changed = true;
      } catch (err) {
        console.warn(`[BM] Failed to prune folder ${id}:`, err);
      }
    }
  }

  return { pruned, removedIds };
}

/** 一个目录下的直属书签（不含子目录） */
export async function getFolderBookmarks(
  folderId: string,
): Promise<{ id: string; title: string; url: string }[]> {
  const children = await chrome.bookmarks.getChildren(folderId).catch(() => null);
  if (!children) return [];
  return children
    .filter((node) => node.url)
    .map((node) => ({ id: node.id, title: node.title, url: node.url ?? '' }));
}

export interface MoveResult {
  readonly moved: number;
  readonly failed: number;
  readonly failures: readonly string[];
}

/**
 * 批量移动书签。
 *
 * 目标必须是目录：传成书签 id 时 `chrome.bookmarks.move` 会报错，
 * 但在界面上给出清楚的提示比让它抛更友好。
 */
export async function moveBookmarks(
  ids: readonly string[],
  targetFolderId: string,
): Promise<MoveResult> {
  const [target] = await chrome.bookmarks.get(targetFolderId).catch(() => []);
  if (!target || target.url) {
    return { moved: 0, failed: ids.length, failures: ['目标不是目录'] };
  }

  let moved = 0;
  let failed = 0;
  const failures: string[] = [];
  for (const id of ids) {
    try {
      await chrome.bookmarks.move(id, { parentId: targetFolderId });
      moved++;
    } catch (err) {
      failed++;
      if (failures.length < 5) failures.push(`${id}: ${String(err)}`);
    }
  }
  return { moved, failed, failures };
}

/**
 * 把若干目录合并进目标目录。
 *
 * 做法是「搬空再删」：源的每个子节点（书签和子目录）逐个搬到目标，
 * 确认源已经空了才删除它——删一个非空目录会连带删掉里面的东西。
 *
 * 两条边界：
 *  - 源不能是目标的祖先，否则搬的是自己脚下的路，Chrome 会拒绝或搬出环
 *  - 源就是目标时跳过
 */
export async function mergeFolders(
  sourceIds: readonly string[],
  targetFolderId: string,
): Promise<{ moved: number; removed: number; failures: readonly string[] }> {
  const [target] = await chrome.bookmarks.get(targetFolderId).catch(() => []);
  if (!target || target.url) {
    return { moved: 0, removed: 0, failures: ['目标不是目录'] };
  }

  let moved = 0;
  let removed = 0;
  const failures: string[] = [];

  const ancestorsOfTarget = new Set<string>();
  let cursor = target.parentId;
  while (cursor) {
    ancestorsOfTarget.add(cursor);
    const [parent] = await chrome.bookmarks.get(cursor).catch(() => []);
    cursor = parent?.parentId;
  }

  for (const sourceId of sourceIds) {
    if (sourceId === targetFolderId) continue;
    if (ancestorsOfTarget.has(sourceId)) {
      if (failures.length < 5) failures.push(`${sourceId}: 不能把上级目录合并进它的子目录`);
      continue;
    }

    try {
      const children = await chrome.bookmarks.getChildren(sourceId);
      for (const child of children) {
        await chrome.bookmarks.move(child.id, { parentId: targetFolderId });
        moved++;
      }
      // 只有确认空了才删：删非空目录会连带删掉里面的书签
      const left = await chrome.bookmarks.getChildren(sourceId);
      if (left.length === 0) {
        await chrome.bookmarks.remove(sourceId);
        removed++;
      }
    } catch (err) {
      if (failures.length < 5) failures.push(`${sourceId}: ${String(err)}`);
    }
  }

  return { moved, removed, failures };
}
