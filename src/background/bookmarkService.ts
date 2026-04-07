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
