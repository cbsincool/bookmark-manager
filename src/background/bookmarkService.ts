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

export async function findOrCreateFolderPath(
  pathParts: readonly string[],
  rootId: string,
): Promise<string> {
  let currentParentId = rootId;

  for (const part of pathParts) {
    const children = await chrome.bookmarks.getChildren(currentParentId);
    const existing = children.find((c) => c.title === part && !c.url);

    if (existing) {
      currentParentId = existing.id;
    } else {
      const created = await createFolder(part, currentParentId);
      currentParentId = created.id;
    }
  }

  return currentParentId;
}

/**
 * Get all existing directory paths (folders only, not bookmarks)
 */
export async function getAllDirectoryPaths(): Promise<string[]> {
  const tree = await chrome.bookmarks.getTree();
  const paths: string[] = [];

  function walk(nodes: chrome.bookmarks.BookmarkTreeNode[], parentPath = ''): void {
    for (const node of nodes) {
      if (!node.url && node.children) {
        // It's a folder
        const currentPath = parentPath ? `${parentPath}/${node.title}` : node.title;
        paths.push(currentPath);
        walk(node.children, currentPath);
      }
    }
  }

  walk(tree);
  return paths;
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
