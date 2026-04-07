import { describe, it, expect, beforeEach } from 'vitest';
import { BookmarkDB } from '../db';

// vitest runs in Node with fake-indexeddb
import 'fake-indexeddb/auto';

describe('BookmarkDB', () => {
  let db: BookmarkDB;

  beforeEach(async () => {
    db = new BookmarkDB();
    await db.clear('vectors');
    await db.clear('settings');
  });

  it('puts and gets a vector entry', async () => {
    const entry = {
      id: 'bm1',
      vector: new Float32Array([0.1, 0.2, 0.3]),
      text: 'test bookmark',
      updatedAt: Date.now(),
    };
    await db.putVector(entry);
    const result = await db.getVector('bm1');
    expect(result).toEqual(entry);
  });

  it('gets all vectors', async () => {
    await db.putVector({ id: 'a', vector: new Float32Array(3), text: 'a', updatedAt: 1 });
    await db.putVector({ id: 'b', vector: new Float32Array(3), text: 'b', updatedAt: 2 });
    const all = await db.getAllVectors();
    expect(all).toHaveLength(2);
  });

  it('deletes a vector entry', async () => {
    await db.putVector({ id: 'x', vector: new Float32Array(3), text: 'x', updatedAt: 1 });
    await db.deleteVector('x');
    const result = await db.getVector('x');
    expect(result).toBeUndefined();
  });

  it('puts and gets settings', async () => {
    await db.putSetting('language', 'zh');
    const val = await db.getSetting('language');
    expect(val).toBe('zh');
  });

  it('returns undefined for missing setting', async () => {
    const val = await db.getSetting('nonexistent');
    expect(val).toBeUndefined();
  });
});
