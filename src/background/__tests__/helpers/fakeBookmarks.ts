/**
 * 内存版 `chrome.bookmarks`，给整理/回退这类会改树的逻辑做单测。
 *
 * 只实现被测代码真正用到的那几个方法，但语义要和 Chrome 对齐——
 * 尤其是两条容易被忽略的：
 *  - `getChildren()` 对**书签**返回空数组（不是抛错），这正是 prune 里
 *    「书签 id 混进候选集就会被删掉」的成因；
 *  - `remove()` 删目录时连整棵子树一起删，不做非空检查。
 */

export interface FakeNode {
  readonly id: string;
  readonly parentId?: string;
  readonly title: string;
  readonly url?: string;
}

export class FakeBookmarks {
  private nodes = new Map<string, FakeNode>();
  private kids = new Map<string, string[]>();
  private seq = 0;
  private readonly bar: string;

  constructor() {
    this.nodes.set('0', { id: '0', title: '' });
    this.kids.set('0', []);
    this.bar = this.addFolder('书签栏', '0');
    this.addFolder('其他书签', '0');
  }

  private nextId(): string {
    this.seq += 100;
    return String(this.seq);
  }

  addFolder(title: string, parentId: string): string {
    const id = this.nextId();
    this.nodes.set(id, { id, parentId, title });
    this.kids.set(id, []);
    this.kids.get(parentId)!.push(id);
    return id;
  }

  addBookmark(title: string, url: string, parentId: string): string {
    const id = this.nextId();
    this.nodes.set(id, { id, parentId, title, url });
    this.kids.get(parentId)!.push(id);
    return id;
  }

  get barId(): string {
    return this.bar;
  }

  exists(id: string): boolean {
    return this.nodes.has(id);
  }

  parentOf(id: string): string | undefined {
    return this.nodes.get(id)?.parentId;
  }

  /** 某个目录的直接子节点数——断言「没被误删」用 */
  childCount(id: string): number {
    return (this.kids.get(id) ?? []).length;
  }

  // --- chrome.bookmarks 兼容层 ---

  private toTreeNode(id: string): chrome.bookmarks.BookmarkTreeNode {
    const node = this.nodes.get(id)!;
    const kidIds = this.kids.get(id) ?? [];
    const tree: chrome.bookmarks.BookmarkTreeNode = {
      id: node.id,
      title: node.title,
      ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
      ...(node.url !== undefined ? { url: node.url } : {}),
    };
    if (kidIds.length > 0) tree.children = kidIds.map((k) => this.toTreeNode(k));
    return tree;
  }

  install(): void {
    const self = this;
    (globalThis as unknown as { chrome: unknown }).chrome = {
      bookmarks: {
        getTree: async () => [self.toTreeNode('0')],
        get: async (id: string) => {
          const node = self.nodes.get(id);
          if (!node) throw new Error(`Can't find bookmark for id.`);
          return [self.toTreeNode(id)];
        },
        getChildren: async (id: string) => {
          if (!self.nodes.has(id)) throw new Error(`Can't find bookmark for id.`);
          return (self.kids.get(id) ?? []).map((k) => self.toTreeNode(k));
        },
        create: async (info: { parentId?: string; title?: string; url?: string }) => {
          const parentId = info.parentId ?? '1';
          const id = info.url
            ? self.addBookmark(info.title ?? '', info.url, parentId)
            : self.addFolder(info.title ?? '', parentId);
          return self.toTreeNode(id);
        },
        move: async (id: string, info: { parentId?: string; index?: number }) => {
          const node = self.nodes.get(id);
          if (!node) throw new Error(`Can't find bookmark for id.`);
          const from = node.parentId!;
          const list = self.kids.get(from)!;
          list.splice(list.indexOf(id), 1);
          const target = info.parentId ?? from;
          const to = self.kids.get(target);
          if (!to) throw new Error(`Can't find bookmark for id.`);
          const at = info.index === undefined ? to.length : Math.min(info.index, to.length);
          to.splice(at, 0, id);
          self.nodes.set(id, { ...node, parentId: target });
          return self.toTreeNode(id);
        },
        remove: async (id: string) => {
          if (!self.nodes.has(id)) throw new Error(`Can't find bookmark for id.`);
          const drop = (target: string): void => {
            for (const kid of self.kids.get(target) ?? []) drop(kid);
            self.kids.delete(target);
            self.nodes.delete(target);
          };
          const parent = self.nodes.get(id)?.parentId;
          if (parent) {
            const list = self.kids.get(parent)!;
            list.splice(list.indexOf(id), 1);
          }
          drop(id);
        },
      },
    };
  }
}
