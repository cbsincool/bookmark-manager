import { openDB, type IDBPDatabase } from 'idb';
import { DB_NAME, DB_VERSION, STORES } from './constants';
import type { VectorEntry, BookmarkCache, DirectoryVector } from './types';

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
      },
    });
  }

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

  async putDirectoryVector(entry: DirectoryVector): Promise<void> {
    const db = await this.dbPromise;
    await db.put(STORES.DIRECTORY_VECTORS, entry);
  }

  async getAllDirectoryVectors(): Promise<DirectoryVector[]> {
    const db = await this.dbPromise;
    return db.getAll(STORES.DIRECTORY_VECTORS);
  }

  async putSetting(key: string, value: unknown): Promise<void> {
    const db = await this.dbPromise;
    await db.put(STORES.SETTINGS, value, key);
  }

  async getSetting(key: string): Promise<unknown | undefined> {
    const db = await this.dbPromise;
    return db.get(STORES.SETTINGS, key);
  }

  async clear(storeName: string): Promise<void> {
    const db = await this.dbPromise;
    await db.clear(storeName);
  }

  async getVectorCount(): Promise<number> {
    const db = await this.dbPromise;
    return db.count(STORES.VECTORS);
  }
}
