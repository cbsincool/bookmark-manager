import { BookmarkDB } from '@/shared/db';
import { generateEmbedding } from './embeddingClient';
import { cosineSimilarity } from '@/shared/vectorSearch';
import { callCloudAPI, buildClassificationPrompt, parseClassificationResponse } from './apiClient';
import { moveBookmark, findOrCreateFolderPath, getRootFolderId, getDirectoryPathsUnder } from './bookmarkService';
import { normalizeDirectoryPath } from '@/shared/directoryNaming';
import type { AppSettings } from '@/shared/types';

const db = new BookmarkDB();

export async function handleNewBookmark(
  bookmark: chrome.bookmarks.BookmarkTreeNode,
  settings: AppSettings,
): Promise<void> {
  if (!bookmark.url) return;
  if (!settings.realtimeArchiving) return;

  const text = `${bookmark.title} ${bookmark.url}`;

  // Generate embedding via the configured TEI service (1024-dim for bge-m3).
  // Must use the same model as handleRebuildIndex / handleSearch, otherwise the
  // vector written here lives in a different space and cosine similarity against
  // the rest of the index is meaningless (and dimension mismatch yields NaN).
  const vector = await generateEmbedding(text, settings.embeddingEndpoint);

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
      const rootId = await getRootFolderId();
      const existingPaths = settings.onlyUseExistingDirectories
        ? await getDirectoryPathsUnder(rootId)
        : undefined;
      const prompt = buildClassificationPrompt(
        [{ id: bookmark.id, title: bookmark.title, url: bookmark.url, path: '' }],
        settings.topLevelCategories,
        {
          onlyExisting: settings.onlyUseExistingDirectories,
          existingPaths,
          depthMode: 'deep',
        },
      );
      const response = await callCloudAPI(prompt, settings);
      const classification = parseClassificationResponse(response);
      const firstPath = Object.keys(classification)[0];

      if (firstPath) {
        if (settings.onlyUseExistingDirectories) {
          // 只在路径确实已存在时才移动。比对的是**真实存在的目录名**，
          // 所以这里不能用归一化后的名字——用户自己建的 "React Hooks" 带空格，
          // 归一化成 "ReactHooks" 反而永远匹配不上
          if ((existingPaths ?? []).includes(firstPath)) {
            const { id: folderId } = await findOrCreateFolderPath(firstPath.split('/'), rootId);
            await moveBookmark(bookmark.id, folderId);
            chrome.notifications.create({
              type: 'basic',
              iconUrl: 'icons/icon48.png',
              title: 'Bookmark Archived',
              message: `"${bookmark.title}" → ${firstPath}`,
            });
          } else {
            // Notify user that manual classification is needed
            chrome.notifications.create({
              type: 'basic',
              iconUrl: 'icons/icon48.png',
              title: 'Bookmark Needs Classification',
              message: `"${bookmark.title}" does not fit existing directories. Please classify manually.`,
            });
          }
        } else {
          // 新建目录时要走和整理模块同一套命名清洗，否则会建出 "飞书 Backup Docs"
          // 这类带空格的名字——「禁空格」的规则只在生成新名字时适用
          const newPath = normalizeDirectoryPath(firstPath);
          if (newPath) {
            const { id: folderId } = await findOrCreateFolderPath(newPath.split('/'), rootId);
            await moveBookmark(bookmark.id, folderId);
            chrome.notifications.create({
              type: 'basic',
              iconUrl: 'icons/icon48.png',
              title: 'Bookmark Archived',
              message: `"${bookmark.title}" → ${newPath}`,
            });
          }
        }
      }
    } catch (err) {
      console.error('[BM] Real-time archiving API call failed:', err);
    }
  }
}
