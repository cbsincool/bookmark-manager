import { openDB, type IDBPDatabase } from 'idb';
import { DB_NAME, DB_VERSION, STORES } from './constants';
import type { VectorEntry, BookmarkCache, DirectoryVector, BookmarkNode, ClassifiedBookmark, PageSummary } from './types';

export class BookmarkDB {
  private dbPromise: Promise<IDBPDatabase>;

  constructor() {
    this.dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORES.VECTORS)) {
          db.createObjectStore(STORES.VECTORS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.BOOKMARK_CACHE)) {
          db.createObjectStore(STORES.BOOKMARK_CACHE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.DIRECTORY_VECTORS)) {
          db.createObjectStore(STORES.DIRECTORY_VECTORS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
          db.createObjectStore(STORES.SETTINGS);
        }
        if (!db.objectStoreNames.contains(STORES.DELETED_BOOKMARKS)) {
          db.createObjectStore(STORES.DELETED_BOOKMARKS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.CLASSIFIED_BOOKMARKS)) {
          db.createObjectStore(STORES.CLASSIFIED_BOOKMARKS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.PAGE_SUMMARIES)) {
          db.createObjectStore(STORES.PAGE_SUMMARIES, { keyPath: 'id' });
        }
      },
    });
  }

  // --- Vectors ---

  async putVector(entry: VectorEntry): Promise<void> {
    const db = await this.dbPromise;
    await db.put(STORES.VECTORS, entry);
  }

  async getVector(id: string): Promise<VectorEntry | undefined> {
    const db = await this.dbPromise;
    return db.get(STORES.VECTORS, id);
  }

  async getAllVectors(): Promise<VectorEntry[]> {
    const db = await this.dbPromise;
    return db.getAll(STORES.VECTORS);
  }

  async deleteVector(id: string): Promise<void> {
    const db = await this.dbPromise;
    await db.delete(STORES.VECTORS, id);
  }

  async getVectorCount(): Promise<number> {
    const db = await this.dbPromise;
    return db.count(STORES.VECTORS);
  }

  // --- Bookmark Cache ---

  async putBookmarkCache(entry: BookmarkCache): Promise<void> {
    const db = await this.dbPromise;
    await db.put(STORES.BOOKMARK_CACHE, entry);
  }

  async getBookmarkCache(id: string): Promise<BookmarkCache | undefined> {
    const db = await this.dbPromise;
    return db.get(STORES.BOOKMARK_CACHE, id);
  }

  async getAllBookmarkCaches(): Promise<BookmarkCache[]> {
    const db = await this.dbPromise;
    return db.getAll(STORES.BOOKMARK_CACHE);
  }

  // --- Directory Vectors ---

  async putDirectoryVector(entry: DirectoryVector): Promise<void> {
    const db = await this.dbPromise;
    await db.put(STORES.DIRECTORY_VECTORS, entry);
  }

  async getAllDirectoryVectors(): Promise<DirectoryVector[]> {
    const db = await this.dbPromise;
    return db.getAll(STORES.DIRECTORY_VECTORS);
  }

  // --- Settings ---

  async putSetting(key: string, value: unknown): Promise<void> {
    const db = await this.dbPromise;
    await db.put(STORES.SETTINGS, value, key);
  }

  async getSetting(key: string): Promise<unknown | undefined> {
    const db = await this.dbPromise;
    return db.get(STORES.SETTINGS, key);
  }

  // --- Deleted Bookmarks (undo) ---

  async saveDeletedBookmark(bookmark: BookmarkNode & { parentId: string; index: number }): Promise<void> {
    const db = await this.dbPromise;
    await db.put(STORES.DELETED_BOOKMARKS, bookmark);
  }

  async getDeletedBookmark(id: string): Promise<(BookmarkNode & { parentId: string; index: number }) | undefined> {
    const db = await this.dbPromise;
    return db.get(STORES.DELETED_BOOKMARKS, id);
  }

  async clearDeletedBookmarks(): Promise<void> {
    const db = await this.dbPromise;
    await db.clear(STORES.DELETED_BOOKMARKS);
  }

  // --- Classified Bookmarks ---

  async putClassified(id: string, classifiedAt: number): Promise<void> {
    const db = await this.dbPromise;
    await db.put(STORES.CLASSIFIED_BOOKMARKS, { id, classifiedAt } satisfies ClassifiedBookmark);
  }

  async getClassified(id: string): Promise<ClassifiedBookmark | undefined> {
    const db = await this.dbPromise;
    return db.get(STORES.CLASSIFIED_BOOKMARKS, id);
  }

  async deleteClassified(id: string): Promise<void> {
    const db = await this.dbPromise;
    await db.delete(STORES.CLASSIFIED_BOOKMARKS, id);
  }

  async clearAllClassified(): Promise<void> {
    const db = await this.dbPromise;
    await db.clear(STORES.CLASSIFIED_BOOKMARKS);
  }

  async getAllClassifiedIds(): Promise<string[]> {
    const db = await this.dbPromise;
    const all = await db.getAll(STORES.CLASSIFIED_BOOKMARKS) as ClassifiedBookmark[];
    return all.map((e) => e.id);
  }

  // --- Page Summaries ---

  async putPageSummary(id: string, summary: string): Promise<void> {
    const db = await this.dbPromise;
    await db.put(STORES.PAGE_SUMMARIES, { id, summary, fetchedAt: Date.now() } satisfies PageSummary);
  }

  async getPageSummary(id: string): Promise<PageSummary | undefined> {
    const db = await this.dbPromise;
    return db.get(STORES.PAGE_SUMMARIES, id);
  }

  async deletePageSummary(id: string): Promise<void> {
    const db = await this.dbPromise;
    await db.delete(STORES.PAGE_SUMMARIES, id);
  }

  // --- Generic ---

  async clear(storeName: string): Promise<void> {
    const db = await this.dbPromise;
    await db.clear(storeName);
  }
}
