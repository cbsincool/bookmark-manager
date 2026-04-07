import { getAllBookmarks, moveBookmark, removeBookmark, findOrCreateFolderPath } from './bookmarkService';
import { sendToOffscreen } from './offscreenManager';
import { findExactUrlDuplicates, findSameTitleDuplicates, scoreL1, scoreL2, buildDedupGroups } from './dedupEngine';
import { buildDomainClusters } from './organizeEngine';
import { callCloudAPI, buildClassificationPrompt, parseClassificationResponse, buildQualityPrompt, parseQualityResponse, testConnection } from './apiClient';
import { handleNewBookmark } from './realtimeArchiver';
import { BookmarkDB } from '@/shared/db';
import { DEFAULT_SETTINGS, BATCH_SIZE } from '@/shared/constants';
import type { AppSettings, QualityScores } from '@/shared/types';
import type { MessageRequest, MessageResponse } from '@/shared/messageTypes';

const db = new BookmarkDB();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// --- Settings helpers ---

async function getSettings(): Promise<AppSettings> {
  const stored = await db.getSetting('appSettings');
  return { ...DEFAULT_SETTINGS, ...(stored as Partial<AppSettings> | undefined) };
}

async function updateSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const updated = { ...current, ...partial };
  await db.putSetting('appSettings', updated);
  return updated;
}

// --- Message handler ---

chrome.runtime.onMessage.addListener(
  (message: MessageRequest, _sender, sendResponse: (resp: MessageResponse) => void) => {
    handleMessage(message)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true; // async response
  },
);

async function handleMessage(msg: MessageRequest): Promise<unknown> {
  switch (msg.type) {
    case 'PING':
      return 'PONG';

    case 'GET_ALL_BOOKMARKS':
      return getAllBookmarks();

    case 'GENERATE_EMBEDDING':
      return sendToOffscreen({ type: 'GENERATE_EMBEDDING', text: msg.text });

    case 'GENERATE_EMBEDDINGS_BATCH':
      return sendToOffscreen({ type: 'GENERATE_EMBEDDINGS_BATCH', texts: msg.texts });

    case 'SEARCH':
      return handleSearch(msg.query);

    case 'DEDUP_SCAN':
      return handleDedupScan();

    case 'DEDUP_EXECUTE':
      return handleDedupExecute(msg.keepIds, msg.deleteIds);

    case 'ORGANIZE_DOMAIN_CLUSTER':
      return handleDomainCluster();

    case 'ORGANIZE_AI_CLASSIFY':
      return handleAIClassify(msg.bookmarks);

    case 'ORGANIZE_EXECUTE':
      return handleOrganizeExecute(msg.moves);

    case 'GET_SETTINGS':
      return getSettings();

    case 'UPDATE_SETTINGS':
      return updateSettings(msg.settings);

    case 'GET_INDEX_STATS':
      return handleGetIndexStats();

    case 'REBUILD_INDEX':
      return handleRebuildIndex();

    default:
      throw new Error(`Unknown message type: ${(msg as { type: string }).type}`);
  }
}

// --- Search ---

async function handleSearch(query: string): Promise<unknown> {
  const settings = await getSettings();
  const allBookmarks = await getAllBookmarks();
  const allVectors = await db.getAllVectors();

  // Generate query embedding
  const embeddingResp = await sendToOffscreen({ type: 'GENERATE_EMBEDDING', text: query }) as { success: boolean; data: number[] };
  const queryVector = new Float32Array(embeddingResp.data);

  // Semantic search
  const semanticResults = allVectors.map((v) => {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < queryVector.length; i++) {
      dot += queryVector[i] * v.vector[i];
      normA += queryVector[i] * queryVector[i];
      normB += v.vector[i] * v.vector[i];
    }
    const sim = Math.sqrt(normA) * Math.sqrt(normB) === 0
      ? 0
      : dot / (Math.sqrt(normA) * Math.sqrt(normB));
    return { id: v.id, semanticScore: sim };
  });

  return {
    bookmarks: allBookmarks,
    semanticScores: semanticResults,
    settings: {
      fuzzyWeight: settings.searchFuzzyWeight,
      semanticWeight: settings.searchSemanticWeight,
      collapseThreshold: settings.collapseThreshold,
    },
  };
}

// --- Dedup ---

