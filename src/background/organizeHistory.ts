import type { OrganizeSnapshot, RollbackResult, SnapshotNode } from '@/shared/types';

/** 只保留最近一次整理的拆卸点——整理是可反复跑的操作，多级历史只会让「撤销」需要先选一次 */
export const SNAPSHOT_ID = 'last';

interface TreeIndex {
  readonly ids: ReadonlySet<string>;
  readonly parentOf: ReadonlyMap<string, string>;
}

/**
 * 走一遍当前树，拿到「有哪些节点」和「每个节点的父」。
 *
 * 用一次 getTree 而不是对每个 id 调 `get().catch(() => [])`：后者把「查询出错」
 * 和「节点不存在」混为一谈——service worker 唤醒、IndexedDB 抖动都会让一个**还活着**
 * 的目录落进「已删除」集合，回退就会照着快照再建一个同名目录，书签被拆到两处。
 * 整棵树取不到时应当整体失败，而不是退化成一份猜出来的结构。
 */
async function indexTree(): Promise<TreeIndex> {
  const tree = await chrome.bookmarks.getTree();
  const ids = new Set<string>();
  const parentOf = new Map<string, string>();

  const walk = (list: chrome.bookmarks.BookmarkTreeNode[] | undefined): void => {
    for (const node of list ?? []) {
      ids.add(node.id);
      if (node.parentId) parentOf.set(node.id, node.parentId);
      walk(node.children);
    }
  };
  walk(tree);

  return { ids, parentOf };
}

/**
 * 拍下当前整棵书签树的「位置」。
 *
 * 拍的是**全树**而不是整理作用域内部：允许移出时书签会跑到作用域外面去，
 * 只拍作用域就还原不回来。全树的代价只是一次 getTree + 一份扁平数组，
 * 2000 条书签约 200KB，IndexedDB 完全吃得下。
 *
 * 只有虚拟根（`getTree()[0]`）没有 parentId，跳过——它是个容器，不是书签。
 * 书签栏/其他书签**有** parentId（指向虚拟根），必须留下：书签直接躺在书签栏下时，
 * 回退要靠这个映射才能把它们放回去。
 */
export async function captureSnapshot(): Promise<OrganizeSnapshot> {
  const tree = await chrome.bookmarks.getTree();
  const nodes: SnapshotNode[] = [];

  const walk = (list: chrome.bookmarks.BookmarkTreeNode[] | undefined): void => {
    for (const node of list ?? []) {
      if (node.parentId) {
        nodes.push({
          id: node.id,
          parentId: node.parentId,
          title: node.title,
          url: node.url,
          index: node.index ?? 0,
        });
      }
      walk(node.children);
    }
  };
  walk(tree);

  return { id: SNAPSHOT_ID, createdAt: Date.now(), nodes, createdFolderIds: [] };
}

/** 节点在原始树里的深度，用来保证「先建父、再建子」 */
function depthOf(node: SnapshotNode, byId: ReadonlyMap<string, SnapshotNode>): number {
  let depth = 0;
  let current: SnapshotNode | undefined = node;
  while (current && byId.has(current.parentId)) {
    current = byId.get(current.parentId);
    depth++;
  }
  return depth;
}

/** 在当前树里的深度，用来保证「先删深的、再删浅的」 */
function currentDepth(id: string, parentOf: ReadonlyMap<string, string>): number {
  let depth = 0;
  let cursor = parentOf.get(id);
  const seen = new Set<string>([id]);
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    depth++;
    cursor = parentOf.get(cursor);
  }
  return depth;
}

/**
 * 把书签树还原成快照的样子。
 *
 * 顺序不能颠倒：先补回被 prune 删掉的目录（父先于子），再搬书签，
 * 最后才删本次整理新建的目录——反过来会把刚搬回去的书签连同目录一起删掉。
 *
 * 目录 id 在重建后会变，所以全程用 `idMap`（旧 id → 当前 id）换算，
 * 而不是假设 id 不变。仍存在的目录沿用原 id，不做无谓的重建。
 */
