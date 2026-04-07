import { BookmarkDB } from '@/shared/db';
import { sendToOffscreen } from './offscreenManager';
import { cosineSimilarity } from '@/shared/vectorSearch';
import { callCloudAPI, buildClassificationPrompt, parseClassificationResponse } from './apiClient';
import { moveBookmark, findOrCreateFolderPath } from './bookmarkService';
import type { AppSettings } from '@/shared/types';

const db = new BookmarkDB();

export async function handleNewBookmark(
  bookmark: chrome.bookmarks.BookmarkTreeNode,
  settings: AppSettings,
): Promise<void> {
  if (!bookmark.url) return;
  if (!settings.realtimeArchiving) return;

  const text = `${bookmark.title} ${bookmark.url}`;

  // Generate embedding
  const resp = await sendToOffscreen({ type: 'GENERATE_EMBEDDING', text }) as { success: boolean; data: number[] };
  if (!resp.success) return;

  const vector = new Float32Array(resp.data);

  // Save to index
  await db.putVector({ id: bookmark.id, vector, text, updatedAt: Date.now() });

  // Compare with directory vectors
  const dirVectors = await db.getAllDirectoryVectors();
  let bestMatch: { id: string; similarity: number; name: string } | null = null;

  for (const dv of dirVectors) {
    const sim = cosineSimilarity(vector, dv.vector);
    if (!bestMatch || sim > bestMatch.similarity) {
      bestMatch = { id: dv.id, similarity: sim, name: dv.name };
    }
  }

  if (bestMatch && bestMatch.similarity > 0.7) {
    // Move to matched directory
    await moveBookmark(bookmark.id, bestMatch.id);
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Bookmark Archived',
      message: `"${bookmark.title}" → ${bestMatch.name}`,
    });
  } else if (settings.apiEndpoint && settings.apiKey) {
    // Ask cloud API for classification
    try {
      const prompt = buildClassificationPrompt(
        [{ id: bookmark.id, title: bookmark.title, url: bookmark.url, path: '' }],
        dirVectors.map((d) => d.name),
      );
      const response = await callCloudAPI(prompt, settings);
      const classification = parseClassificationResponse(response);
      const firstPath = Object.keys(classification)[0];

      if (firstPath) {
        const pathParts = firstPath.split('/');
        const tree = await chrome.bookmarks.getTree();
        const rootId = tree[0]?.children?.[0]?.id ?? '1';
        const folderId = await findOrCreateFolderPath(pathParts, rootId);
        await moveBookmark(bookmark.id, folderId);

        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'Bookmark Archived',
          message: `"${bookmark.title}" → ${firstPath}`,
        });
      }
    } catch (err) {
      console.error('[BM] Real-time archiving API call failed:', err);
    }
  }
}