async function handleDedupScan(): Promise<unknown> {
  const settings = await getSettings();
  const bookmarks = await getAllBookmarks();

  const normOpts = {
    stripUtm: settings.urlNormStripUtm,
    stripTrailingSlash: settings.urlNormStripTrailingSlash,
    stripHash: settings.urlNormStripHash,
  };

  const exactUrlGroups = findExactUrlDuplicates(bookmarks, normOpts);
  const sameTitleGroups = findSameTitleDuplicates(bookmarks);

  // Score all items involved in dedup
  const allDedupIds = new Set<string>();
  for (const g of exactUrlGroups) g.items.forEach((i) => allDedupIds.add(i.id));
  for (const g of sameTitleGroups) g.items.forEach((i) => allDedupIds.add(i.id));

  const scores = new Map<string, QualityScores>();
  const dedupBookmarks = bookmarks.filter((b) => allDedupIds.has(b.id));

  for (const bm of dedupBookmarks) {
    const l1 = scoreL1(bm.url);
    const l2 = await scoreL2(bm.url);
    scores.set(bm.id, { l1, l2, l3: 50 }); // L3 default 50 until cloud scoring
  }

  const l3Enabled = settings.l3Enabled && settings.apiEndpoint && settings.apiKey;
  const l1Weight = l3Enabled ? 0.3 : 0.5;
  const l2Weight = l3Enabled ? 0.3 : 0.5;
  const l3Weight = l3Enabled ? 0.4 : 0;

  const groups = buildDedupGroups(exactUrlGroups, sameTitleGroups, scores, l1Weight, l2Weight, l3Weight);

  return groups;
}

async function handleDedupExecute(
  keepIds: readonly string[],
  deleteIds: readonly string[],
): Promise<unknown> {
  for (const id of deleteIds) {
    await removeBookmark(id);
    await db.deleteVector(id);
  }
  return { deleted: deleteIds.length };
}

// --- Organize ---

async function handleDomainCluster(): Promise<unknown> {
  const settings = await getSettings();
  const bookmarks = await getAllBookmarks();
  return buildDomainClusters(bookmarks, settings.domainClusterMinCount);
}

async function handleAIClassify(
  bookmarks: readonly { id: string; title: string; url: string; path: string; summary?: string }[],
): Promise<unknown> {
  const settings = await getSettings();
  if (!settings.apiEndpoint || !settings.apiKey) {
    throw new Error('API not configured');
  }

  // Get existing top-level directories
  const tree = await chrome.bookmarks.getTree();
  const existingDirs = tree[0]?.children
    ?.flatMap((c) => c.children ?? [])
    .filter((c) => !c.url)
    .map((c) => c.title) ?? [];

  const prompt = buildClassificationPrompt(bookmarks, existingDirs);
  const response = await callCloudAPI(prompt, settings);
  return parseClassificationResponse(response);
}

async function handleOrganizeExecute(
  moves: readonly { bookmarkId: string; targetFolderId: string }[],
): Promise<unknown> {
  for (const move of moves) {
    await moveBookmark(move.bookmarkId, move.targetFolderId);
  }
  return { moved: moves.length };
}

// --- Index ---

async function handleGetIndexStats(): Promise<unknown> {
  const vectorCount = await db.getVectorCount();
  const bookmarks = await getAllBookmarks();
  return { indexed: vectorCount, total: bookmarks.length };
}

async function handleRebuildIndex(): Promise<unknown> {
  const bookmarks = await getAllBookmarks();
  await db.clear('vectors');

  for (let i = 0; i < bookmarks.length; i += BATCH_SIZE) {
    const batch = bookmarks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((b) => `${b.title} ${b.url} ${b.path}`);
    const resp = await sendToOffscreen({ type: 'GENERATE_EMBEDDINGS_BATCH', texts }) as { success: boolean; data: number[][] };

    if (resp.success) {
      for (let j = 0; j < batch.length; j++) {
        await db.putVector({
          id: batch[j].id,
          vector: new Float32Array(resp.data[j]),
          text: texts[j],
          updatedAt: Date.now(),
        });
      }
    }
  }

  return { indexed: bookmarks.length };
}

// --- Real-time archiving listener ---

chrome.bookmarks.onCreated.addListener(async (_id, bookmark) => {
  try {
    const settings = await getSettings();
    await handleNewBookmark(bookmark, settings);
  } catch (err) {
    console.error('[BM] Real-time archiving failed:', err);
  }
});

// --- Bookmark change listeners for index maintenance ---

chrome.bookmarks.onChanged.addListener(async (id, changeInfo) => {
  if (!changeInfo.url && !changeInfo.title) return;

  try {
    const [node] = await chrome.bookmarks.get(id);
    if (!node.url) return;

    const text = `${node.title} ${node.url}`;
    const resp = await sendToOffscreen({ type: 'GENERATE_EMBEDDING', text }) as { success: boolean; data: number[] };

    if (resp.success) {
      await db.putVector({
        id,
        vector: new Float32Array(resp.data),
        text,
        updatedAt: Date.now(),
      });
    }
  } catch (err) {
    console.error('[BM] Index update failed:', err);
  }
});

chrome.bookmarks.onRemoved.addListener(async (id) => {
  await db.deleteVector(id);
});

// --- Install handler ---

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[BM] Extension installed:', details.reason);
  if (details.reason === 'install') {
    // Trigger initial index build via alarm
    chrome.alarms.create('initial-index', { delayInMinutes: 0.1 });
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'initial-index') {
    await handleRebuildIndex();
  }
});
