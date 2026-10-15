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

/**
 * 列出 rootId 之下的所有目录路径，**相对于 rootId**。
 *
 * 与 `getAllDirectoryPaths()` 的差别很关键：后者从书签树根开始走，产出的路径带
 * 「书签栏」前缀（`书签栏/技术文档`），而 `findOrCreateFolderPath(parts, rootId)`
 * 建出来的路径不带前缀（`技术文档`）。拿前者去比对后者，永远匹配不上——
 * 「只使用已有目录」会因此把骨架整个过滤掉，最终一条书签都归不了位。
 */
export async function getDirectoryPathsUnder(rootId: string): Promise<string[]> {
  const nodes = await chrome.bookmarks
    .getSubTree(rootId)
    .catch(() => [] as chrome.bookmarks.BookmarkTreeNode[]);

  const paths: string[] = [];

  function walk(children: chrome.bookmarks.BookmarkTreeNode[] | undefined, parentPath: string): void {
    for (const child of children ?? []) {
      if (child.url || !child.children) continue;
      const currentPath = parentPath ? `${parentPath}/${child.title}` : child.title;
      paths.push(currentPath);
      walk(child.children, currentPath);
    }
  }

  walk(nodes[0]?.children, '');
  return paths;
}