export async function rollbackToSnapshot(
  snapshot: OrganizeSnapshot,
): Promise<RollbackResult> {
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const folderNodes = snapshot.nodes.filter((n) => !n.url);
  const bookmarkNodes = snapshot.nodes.filter((n) => n.url);

  const failures: string[] = [];
  const affectedFolderIds = new Set<string>();
  let foldersRecreated = 0;
  let foldersRemoved = 0;
  let restored = 0;
  let inPlace = 0;
  let failed = 0;

  const before = await indexTree();

  // --- 1. 旧 id → 当前 id ---
  const idMap = new Map<string, string>();
  const missing: SnapshotNode[] = [];
  for (const folder of folderNodes) {
    if (before.ids.has(folder.id)) idMap.set(folder.id, folder.id);
    else missing.push(folder);
  }

  // --- 2. 补回被删掉的目录（浅的先建） ---
  missing.sort((a, b) => depthOf(a, byId) - depthOf(b, byId));
  for (const folder of missing) {
    const parentId = idMap.get(folder.parentId);
    if (!parentId) {
      // 父目录没能还原（它自己也是被删的、且排在这之前）——只可能是快照不完整
      if (failures.length < 5) failures.push(`目录「${folder.title}」的父目录无法还原`);
      failed++;
      continue;
    }
    try {
      // index 要一起给：不带的话重建出来的目录会落到父目录末尾，
      // 书签栏的排列顺序对用户是可见的，「还原」就该连位置一起还原
      const created = await chrome.bookmarks.create({
        parentId,
        title: folder.title,
        index: folder.index,
      });
      idMap.set(folder.id, created.id);
      // 旧 id 的目录向量已经指向一个不存在的目录
      affectedFolderIds.add(folder.id);
      foldersRecreated++;
    } catch (err) {
      if (failures.length < 5) failures.push(`重建目录「${folder.title}」失败：${String(err)}`);
      failed++;
    }
  }

  // --- 3. 书签搬回原位 ---
  //
  // 按「原父目录 → 原序位升序」处理：先放回序位小的，后放的 index 才落得对。
  // 序位只是尽力还原（Chrome 会钳制越界 index），父目录正确才是硬要求。
  const ordered = [...bookmarkNodes].sort((a, b) =>
    a.parentId === b.parentId ? a.index - b.index : a.parentId.localeCompare(b.parentId),
  );

  // 快照要跟着移动更新，否则后面几条会拿旧位置判断「是否已在原位」
  const parentNow = new Map(before.parentOf);

  for (const bookmark of ordered) {
    const parentId = idMap.get(bookmark.parentId);
    if (!parentId) {
      if (failures.length < 5) failures.push(`书签「${bookmark.title}」的原目录已不存在`);
      failed++;
      continue;
    }
    // 本来就在原位的不动。全树都在快照里，无脑搬会把「还原了 2000 条」报给
    // 一个实际只动了 30 条的回退——和整理那边 moved/inPlace 分列是同一个理由，
    // 顺带省掉两千次 IPC
    if (parentNow.get(bookmark.id) === parentId) {
      inPlace++;
      continue;
    }
    try {
      await chrome.bookmarks.move(bookmark.id, { parentId, index: bookmark.index });
      parentNow.set(bookmark.id, parentId);
      restored++;
    } catch (err) {
      if (failures.length < 5) failures.push(`${bookmark.id}: ${String(err)}`);
      failed++;
    }
  }

  // --- 4. 删掉本次整理新建的目录 ---
  //
  // 自深向浅：先删空的叶子，父目录才可能跟着变空。只删空的——
  // 还原失败时目录里还留着书签，删掉就等于丢数据。
  const after = await indexTree();
  const createdAlive = snapshot.createdFolderIds
    .filter((id) => after.ids.has(id))
    .map((id) => ({ id, depth: currentDepth(id, after.parentOf) }))
    .sort((a, b) => b.depth - a.depth);

  for (const { id } of createdAlive) {
    const children = await chrome.bookmarks.getChildren(id);
    if (children.length > 0) continue;
    try {
      await chrome.bookmarks.remove(id);
      affectedFolderIds.add(id);
      foldersRemoved++;
    } catch (err) {
      // 删不掉就留着：一个空目录比一次误删安全得多
      console.warn(`[BM] Failed to remove created folder ${id}:`, err);
    }
  }

  return {
    restored,
    inPlace,
    foldersRecreated,
    foldersRemoved,
    failed,
    failures,
    affectedFolderIds: [...affectedFolderIds],
  };
}
