import { getAllBookmarks, moveBookmark, removeBookmark, findOrCreateFolderPath, getRootFolderId, getDirectoryPathsUnder, getExistingFolders, resolveMergeGroup, collectSubtreeBookmarkIds, getFolderPathRelativeTo, pruneEmptiedFolders, getFolderBookmarks, moveBookmarks, mergeFolders } from './bookmarkService';
import { captureSnapshot, rollbackToSnapshot, SNAPSHOT_ID } from './organizeHistory';
import { suggestTaxonomy, reclassifyIntoAllowlist, refineFallback, splitBareAssignments, type ExistingTopLevel } from './taxonomy';
import { applyRules, RULE_TOP_LEVELS, STORAGE_HINTS, STORAGE_CONTAINER_NAMES, LINUX_SUB_ALIASES, LINUX_ALLOWED_SUBS, LINUX_SUB_FALLBACK } from './organizeRules';
import { STORAGE_TOP, LINUX_TOP, NETWORK_TOP, VIRTUALIZATION_TOP, VIDEO_TOP, SHOPPING_TOP, GITHUB_TOP, TUTORIAL_TOP, WORK_TOP, WINDOWS_TOP } from '@/shared/constants';
import { progressText } from './progressText';
import { generateEmbedding, generateEmbeddingsBatch } from './embeddingClient';
import { rerank } from './rerankerClient';
import { findExactUrlDuplicates, findSameTitleDuplicates, scoreL1, scoreL2Content, scoreL3, buildDedupGroups } from './dedupEngine';
import { buildDomainClusters, computeDirectoryVector, buildSemanticClusters, mergeDirectoryTree, collapseTinyDirectories, foldPathsIntoTopLevel, normalizeSubfoldersUnderTop, foldSmallTopLevels, foldNestedTopLevels, foldTutorialTopics } from './organizeEngine';
import { classifyBookmarks } from './aiClassifier';
import { callCloudAPI, resolveChatEndpoint, resolveMessagesEndpoint, buildClassificationPrompt, parseClassificationResponse, isLowInfoTitle, buildFineDedupPrompt, parseFineDedupResponse } from './apiClient';
import { handleNewBookmark } from './realtimeArchiver';
import { BookmarkDB } from '@/shared/db';
import { cosineSimilarity } from '@/shared/vectorSearch';
import { DEFAULT_SETTINGS, BATCH_SIZE, MAX_BATCH_SIZE, LEGACY_DEFAULT_CATEGORIES, ASSIGN_ACCEPT_THRESHOLD, UNCLASSIFIED_DIR, NEUTRAL_SCORE, DEDUP_WEIGHTS, STORES, MIN_FALLBACK_FOR_REFINE, MIN_BARE_FOR_SPLIT, MIN_TOP_FOR_KEEP, NO_SPLIT_TOPS } from '@/shared/constants';
import type { AppSettings, QualityScores, BookmarkNode, OrganizeStats, OrganizeMode, OrganizeSnapshot } from '@/shared/types';
import type { MessageRequest, MessageResponse, AsyncTask } from '@/shared/messageTypes';

const db = new BookmarkDB();

// Async task storage
const asyncTasks = new Map<string, AsyncTask>();

/** 回退进行中标志：两次回退交错会各自补建一遍目录 */
let rollbackInFlight = false;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// --- Settings helpers ---

async function getSettings(): Promise<AppSettings> {
  const stored = await db.getSetting('appSettings') as Partial<AppSettings> | undefined;
  const merged = { ...DEFAULT_SETTINGS, ...stored };

  // 清掉出厂硬编码的一级目录：它们不在用户收藏夹里，却会在「一级目录配置」中
  // 显示成已有目录。用户真有同名文件夹的话会从收藏夹结构重新出现。
  const categories = stored?.topLevelCategories;
  if (categories?.length) {
    const kept = categories.filter((c) => !LEGACY_DEFAULT_CATEGORIES.includes(c));
    if (kept.length !== categories.length) {
      return { ...merged, topLevelCategories: kept };
    }
  }

  return merged;
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

    case 'GENERATE_EMBEDDING': {
      // Float32Array does not survive chrome.runtime.sendMessage's JSON
      // serialization — it arrives as {0:..,1:..} with no length. Return a
      // plain number[] to match the documented contract.
      const { embeddingEndpoint } = await getSettings();
      return Array.from(await generateEmbedding(msg.text, embeddingEndpoint));
    }

    case 'GENERATE_EMBEDDINGS_BATCH': {
      const { embeddingEndpoint } = await getSettings();
      return (await generateEmbeddingsBatch(msg.texts, embeddingEndpoint)).map((v) => Array.from(v));
    }

    case 'SEARCH':
      return handleSearch(msg.query);

    case 'DEDUP_SCAN':
      return handleDedupScan();

    case 'DEDUP_EXECUTE':
      return handleDedupExecute(msg.keepIds, msg.deleteIds);

    case 'DEDUP_MANUAL_FORCE':
      return handleDedupManualForce(msg.bookmarkIds);

    case 'DEDUP_UNDO':
      return handleDedupUndo(msg.deletedIds);

    case 'ORGANIZE_DOMAIN_CLUSTER':
      return handleDomainCluster();

    case 'ORGANIZE_SUGGEST_TAXONOMY':
      return handleSuggestTaxonomy();

    case 'ORGANIZE_SEMANTIC_CLUSTER':
      return handleSemanticCluster(msg.bookmarkIds);

    case 'ORGANIZE_CONNECTIVITY_CHECK':
      return handleConnectivityCheck(msg.bookmarkIds);

    case 'ORGANIZE_AI_CLASSIFY_START':
      return handleAIClassifyStart(msg.bookmarkIds, msg.scope, msg.folderId, msg.categories, msg.mode, msg.allowMoveOut, msg.moveOutTargets);

    case 'ORGANIZE_AI_CLASSIFY_POLL':
      return handleAIClassifyPoll(msg.taskId);

    case 'ORGANIZE_EXECUTE':
      return handleOrganizeExecute(msg.directoryTree, msg.rootId);

    case 'ORGANIZE_SNAPSHOT_INFO':
      return handleOrganizeSnapshotInfo();

    case 'ORGANIZE_ROLLBACK':
      return handleOrganizeRollback();

    case 'GET_FOLDER_STRUCTURE':
      return handleGetFolderStructure();

    case 'GET_FOLDER_BOOKMARKS':
      return getFolderBookmarks(msg.folderId);

    case 'MOVE_BOOKMARKS':
      return moveBookmarks(msg.ids, msg.targetFolderId);

    case 'MERGE_FOLDERS':
      return mergeFolders(msg.sourceIds, msg.targetFolderId);

    case 'GET_SETTINGS':
      return getSettings();

    case 'UPDATE_SETTINGS':
      return updateSettings(msg.settings);

    case 'TEST_AI_CONNECTION':
      return handleTestAIConnection();

    case 'GET_INDEX_STATS':
      return handleGetIndexStats();

    case 'REBUILD_INDEX':
      return handleRebuildIndex();

    case 'FETCH_PAGE_SUMMARY':
      return handleFetchPageSummary(msg.bookmarkId, msg.url);

    case 'FINE_DEDUP_ANALYZE':
      return handleFineDedupAnalyze(msg.bookmarkIds);

    default:
      throw new Error(`Unknown message type: ${(msg as { type: string }).type}`);
  }
}

// --- Search ---

async function handleSearch(query: string): Promise<unknown> {
  const settings = await getSettings();
  const allBookmarks = await getAllBookmarks();

  // Filter out bookmarks in [待删除_失效] folder
  const filteredBookmarks = allBookmarks.filter((bm) => !bm.path.includes('[待删除_失效]'));

  const allVectors = await db.getAllVectors();

  // Generate query embedding
  const queryVector = await generateEmbedding(query, settings.embeddingEndpoint);

  // Semantic search
  const semanticResults = allVectors.map((v) => ({
    id: v.id,
    semanticScore: cosineSimilarity(queryVector, v.vector),
  }));

  // Take top-K semantic candidates (exclude near-zero similarity items)
  const TOP_K = 50;
  const SEMANTIC_MIN_SCORE = 0.3; // Raised from 0.2 — 0.2 was too lenient, letting in thematically adjacent but irrelevant results
  const topCandidates = [...semanticResults]
    .sort((a, b) => b.semanticScore - a.semanticScore)
    .slice(0, TOP_K)
    .filter((r) => r.semanticScore >= SEMANTIC_MIN_SCORE);

  // Rerank top-N candidates using bge-reranker
  const RERANK_K = 20;
  const rerankScores = new Map<string, number>();
  const rerankCandidates = topCandidates.slice(0, RERANK_K);

  if (rerankCandidates.length > 0) {
    const bmMap = new Map(filteredBookmarks.map((b) => [b.id, b]));
    const candidateTexts = rerankCandidates.map((c) => {
      const bm = bmMap.get(c.id);
      return bm ? `${bm.title} ${bm.url}` : '';
    });

    try {
      const scores = await rerank(query, candidateTexts, settings.rerankerEndpoint);
      rerankCandidates.forEach((c, i) => rerankScores.set(c.id, scores[i]));
    } catch {
      // Reranker unavailable - fall back to semantic scores
    }
  }

  // Only expose semantic scores for top candidates (not all vectors)
  const rerankResults = topCandidates.map((r) => ({
    id: r.id,
    semanticScore: r.semanticScore,
    rerankScore: rerankScores.get(r.id) ?? 0,
  }));

  return {
    bookmarks: filteredBookmarks,
    semanticScores: rerankResults,
    settings: {
      fuzzyWeight: settings.searchFuzzyWeight,
      semanticWeight: settings.searchSemanticWeight,
      collapseThreshold: settings.collapseThreshold,
    },
  };
}

// --- Dedup ---

function broadcastProgress(type: string, current: number, total: number, message: string) {
  chrome.runtime.sendMessage({ type, current, total, message }).catch(() => {});
}

async function handleDedupScan(): Promise<unknown> {
  const settings = await getSettings();
  const bookmarks = await getAllBookmarks();

  // Filter out bookmarks in [待删除_失效] folder
  const filteredBookmarks = bookmarks.filter((bm) => !bm.path.includes('[待删除_失效]'));
  const total = filteredBookmarks.length;

  broadcastProgress('DEDUP_SCAN_PROGRESS', 0, total, `扫描中 (0/${total})`);

  const normOpts = {
    stripUtm: settings.urlNormStripUtm,
    stripTrailingSlash: settings.urlNormStripTrailingSlash,
    stripHash: settings.urlNormStripHash,
  };

  const exactUrlGroups = findExactUrlDuplicates(filteredBookmarks, normOpts);
  broadcastProgress('DEDUP_SCAN_PROGRESS', Math.floor(total * 0.4), total, `URL 去重完成，正在分析标题...`);

  const sameTitleGroups = findSameTitleDuplicates(filteredBookmarks);
  broadcastProgress('DEDUP_SCAN_PROGRESS', Math.floor(total * 0.7), total, `正在计算质量评分...`);

  // Score all items involved in dedup
  const allDedupIds = new Set<string>();
  for (const g of exactUrlGroups) g.items.forEach((i) => allDedupIds.add(i.id));
  for (const g of sameTitleGroups) g.items.forEach((i) => allDedupIds.add(i.id));

  const dedupBookmarks = filteredBookmarks.filter((b) => allDedupIds.has(b.id));

  // L1 scoring
  const l1Map = new Map<string, number>();
  for (let i = 0; i < dedupBookmarks.length; i++) {
    l1Map.set(dedupBookmarks[i].id, scoreL1(dedupBookmarks[i].url));
  }

  // L3 元数据评分（本地计算，无需 API）
  const l3Map = new Map<string, number>();
  for (const bm of dedupBookmarks) {
    l3Map.set(bm.id, scoreL3(bm));
  }

  // L2 内容质量：只读**已缓存**的页面摘要，不发网络请求——扫描可能涉及上千条书签，
  // 逐条抓取会让去重变得不可用。摘要在「精细去重」时被抓取并缓存，所以这一维会随
  // 使用逐步生效；没有缓存的条目拿中性分，退化成 L1+L3。
  const l2Map = new Map<string, number>();
  for (const bm of dedupBookmarks) {
    const cached = await db.getPageSummary(bm.id).catch(() => undefined);
    l2Map.set(bm.id, scoreL2Content(cached?.summary));
  }

  const scores = new Map<string, QualityScores>();
  for (const bm of dedupBookmarks) {
    scores.set(bm.id, {
      l1: l1Map.get(bm.id) ?? NEUTRAL_SCORE,
      l2: l2Map.get(bm.id) ?? NEUTRAL_SCORE,
      l3: l3Map.get(bm.id) ?? NEUTRAL_SCORE,
    });
  }

  const groups = buildDedupGroups(exactUrlGroups, sameTitleGroups, scores, DEDUP_WEIGHTS);

  broadcastProgress('DEDUP_SCAN_PROGRESS', total, total, `扫描完成，发现 ${groups.length} 组重复`);

  return groups;
}

async function handleDedupExecute(
  keepIds: readonly string[],
  deleteIds: readonly string[],
): Promise<unknown> {
  const allBookmarks = await getAllBookmarks();

  // Save deleted bookmarks for undo before deleting
  for (const id of deleteIds) {
    const bm = allBookmarks.find((b) => b.id === id);
    if (bm) {
      // Get current position info from Chrome API
      try {
        const [node] = await chrome.bookmarks.get(id);
        if (node) {
          await db.saveDeletedBookmark({
            ...bm,
            parentId: node.parentId ?? '',
            index: node.index ?? 0,
          });
        }
      } catch {
        // Bookmark might already be gone, skip saving
      }
    }
    await removeBookmark(id);
    await db.deleteVector(id);
  }
  return { deleted: deleteIds.length };
}

async function handleDedupUndo(
  deletedIds: readonly string[],
): Promise<unknown> {
  let restored = 0;

  for (const id of deletedIds) {
    const saved = await db.getDeletedBookmark(id);
    if (!saved) continue;

    try {
      // Recreate the bookmark at its original position
      await chrome.bookmarks.create({
        parentId: saved.parentId,
        title: saved.title,
        url: saved.url,
        index: saved.index,
      });
      restored++;
    } catch (err) {
      console.warn(`[BM] Failed to restore bookmark ${id}:`, err);
    }
  }

  // Clear saved bookmarks after undo
  await db.clearDeletedBookmarks();
  return { restored };
}

async function handleDedupManualForce(
  bookmarkIds: readonly string[],
): Promise<unknown> {
  const bookmarks = await getAllBookmarks();
  const selected = bookmarks.filter((b) => bookmarkIds.includes(b.id));

  const items: import('@/shared/types').DedupItem[] = [];
  for (const bm of selected) {
    const cached = await db.getPageSummary(bm.id).catch(() => undefined);
    const scores = {
      l1: scoreL1(bm.url),
      l2: scoreL2Content(cached?.summary),
      l3: scoreL3(bm),
    };
    items.push({
      bookmark: bm,
      scores,
      totalScore:
        scores.l1 * DEDUP_WEIGHTS.l1 +
        scores.l2 * DEDUP_WEIGHTS.l2 +
        scores.l3 * DEDUP_WEIGHTS.l3,
    });
  }

  items.sort((a, b) => b.totalScore - a.totalScore);
  const group: import('@/shared/types').DedupGroup = {
    id: `manual-${Date.now()}`,
    scenario: 'manual',
    items,
    recommendedKeepId: items[0].bookmark.id,
  };
  return group;
}

// --- Fine Dedup ---

async function handleFetchPageSummary(bookmarkId: string, url: string): Promise<unknown> {
  const cached = await db.getPageSummary(bookmarkId);
  if (cached) return cached;

  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch(url, { signal: ctrl.signal });
    const html = await resp.text();

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].trim() : '';

    // Extract meta description
    const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
      ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
    const metaDesc = metaMatch ? metaMatch[1].trim() : '';

    // Extract body text (first 200 chars)
    const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

    const summary = [pageTitle, metaDesc, bodyText].filter(Boolean).join(' — ').slice(0, 400);
    const result = { id: bookmarkId, summary, fetchedAt: Date.now() };
    await db.putPageSummary(bookmarkId, summary);
    return result;
  } catch {
    const fallback = { id: bookmarkId, summary: '', fetchedAt: Date.now() };
    return fallback;
  }
}

async function handleFineDedupAnalyze(bookmarkIds: readonly string[]): Promise<unknown> {
  const settings = await getSettings();
  const bookmarks = await getAllBookmarks();
  const selected = bookmarks.filter((b) => bookmarkIds.includes(b.id));
  const total = selected.length;

  // Fetch summaries for all selected bookmarks
  const summaries: { id: string; title: string; url: string; summary: string }[] = [];
  for (let i = 0; i < selected.length; i++) {
    const bm = selected[i];
    broadcastProgress('FINE_DEDUP_PROGRESS', i, total, `抓取摘要中 (${i + 1}/${total})`);
    const cached = await db.getPageSummary(bm.id);
    let summary = cached?.summary ?? '';
    if (!summary && bm.url) {
      const result = await handleFetchPageSummary(bm.id, bm.url) as { summary: string };
      summary = result.summary ?? '';
    }
    summaries.push({ id: bm.id, title: bm.title, url: bm.url, summary });
  }

  broadcastProgress('FINE_DEDUP_PROGRESS', total, total, `摘要抓取完成，正在 AI 分析...`);

  if (!settings.apiEndpoint || !settings.apiKey) {
    // No AI: return summaries only, let user decide
    return { summaries, aiResult: null };
  }

  const prompt = buildFineDedupPrompt(summaries);
  const response = await callCloudAPI(prompt, settings);
  const aiResult = parseFineDedupResponse(response);

  return { summaries, aiResult };
}

// --- Organize ---

async function handleDomainCluster(): Promise<unknown> {
  const bookmarks = await getAllBookmarks();
  // Filter out bookmarks in [待删除_失效] folder
  const filteredBookmarks = bookmarks.filter((bm) => !bm.path.includes('[待删除_失效]'));
  // 书签栏本身的标题：散在根下（没有归属目录）的书签 path 就等于它，
  // 那种情况不算「已归位」
  const tree = await chrome.bookmarks.getTree();
  const rootPath = tree[0]?.children?.[0]?.title ?? '';
  // Return ALL domains (minCount=1) so user can choose which to use as directories
  return buildDomainClusters(filteredBookmarks, 1, rootPath);
}

async function handleSemanticCluster(
  bookmarkIds: readonly string[],
): Promise<{ topicName: string; bookmarkIds: string[] }[]> {
  // Get vectors for the specified bookmarks
  const allVectors = await db.getAllVectors();
  const vectors = allVectors
    .filter((v) => bookmarkIds.includes(v.id))
    .map((v) => ({ id: v.id, vector: v.vector }));

  if (vectors.length < 6) {
    // Not enough data for clustering
    return [];
  }

  const bookmarks = await getAllBookmarks();
  const relevantBookmarks = bookmarks.filter((b) => bookmarkIds.includes(b.id));

  // Determine number of clusters (max 5, min 2)
  const k = Math.min(5, Math.max(2, Math.floor(vectors.length / 10)));

  // 只回传可序列化的字段：centroid 是 Float32Array，过 chrome.runtime.sendMessage
  // 会被 JSON 序列化成 {0:..,1:..} 并丢掉 length
  return buildSemanticClusters(vectors, relevantBookmarks, k).map((cluster) => ({
    topicName: cluster.topicName,
    bookmarkIds: cluster.bookmarkIds,
  }));
}

async function handleConnectivityCheck(
  bookmarkIds: readonly string[],
): Promise<{ deadIds: string[]; checkedCount: number }> {
  // Filter out bookmarks already in [待删除_失效] folder
  const allBookmarks = await getAllBookmarks();
  const filteredIds = bookmarkIds.filter((id) => {
    const bm = allBookmarks.find((b) => b.id === id);
    return bm && !bm.path.includes('[待删除_失效]');
  });

  const CONCURRENCY = 5; // Reduce concurrency to avoid rate limiting
  const TIMEOUT_MS = 15000; // Increase timeout to 15 seconds
  const deadIds: string[] = [];
  const locale = (await getSettings()).language;
  let idx = 0;

  /**
   * Check if a URL is truly dead (404/410).
   * Returns true only for confirmed dead links, not for network errors.
   */
  async function checkUrl(url: string): Promise<{ isDead: boolean; reason: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    try {
      // Try GET request with Range header to minimize data transfer
      const resp = await fetch(url, {
        method: 'GET',
        headers: { 'Range': 'bytes=0-1' }, // Only request 1 byte
        signal: ctrl.signal,
        redirect: 'follow',
        cache: 'no-cache',
      });
      clearTimeout(timer);

      // Only 404 and 410 are confirmed dead
      if (resp.status === 404) {
        return { isDead: true, reason: '404 Not Found' };
      }
      if (resp.status === 410) {
        return { isDead: true, reason: '410 Gone' };
      }
      // 200, 206 (Partial Content), 301, 302, etc. are all valid
      return { isDead: false, reason: `HTTP ${resp.status}` };
    } catch (err) {
      clearTimeout(timer);

      // Don't treat network errors as dead - could be temporary issues
      const errorName = err instanceof Error ? err.name : String(err);

      // AbortError = timeout, give it a second chance
      if (errorName === 'AbortError') {
        console.log(`[Connectivity] Timeout for ${url}, skipping (not marking as dead)`);
        return { isDead: false, reason: 'timeout' };
      }

      // Other network errors - don't mark as dead
      console.log(`[Connectivity] Network error for ${url}: ${errorName}, skipping`);
      return { isDead: false, reason: `network error: ${errorName}` };
    }
  }

  async function worker() {
    while (idx < filteredIds.length) {
      const id = filteredIds[idx++];
      const nodes = await chrome.bookmarks.get(id).catch(() => [] as chrome.bookmarks.BookmarkTreeNode[]);
      const node = nodes[0];
      if (!node?.url) continue;

      // Skip non-HTTP URLs
      if (!node.url.startsWith('http://') && !node.url.startsWith('https://')) {
        continue;
      }

      const result = await checkUrl(node.url);
      if (result.isDead) {
        console.log(`[Connectivity] Dead link: ${node.url} (${result.reason})`);
        deadIds.push(id);
      }

      const done = filteredIds.length - filteredIds.slice(idx).length;
      broadcastProgress('CONNECTIVITY_CHECK_PROGRESS', done, filteredIds.length,
        progressText(locale, 'checkingLinks', { done, total: filteredIds.length }));
    }
  }

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, filteredIds.length) },
    worker,
  );
  await Promise.all(workers);

  if (deadIds.length > 0) {
    const tree = await chrome.bookmarks.getTree();
    const rootId = tree[0]?.children?.[0]?.id ?? '1';
    const { id: folderId } = await findOrCreateFolderPath(['[待删除_失效]'], rootId);
    for (const id of deadIds) {
      await moveBookmark(id, folderId).catch(() => {});
    }
  }

  return { deadIds, checkedCount: filteredIds.length };
}

// --- Async AI Classification ---

function generateTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function handleAIClassifyStart(
  bookmarkIds: readonly string[],
  scope: 'global' | 'folder',
  folderId?: string,
  categories?: readonly string[],
  mode: OrganizeMode = 'fit',
  allowMoveOut = false,
  moveOutTargets: readonly string[] = [],
): Promise<{ taskId: string }> {
  const taskId = generateTaskId();
  const settings = await getSettings();

  // 语言要等 settings 读出来才知道，所以任务登记放在这之后——
  // 这条是 AI 分类期间用户看到的第一句话，写死成中文会让「跟随语言」看起来没生效
  asyncTasks.set(taskId, {
    id: taskId,
    status: 'pending',
    progress: { current: 0, total: 1, message: progressText(settings.language, 'preparing') },
  });

  const allBookmarks = await getAllBookmarks();

  let filtered: BookmarkNode[];
  let mergedFolderNames: readonly string[] = [];

  if (scope === 'folder' && folderId) {
    // 同级同义目录合并成一组处理（「工作」+「工作相关」）。原先用
    // path.includes(标题) 做子串匹配，会跨层级误伤同名片段，且合并动作不可见。
    const group = await resolveMergeGroup(folderId);
    mergedFolderNames = group.names;

    const memberIds = new Set<string>();
    for (const id of group.ids) {
      for (const bmId of await collectSubtreeBookmarkIds(id)) memberIds.add(bmId);
    }

    filtered = allBookmarks.filter(
      (b) => memberIds.has(b.id) && !b.path.includes('[待删除_失效]'),
    );
  } else {
    filtered = allBookmarks.filter((b) => !b.path.includes('[待删除_失效]'));
  }

  // 调用方指定的范围必须被尊重。
  //
  // 这里曾经完全忽略 bookmarkIds：global 范围一律处理全部书签（早期靠「已归类」
  // 标记做过滤，也是同一个毛病）。后果是向导里已经按域名分好组、交给 AI 的那部分
  // 书签也被重新分类，AI 树和域名树覆盖同一批书签，执行时互相抢——域名目录可能
  // 最终是空的，取决于哪个先处理。
  //
  // 不再跳过「已归类」的书签（整理本来就该能重复跑），所以 bookmarkIds 是唯一
  // 的范围来源。空数组表示不限定范围（文件夹范围走上面的分支）。
  let bookmarks: BookmarkNode[];
  if (scope !== 'folder' && bookmarkIds.length > 0) {
    const requested = new Set(bookmarkIds);
    bookmarks = filtered.filter((b) => requested.has(b.id));
  } else {
    bookmarks = filtered;
  }

  // 浏览器内部页（chrome://bookmarks/、扩展页…）不是网页书签，也没有主题可归；
  // 参与整理只会被塞进某个目录，留在原处反而是对的
  bookmarks = bookmarks.filter((b) => /^https?:/i.test(b.url));

  // 骨架的作用域：
  //   全局整理        → 整个书签栏
  //   文件夹整理（默认）→ **该文件夹内部**，书签不会离开它
  //   文件夹整理（允许移出）→ 该文件夹内部 + 用户勾选的移出目标目录
  // 此前无论哪种都取整个书签栏，于是「整理指定文件夹」实际是把书签打散到全局，
  // 新目录还建在书签栏顶层——和按钮上写的完全不是一回事。
  const barId = await getRootFolderId();
  const movingOut = scope === 'folder' && !!folderId && allowMoveOut;

  let skeletonRootId = barId;
  let keepSkeletonPath: ((path: string) => boolean) | undefined;
  let newDirPrefix = '';

  if (scope === 'folder' && folderId && !allowMoveOut) {
    skeletonRootId = folderId;
  } else if (movingOut && folderId) {
    // 移出时路径要相对书签栏，才能既指向文件夹内部的子目录、又指向外面的目标目录
    const folderPath = await getFolderPathRelativeTo(barId, folderId);
    if (!folderPath) {
      // 拿不到路径就没法给新目录加前缀，新目录会落到书签栏顶层、
      // 原文件夹被搬空后又被 prune 删掉——看起来就像「文件夹被改名了」。
      // 宁可响亮地失败，也不要静默把东西建到别处。
      throw new Error(
        '无法确定该文件夹在书签栏下的路径，已中止整理（避免把新目录建到书签栏顶层）。' +
        '请先对书签栏执行一次索引重建后重试。',
      );
    }
    // 注意**不包含文件夹自己**：它的中心向量就是自己那批书签的均值，永远是最近匹配，
    // 移出因此永远不会发生。只留它的子目录 + 勾选的目标。
    const descendants = folderPath ? `${folderPath}/` : '';
    const targets = (moveOutTargets ?? []).filter(Boolean);
    keepSkeletonPath = (path) =>
      (!!descendants && path.startsWith(descendants)) || targets.includes(path);

    // 关键：允许移出只是「书签可以去别的目录」，**新建的目录仍然要建在文件夹内部**。
    // 没有这个前缀的话，聚类/溢出产生的新目录会落到书签栏顶层。
    if (folderPath) newDirPrefix = `${folderPath}/`;
  }

  processAIClassify(taskId, bookmarks, settings, mode, categories, mergedFolderNames, skeletonRootId, keepSkeletonPath, newDirPrefix, moveOutTargets).catch((err) => {
    console.error('[Organize] Task failed:', taskId, err);
    const task = asyncTasks.get(taskId);
    if (task) {
      task.status = 'failed';
      task.error = String(err);
    }
  });

  return { taskId };
}

async function handleAIClassifyPoll(taskId: string): Promise<AsyncTask> {
  const task = asyncTasks.get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  // Clean up completed tasks after returning
  if (task.status === 'completed' || task.status === 'failed') {
    // Keep task for a short time for polling, then clean up
    setTimeout(() => asyncTasks.delete(taskId), 5000);
  }

  return task;
}

interface NamingOutcome {
  readonly paths: Record<string, string>;
  /** 模型是否真的产出了可用命名（false = 静默退回了关键词命名） */
  readonly usedAi: boolean;
  /** 失败原因。扩展的 service worker 日志在端到端脚本里抓不到，只能随结果带出来 */
  readonly detail?: string;
}

/**
 * 给批次排序：用 k-means 把相似的书签聚到一起，再按簇输出。
 *
 * 这里用 k-means **只是为了让相邻的书签相似**——第一批新建的目录会成为后续批次的
 * 「已有目录」，同主题挨着处理才会收敛到一套目录上，而不是每批各建一套。
 * **归属判断仍然全交给 AI**：k-means 找得出「向量团块」，找不出「语义类别」。
 */
function orderForBatching(
  vectors: readonly { id: string; vector: Float32Array }[],
  bookmarks: readonly BookmarkNode[],
): BookmarkNode[] {
  const fallback = [...bookmarks];
  if (vectors.length === 0) return fallback;

  const k = Math.max(2, Math.min(30, Math.round(vectors.length / MAX_BATCH_SIZE)));
  const clusters = buildSemanticClusters(vectors, fallback, k, { minClusterSize: 1 });
  if (clusters.length === 0) return fallback;

  const byId = new Map(bookmarks.map((b) => [b.id, b]));
  const ordered: BookmarkNode[] = [];
  const seen = new Set<string>();
  for (const cluster of clusters) {
    for (const id of cluster.bookmarkIds) {
      const bm = byId.get(id);
      if (bm && !seen.has(id)) {
        seen.add(id);
        ordered.push(bm);
      }
    }
  }
  // 没被聚到的（维度不一致等）补在后面，保证一条不漏
  for (const bm of bookmarks) if (!seen.has(bm.id)) ordered.push(bm);
  return ordered;
}

/**
 * 整理流程：确定初始目录集合 → 分批交给 AI 归档 → 汇合。
 *
 * 归属判断**整个交给模型**。向量只用来给批次排序（把相似的书签排在一起处理），
 * 不用来判断归属——实测在真实书签上，相关与不相关内容的余弦相似度都落在 0.4-0.6，
 * 区分不出来；k-means 找得出「向量团块」，找不出「语义类别」。
 *
 * mode 只决定**起点**：
 *   fit    —— 初始目录集合 = 现有目录（归得对的会被模型判回原处，移动是空操作）
 *   replan —— 初始目录集合 = 空（目录随内容生长）
 */
async function processAIClassify(
  taskId: string,
  bookmarks: readonly BookmarkNode[],
  settings: AppSettings,
  mode: OrganizeMode,
  userCategories?: readonly string[],
  mergedFolderNames: readonly string[] = [],
  skeletonRootId?: string,
  keepSkeletonPath?: ((path: string) => boolean) | undefined,
  newDirPrefix = '',
  forceIncludePaths: readonly string[] = [],
): Promise<void> {
  const task = asyncTasks.get(taskId);
  if (!task) return;

  const updateProgress = (current: number, total: number, message: string) => {
    task.progress = { current, total, message };
  };

  const finish = (
    directoryTree: Record<string, string[]>,
    skeletonPaths: readonly string[],
    overflowPaths: readonly string[],
    stats: OrganizeStats,
  ) => {
    task.status = 'completed';
    task.result = {
      directoryTree,
      lowCohesionPaths: [],
      skeletonPaths,
      overflowPaths,
      mergedFolderNames,
      stats,
    };
  };

  const statsFor = (overrides: Partial<OrganizeStats>): OrganizeStats => ({
    total: bookmarks.length,
    skeletonCount: 0,
    assigned: 0,
    overflow: 0,
    overflowDirectories: 0,
    unassigned: bookmarks.length,
    acceptThreshold: ASSIGN_ACCEPT_THRESHOLD,
    ...overrides,
  });

  try {
    task.status = 'running';
    const total = bookmarks.length;
    // 进度文案在 service worker 里生成，拿不到侧边栏的 i18n，只能自己按语言取
    const locale = settings.language;

    if (total === 0) {
      finish({}, [], [], statsFor({}));
      return;
    }

    // --- 阶段 0：补齐向量 ---
    updateProgress(0, total, progressText(locale, 'fetchingVectors', { done: 0, total }));
    const allVectors = await db.getAllVectors();
    const vectorMap = new Map(allVectors.map((v) => [v.id, v.vector]));

    const missing = bookmarks.filter((b) => !vectorMap.has(b.id));
    if (missing.length > 0) {
      for (let i = 0; i < missing.length; i += BATCH_SIZE) {
        const batch = missing.slice(i, i + BATCH_SIZE);
        const texts = batch.map((b) => `${b.title} ${b.url}`);
        const vectors = await generateEmbeddingsBatch(texts, settings.embeddingEndpoint);
        for (let j = 0; j < batch.length; j++) {
          vectorMap.set(batch[j].id, vectors[j]);
          await db.putVector({ id: batch[j].id, vector: vectors[j], text: texts[j], updatedAt: Date.now() });
        }
        updateProgress(
          i + batch.length,
          missing.length,
          progressText(locale, 'generatingVectors', { done: i + batch.length, total: missing.length }),
        );
      }
    }

    const vectors = bookmarks
      .map((b) => ({ id: b.id, vector: vectorMap.get(b.id) }))
      .filter((v): v is { id: string; vector: Float32Array } => v.vector !== undefined);

    const titleById = new Map(bookmarks.map((b) => [b.id, b.title]));

    const canUseAI = Boolean(
      settings.apiEndpoint && (settings.apiFormat === 'anthropic' || settings.apiKey),
    );

    // --- 阶段 1：确定初始目录集合 ---
    //
    // 归属判断整个交给 AI。向量只用来**给批次排序**（把相似的书签排在一起处理），
    // 不用来判断归属——实测在真实书签上，相关与不相关内容的余弦相似度都落在
    // 0.4-0.6，区分不出来（显卡扩展坞评测和智能体文档的相似度，跟同主题内容差不多）。
    const rootFolderId = skeletonRootId ?? (await getRootFolderId());
    const allFolders = await getExistingFolders(rootFolderId);

    // 用户确认过的一级目录分类法。有它的时候它就是**白名单**：
    // 候选路径只保留落在这套顶层里的，模型也不许另起顶层。
    // 没有它就退回旧行为（沿用现有结构）。
    //
    // 只对**全局整理**生效：文件夹范围整理时骨架根是那个文件夹自己，
    // 书签栏的一级分类法在那里没有意义，硬套会把东西搬到文件夹外面去。
    const allowedTop = new Map<string, string>(); // 小写 → 展示名
    for (const name of userCategories ?? []) {
      const trimmed = name.trim();
      if (trimmed) allowedTop.set(trimmed.toLowerCase(), trimmed);
    }
    const globalScope = !skeletonRootId || skeletonRootId === (await getRootFolderId());
    const enforceTopLevel = globalScope && allowedTop.size > 0;
    const topOf = (path: string): string => path.split('/')[0];
    const isAllowedTop = (segment: string): boolean => allowedTop.has(segment.toLowerCase());

    /** 模型偶尔会写近义顶层名（「网络设备」写成「网络」），先按包含关系找回分类法里的写法 */
    const canonicalTop = (segment: string): string | undefined => {
      const direct = allowedTop.get(segment.toLowerCase());
      if (direct) return direct;
      const lower = segment.toLowerCase();
      for (const [key, display] of allowedTop) {
        if (lower.includes(key) || key.includes(lower)) return display;
      }
      return undefined;
    };

    // --- 阶段 1.5：确定性规则 ---
    //
    // B 站永远是视频、京东永远是购物。这类判断交给模型只会带来抖动：
    // 同一批书签两次整理归到不同目录，而平台归属根本不需要「判断」。
    // 规则只在全局整理下生效——文件夹范围整理时路径是相对该文件夹的，
    // 硬套书签栏的「视频/购物」会把东西搬出用户指定的文件夹。
    const ruleResolved = new Map<string, string>(); // id → 已确定的完整路径
    const lockedTop = new Map<string, string>(); // id → 只锁定顶层
    if (globalScope) {
      for (const b of bookmarks) {
        const rule = applyRules(b);
        if (!rule) continue;
        if (rule.final) ruleResolved.set(b.id, rule.top);
        else if (rule.sub) ruleResolved.set(b.id, `${rule.top}/${rule.sub}`);
        else lockedTop.set(b.id, rule.top);
      }
    }

    const initialPaths: string[] = [];
    if (mode === 'fit') {
      for (const folder of allFolders) {
        if (folder.path === UNCLASSIFIED_DIR) continue;
        if (folder.path.includes('[待删除_失效]')) continue;
        if (keepSkeletonPath && !keepSkeletonPath(folder.path)) continue;
        // 白名单外的旧结构一律不给——给了模型就会照抄，旧目录永远清不掉
        if (enforceTopLevel && !isAllowedTop(topOf(folder.path))) continue;
        initialPaths.push(folder.path);
      }
    }
    // 分类法本身始终是候选：replan 下它甚至是唯一的候选（骨架为空时模型没有参照）
    for (const name of allowedTop.values()) {
      if (!initialPaths.includes(name)) initialPaths.push(name);
    }
    // 规则产出的顶层也必须是候选（分类法可能没包含它们，例如用户手动删过）
    for (const name of RULE_TOP_LEVELS) {
      if (!initialPaths.includes(name)) initialPaths.push(name);
    }
    // 用户勾选的移出目标始终可选
    for (const target of forceIncludePaths) {
      if (target && !initialPaths.includes(target)) initialPaths.push(target);
    }

    // --- 阶段 2：分批交给 AI 归档 ---
    updateProgress(0, total, progressText(locale, 'classifying'));
    const maxDepth = settings.organizeMaxDepth ?? 3;
    // 规则已经定了完整路径的（视频/购物）不必再问模型，省调用也省得它改主意
    const aiBookmarks = bookmarks.filter((b) => !ruleResolved.has(b.id));
    const ordered = orderForBatching(vectors, [...aiBookmarks]);

    // 「现在位于」提示：模型看不见书签当前在哪，就只能凭标题重猜一次，
    // 于是同一份书签两次整理结果不同、在两棵近义目录之间来回搬。
    // getExistingFolders 已经给出「目录路径 → 直属书签」，直接反查即可。
    const currentPathById = new Map<string, string>();
    for (const folder of allFolders) {
      for (const id of folder.bookmarkIds) currentPathById.set(id, folder.path);
    }

    const outcome = canUseAI
      ? await classifyBookmarks(
          ordered.map((b) => ({
            id: b.id,
            title: b.title,
            url: b.url,
            currentPath: currentPathById.get(b.id),
            lockedTop: lockedTop.get(b.id),
          })),
          initialPaths,
          settings,
          {
            batchSize: MAX_BATCH_SIZE,
            maxDepth,
            mustUsePaths: forceIncludePaths,
            userCategories,
            onProgress: (done, count) =>
              updateProgress(done, count, progressText(locale, 'classifyingCount', { done, total: count })),
          },
        )
      : {
          assignments: new Map<string, string>(),
          createdPaths: [] as string[],
          usedAi: false,
          detail: '未配置可用的模型',
        };

    // --- 阶段 3：汇合 ---
    const createdSet = new Set(outcome.createdPaths);
    const byPath = new Map<string, string[]>();

    // 顶层白名单兜底：模型不遵守规矩时，能对上的按包含关系归位。
    // 对不上的**不直接判死刑**——先挑出来定向重试一次。此前直接丢进「未分类」，
    // 实测一次丢掉了 97 条 Python 书签（模型写了分类法里没有的「编程/Python」），
    // 全都本该进「技术」。
    const accepted: [string, string][] = [];
    const rejected = new Map<string, string>();
    for (const [id, rawPath] of outcome.assignments) {
      let path = rawPath;
      // 规则锁定了顶层的（Linux / 教程）：模型只该决定二级。
      // 它写了别的顶层时，把顶层的决定权收回来——保留模型给的二级名。
      const locked = lockedTop.get(id);
      if (locked) {
        const [top, ...rest] = path.split('/');
        if (top !== locked) path = rest.length > 0 ? `${locked}/${rest.join('/')}` : locked;
      }

      if (!enforceTopLevel) {
        accepted.push([id, path]);
        continue;
      }
      const [top, ...rest] = path.split('/');
      const canonical = canonicalTop(top);
      if (canonical) accepted.push([id, [canonical, ...rest].join('/')]);
      else rejected.set(id, path);
    }

    const repaired = new Map<string, string>();
    if (rejected.size > 0 && canUseAI) {
      const titleById = new Map(bookmarks.map((b) => [b.id, b]));
      const items = Array.from(rejected.keys()).map((id) => ({
        id,
        title: titleById.get(id)?.title ?? '',
        url: titleById.get(id)?.url ?? '',
      }));
      const fixed = await reclassifyIntoAllowlist(items, Array.from(allowedTop.values()), settings, maxDepth);
      for (const [id, path] of Object.entries(fixed)) {
        const [top, ...rest] = path.split('/');
        const canonical = canonicalTop(top);
        if (canonical) repaired.set(id, [canonical, ...rest].join('/'));
      }
    }

    let droppedToUnclassified = 0;
    const finalAssignments: [string, string][] = [...accepted];
    for (const id of rejected.keys()) {
      const fixed = repaired.get(id);
      if (fixed) finalAssignments.push([id, fixed]);
      else {
        finalAssignments.push([id, UNCLASSIFIED_DIR]);
        droppedToUnclassified++;
      }
    }

    // 规则已经定好完整路径的（视频/购物）：直接并入，不经过模型
    for (const [id, path] of ruleResolved) {
      byPath.set(path, [...(byPath.get(path) ?? []), id]);
    }

    for (const [id, normalized] of finalAssignments) {
      // 文件夹整理且允许移出时，路径是相对书签栏的；新目录要建在该文件夹内部
      const path =
        createdSet.has(normalized) && newDirPrefix ? `${newDirPrefix}${normalized}` : normalized;
      byPath.set(path, [...(byPath.get(path) ?? []), id]);
    }

    const assignedIds = new Set([...outcome.assignments.keys(), ...ruleResolved.keys()]);
    const unassignedIds = bookmarks.filter((b) => !assignedIds.has(b.id)).map((b) => b.id);

    const merged = mergeDirectoryTree(
      Array.from(byPath.entries()).map(([path, ids]) => ({ path, ids })),
      unassignedIds,
      newDirPrefix ? `${newDirPrefix}${UNCLASSIFIED_DIR}` : UNCLASSIFIED_DIR,
    );

    // 把散落在 `硬件/存储`、`技术/存储` 里的内容折回一级「存储」。
    // 规则层只认关键词，没命中的同类书签会被模型放回旧子目录，
    // 结果同一个主题被劈成三处。折完再跑「单条目录合并」，顺序不能反。
    const folded = globalScope
      ? foldPathsIntoTopLevel(merged, STORAGE_TOP, STORAGE_HINTS, STORAGE_CONTAINER_NAMES)
      : { tree: merged, moved: 0 };

    // 「一个网页一个目录」的确定性兜底：只装 1 条的末级目录并回上级。
    // 只对全局整理做——文件夹范围整理时，用户要的就是那个文件夹内部的细分。
    const collapsedInfo = globalScope
      ? collapseTinyDirectories(folded.tree, 2, new Set(RULE_TOP_LEVELS))
      : { tree: merged, collapsed: 0 };
    let directoryTree = collapsedInfo.tree;


    // 把嵌套了另一个一级目录的路径提回一级：技术/操作系统/Linux → Linux。
    // 必须排在「补二级目录」之前——提回来的书签同样需要补二级，
    // 否则刚折进来的会直接躺在一级目录下。
    const nestedFolded = { folded: 0 };
    if (globalScope) {
      const domainTops = new Set([
        LINUX_TOP, STORAGE_TOP, NETWORK_TOP, VIRTUALIZATION_TOP, VIDEO_TOP, SHOPPING_TOP,
        GITHUB_TOP, WORK_TOP, WINDOWS_TOP,
      ]);
      const nested = foldNestedTopLevels(directoryTree, domainTops, new Set([TUTORIAL_TOP]));
      directoryTree = nested.tree;
      nestedFolded.folded = nested.folded;
    }

    // 「教程」只收纯教学：Python/Agent 这类本质是领域内容，搬回对应领域
    let tutorialFoldedCount = 0;
    if (globalScope) {
      const tutorialFolded = foldTutorialTopics(directoryTree, TUTORIAL_TOP, UNCLASSIFIED_DIR);
      directoryTree = tutorialFolded.tree;
      if (tutorialFolded.folded > 0) {
        tutorialFoldedCount = tutorialFolded.folded;
      }
    }

    // --- 阶段 3.5：给「直接躺在一级目录下」的书签补二级目录 ---
    //
    // 模型经常只给顶层不给二级（实测「教程」94/167、「图像处理」97/103 条
    // 直接躺在顶层），加上「单条目录合并」会把零星子目录并回父目录，
    // 结果就是整理完一看还是一堆没分类的书签。这一步单独补。
    let bareSplit = 0;
    if (globalScope && canUseAI) {
      const byId = new Map(bookmarks.map((b) => [b.id, b]));
      const nextTree: Record<string, string[]> = { ...directoryTree };

      for (const [path, ids] of Object.entries(directoryTree)) {
        if (path.includes('/') || ids.length < MIN_BARE_FOR_SPLIT) continue;
        if (NO_SPLIT_TOPS.includes(path)) continue; // Github：用户要的就是平铺

        const existingSubs = Object.keys(directoryTree)
          .filter((p) => p.startsWith(`${path}/`))
          .map((p) => p.slice(path.length + 1))
          .filter((p) => !p.includes('/'));

        updateProgress(
          total, total,
          progressText(locale, 'splittingBare', { top: path, count: ids.length }),
        );

        const filled = await splitBareAssignments(
          ids.map((id) => ({
            id,
            title: byId.get(id)?.title ?? '',
            url: byId.get(id)?.url ?? '',
          })),
          path,
          existingSubs,
          settings,
          maxDepth,
        );

        const remaining: string[] = [];
        for (const id of ids) {
          const target = filled[id];
          if (target) {
            nextTree[target] = [...(nextTree[target] ?? []), id];
            bareSplit++;
          } else {
            remaining.push(id);
          }
        }
        nextTree[path] = remaining;
      }

      directoryTree = nextTree;
    }

    // --- 阶段 4：「其它」的二次处理 ---
    //
    // 第一轮没归类的书签不该直接丢给用户。它们之间往往还有共同主题，
    // 再问一次模型，允许它新建少量顶层目录，把「其它」拆干净。
    let refinedFallback = 0;
    if (globalScope && canUseAI) {
      const leftoverIds = directoryTree[UNCLASSIFIED_DIR] ?? [];
      if (leftoverIds.length >= MIN_FALLBACK_FOR_REFINE) {
        updateProgress(
          total, total,
          progressText(locale, 'refiningFallback', { count: leftoverIds.length }),
        );
        const byId = new Map(bookmarks.map((b) => [b.id, b]));
        const items = leftoverIds.map((id) => ({
          id,
          title: byId.get(id)?.title ?? '',
          url: byId.get(id)?.url ?? '',
        }));
        const refined = await refineFallback(
          items,
          [...allowedTop.values(), ...RULE_TOP_LEVELS],
          settings,
          maxDepth,
        );

        const nextTree: Record<string, string[]> = { ...directoryTree };
        delete nextTree[UNCLASSIFIED_DIR];
        const remaining: string[] = [];
        for (const id of leftoverIds) {
          const path = refined[id];
          const normalized = path && path !== UNCLASSIFIED_DIR ? path : undefined;
          if (normalized) {
            nextTree[normalized] = [...(nextTree[normalized] ?? []), id];
            refinedFallback++;
          } else {
            remaining.push(id);
          }
        }
        if (remaining.length > 0) nextTree[UNCLASSIFIED_DIR] = remaining;
        directoryTree = nextTree;
      }
    }

    const detailParts: string[] = [];

    // 只有两三条书签的一级目录并回「其它」：顶层是给领域用的，
    // 二次处理时模型会给 2 条书签造一个「论坛」顶层
    if (globalScope) {
      const smallFolded = foldSmallTopLevels(
        directoryTree, MIN_TOP_FOR_KEEP, new Set(RULE_TOP_LEVELS), UNCLASSIFIED_DIR,
      );
      directoryTree = smallFolded.tree;
      if (smallFolded.folded > 0) {
        detailParts.push(`合并了 ${smallFolded.folded} 个过小的一级目录`);
      }
    }

    // Linux 下的通用领域词（硬件/编程）换成它自己的维度词，
    // 否则会和「驱动」「设备管理」重复
    if (globalScope) {
      const normalized = normalizeSubfoldersUnderTop(
        directoryTree, LINUX_TOP, LINUX_ALLOWED_SUBS, LINUX_SUB_ALIASES, LINUX_SUB_FALLBACK,
      );
      directoryTree = normalized.tree;
      if (normalized.renamed > 0) {
        detailParts.push(`规范了 ${normalized.renamed} 个 ${LINUX_TOP} 的二级目录名`);
      }
    }
    if (outcome.detail) detailParts.push(outcome.detail);
    if (droppedToUnclassified > 0) {
      detailParts.push(`${droppedToUnclassified} 条书签的目录不在分类法内，已归入「其它」`);
    }
    if (tutorialFoldedCount > 0) {
      detailParts.push(`把 ${tutorialFoldedCount} 类教程搬回对应领域`);
    }
    if (nestedFolded.folded > 0) {
      detailParts.push(`把 ${nestedFolded.folded} 个嵌套目录提回一级`);
    }
    if (bareSplit > 0) {
      detailParts.push(`为 ${bareSplit} 条书签补上了二级目录`);
    }
    if (folded.moved > 0) {
      detailParts.push(`把 ${folded.moved} 个目录折回一级「${STORAGE_TOP}」`);
    }
    if (collapsedInfo.collapsed > 0) {
      detailParts.push(`合并了 ${collapsedInfo.collapsed} 个只装 1 条书签的目录`);
    }

    const stats = statsFor({
      skeletonCount: initialPaths.length,
      assigned: assignedIds.size,
      overflow: 0,
      overflowDirectories: outcome.createdPaths.length,
      unassigned: unassignedIds.length,
      warning: outcome.usedAi
        ? undefined
        : canUseAI
          ? 'ai-naming-failed'
          : 'ai-unavailable',
      warningDetail: detailParts.length > 0 ? detailParts.join('；') : undefined,
    });

    finish(directoryTree, initialPaths, outcome.createdPaths, stats);
  } catch (err) {
    task.status = 'failed';
    task.error = String(err);
    throw err;
  }
}

async function handleOrganizeExecute(
  directoryTree: Record<string, readonly string[]>,
  rootId: string,
): Promise<unknown> {
  let moved = 0;
  // 已经在目标目录里的书签不该算「已移动」——它们在 fit 模式下占绝大多数，
  // 混进 moved 会让人以为整理干了活，实际一条都没动
  let inPlace = 0;
  let skipped = 0;
  let failed = 0;
  const failures: string[] = [];
  const allVectors = await db.getAllVectors();
  const vectorMap = new Map(allVectors.map((v) => [v.id, v.vector]));

  // 防御性校验：即便上游没拦住，执行阶段也不新建目录。
  // 预览与执行之间用户可能改了设置，这里以执行时的设置为准。
  const settings = await getSettings();
  const existingPaths = settings.onlyUseExistingDirectories
    ? new Set(await getDirectoryPathsUnder(rootId))
    : null;

  // 记录每个书签原本在哪个目录，整理结束后只清理这些被搬空的目录
  const parentOf = await buildParentMap();
  const emptied = new Set<string>();
  // 实际用到的目录路径——「东西被建到哪儿去了」在界面上原本完全看不见
  const paths: string[] = [];

  // 先拍拆卸点：整理一旦开始就改不回来了，快照必须发生在任何一次 move 之前。
  // 快照写失败不阻断整理（整理本身仍然可用），但要在结果里说清楚，
  // 否则用户会以为「撤销」按钮消失只是界面问题。
  //
  // 先把上一份读出来：整理有可能一条都不动（重复跑已整理好的收藏夹），
  // 那次空跑不该把上一份有意义的拆卸点顶掉。
  let snapshotSaved = false;
  let previousSnapshot: OrganizeSnapshot | undefined;
  try {
    previousSnapshot = await db.getOrganizeSnapshot(SNAPSHOT_ID);
    await db.putOrganizeSnapshot(await captureSnapshot());
    snapshotSaved = true;
  } catch (err) {
    console.error('[BM] Failed to capture organize snapshot:', err);
  }

  const createdFolderIds = new Set<string>();

  for (const [path, bookmarkIds] of Object.entries(directoryTree)) {
    if (existingPaths && !existingPaths.has(path)) {
      skipped += bookmarkIds.length;
      continue;
    }

    // Create folder path
    const { id: folderId, createdIds } = await findOrCreateFolderPath(path.split('/'), rootId);
    for (const id of createdIds) createdFolderIds.add(id);
    paths.push(path);

    // Move bookmarks to this folder
    for (const bookmarkId of bookmarkIds) {
      const sourceId = parentOf.get(bookmarkId);
      if (sourceId === folderId) {
        inPlace++;
        continue;
      }
      try {
        await moveBookmark(bookmarkId, folderId);
        if (sourceId) emptied.add(sourceId);
        // 必须同步更新快照：后面处理另一个目录时还会查它。用移动前的旧位置判断
        // 「是否已在目标目录」会得出错误结论，把该移动的书签当成已就位跳过
        parentOf.set(bookmarkId, folderId);
        moved++;
      } catch (err) {
        // 失败必须带出来：service worker 的日志在界面上看不到，
        // 静默跳过会让「整理没反应」变成一个查不出的谜。
        // 计数**不封顶**（列表只留前 5 条）：`failed: 5` 在 300 条失败时
        // 会把「大面积失败」说成「零星失败」，这是最需要看见的信号
        failed++;
        if (failures.length < 5) failures.push(`${bookmarkId}: ${String(err)}`);
        console.warn(`[BM] Failed to move bookmark ${bookmarkId}:`, err);
      }
    }

    // Compute and save directory vector for realtime archiving
    const vectors: Float32Array[] = [];
    for (const id of bookmarkIds) {
      const vec = vectorMap.get(id);
      if (vec) vectors.push(vec);
    }

    if (vectors.length > 0) {
      const dirVector = computeDirectoryVector(vectors);
      await db.putDirectoryVector({
        id: folderId,
        vector: dirVector,
        name: path,
        childCount: bookmarkIds.length,
      });
    }
  }

  // 清理本次搬空的目录。作用域根（用户点名要整理的那个文件夹）排除在外：
  // 允许移出时它可能被搬空，但把用户刚整理的那个目录本身删掉不是他要的结果
  const pruneResult = await pruneEmptiedFolders(emptied, new Set([rootId]));
  let pruned = pruneResult.pruned;
  const removedIds = [...pruneResult.removedIds];

  // 全局整理后，还有一类残留：整理前就已经空着、这次也没被方案选中的顶层目录。
  // prune 不碰它们（它只处理「本轮搬空的」，以保护用户留的占位目录），
  // 但全局整理换了整套分类法之后，这些名字已经不属于新结构，留着就是「没删干净」。
  //
  // 规则收得很窄：只删**顶层**、只删**空**。深层空目录仍按原规则保护——
  // 用户可能留了「稍后阅读」这类占位，而顶层分类法上的残留是另一回事。
  if (rootId === (await getRootFolderId())) {
    const plannedTops = new Set(
      Object.keys(directoryTree).map((path) => path.split('/')[0].toLowerCase()),
    );
    for (const child of await chrome.bookmarks.getChildren(rootId)) {
      if (child.url || plannedTops.has(child.title.toLowerCase())) continue;
      const kids = await chrome.bookmarks.getChildren(child.id).catch(() => null);
      if (kids === null || kids.length > 0) continue;
      try {
        await chrome.bookmarks.remove(child.id);
        removedIds.push(child.id);
        pruned++;
      } catch (err) {
        console.warn(`[BM] Failed to remove leftover top-level folder ${child.title}:`, err);
      }
    }
  }

  // 目录没了，它的目录向量还指着这个 id。不清掉的话，实时归档会把新收藏的书签
  // 往一个不存在的目录搬——`moveBookmark` 抛错并被吞掉，表现成「自动归档没反应」
  for (const id of removedIds) {
    await db.deleteDirectoryVector(id).catch(() => {});
  }

  // 把「本次新建了哪些目录」补进快照——撤销时靠它把空壳删干净。
  // 这一步失败不影响整理结果，只是让撤销退化成「还原书签、保留新目录」
  if (snapshotSaved) {
    if (createdFolderIds.size > 0) {
      try {
        const snapshot = await db.getOrganizeSnapshot(SNAPSHOT_ID);
        if (snapshot) {
          await db.putOrganizeSnapshot({ ...snapshot, createdFolderIds: [...createdFolderIds] });
        }
      } catch (err) {
        console.error('[BM] Failed to record created folders in snapshot:', err);
      }
    }

    // 一条都没动：这次空跑不该顶掉上一份有意义的拆卸点
    if (moved === 0 && createdFolderIds.size === 0) {
      try {
        if (previousSnapshot) await db.putOrganizeSnapshot(previousSnapshot);
        else await db.deleteOrganizeSnapshot(SNAPSHOT_ID);
      } catch (err) {
        console.error('[BM] Failed to restore previous snapshot:', err);
      }
    }
  }

  return { moved, inPlace, skipped, pruned, failed, failures, paths };
}

/**
 * 「撤销整理」的可用性查询。
 *
 * 只回时间戳，不回快照本体——快照可能有几千个节点，
 * 每次打开向导都把它搬过消息通道没有必要。
 */
async function handleOrganizeSnapshotInfo(): Promise<unknown> {
  const snapshot = await db.getOrganizeSnapshot(SNAPSHOT_ID);
  if (!snapshot) return { available: false };
  return { available: true, createdAt: snapshot.createdAt };
}

/**
 * 把书签树还原到上次整理之前。
 *
 * **只有完全成功才删快照**：回退会返回失败清单而不是抛错，如果照样把快照删掉，
 * 用户既看到「有 N 条没还原回去」，又失去了唯一的重试手段——树就停在半还原状态。
 * 失败时保留快照，再点一次即可重试（回退本身是幂等的：已在原位的不会再动）。
 */
async function handleOrganizeRollback(): Promise<unknown> {
  // 两次回退交错会各自通过「快照还在」的检查，然后各自补建一遍目录
  if (rollbackInFlight) {
    throw new Error('上一次撤销还在进行中');
  }

  const snapshot = await db.getOrganizeSnapshot(SNAPSHOT_ID);
  if (!snapshot) {
    throw new Error(progressText((await getSettings()).language, 'undoNone'));
  }

  rollbackInFlight = true;
  try {
    const result = await rollbackToSnapshot(snapshot);

    if (result.failed > 0) return result;

    await db.deleteOrganizeSnapshot(SNAPSHOT_ID);

    // 只清掉被删除/换了 id 的那些目录的向量——它们的 id 已经指向不存在的目录，
    // 留着会让新收藏的书签被自动归进空气里。其它目录的向量与本次回退无关，
    // 整表清空会让实时归档对所有目录一起失效
    for (const id of result.affectedFolderIds) {
      await db.deleteDirectoryVector(id).catch(() => {});
    }

    return result;
  } finally {
    rollbackInFlight = false;
  }
}

/** id → 父目录 id 的全量映射，用于判断书签是从哪个目录搬走的 */
async function buildParentMap(): Promise<Map<string, string>> {
  const tree = await chrome.bookmarks.getTree();
  const parentOf = new Map<string, string>();

  const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[]): void => {
    for (const node of nodes) {
      if (node.parentId) parentOf.set(node.id, node.parentId);
      if (node.children) walk(node.children);
    }
  };

  walk(tree);
  return parentOf;
}

// --- Folder Structure ---

/** 目录下的书签数，含所有子目录 */
function countBookmarksIn(node: chrome.bookmarks.BookmarkTreeNode): number {
  let total = node.url ? 1 : 0;
  for (const child of node.children ?? []) total += countBookmarksIn(child);
  return total;
}

/**
 * 让 AI 把现有的一级目录收敛成一套分类法（≤ MAX_TOP_LEVELS 个）。
 *
 * 这一步独立于逐批归档：它看的是「全集」，所以能做出全局一致的决定。
 * 返回里同时带上现有目录及计数，界面上可以直接对照着改。
 */
async function handleSuggestTaxonomy(): Promise<unknown> {
  const settings = await getSettings();
  const tree = await chrome.bookmarks.getTree();
  const bar = tree[0]?.children?.[0];

  const existing: ExistingTopLevel[] = (bar?.children ?? [])
    .filter((node) => !node.url)
    .map((node) => ({ name: node.title, count: countBookmarksIn(node) }))
    .sort((a, b) => b.count - a.count);

  const suggestion = await suggestTaxonomy(existing, settings, RULE_TOP_LEVELS);
  return { ...suggestion, existing };
}


async function handleGetFolderStructure(): Promise<unknown> {
  const tree = await chrome.bookmarks.getTree();
  const root = tree[0]?.children?.[0];
  if (!root) return [];

  interface FolderInfo {
    id: string;
    title: string;
    path: string;
    count: number;
  }

  function collectFolders(node: chrome.bookmarks.BookmarkTreeNode, parentPath: string): FolderInfo[] {
    const results: FolderInfo[] = [];
    if (!node.children) return results;

    for (const child of node.children) {
      if (!child.url) { // It's a folder
        const currentPath = parentPath ? `${parentPath}/${child.title}` : child.title;
        results.push({
          id: child.id,
          title: child.title,
          path: currentPath,
          count: countBookmarksIn(child),
        });
        results.push(...collectFolders(child, currentPath));
      }
    }
    return results;
  }

  return collectFolders(root, '');
}


// --- AI Connection Test ---

async function handleTestAIConnection(): Promise<{ ok: boolean; message: string }> {
  const settings = await getSettings();
  if (!settings.apiEndpoint) {
    return { ok: false, message: '请先填写 API 端点' };
  }
  if (!settings.apiModel) {
    return { ok: false, message: '请先填写模型名称' };
  }
  const format = settings.apiFormat ?? 'openai';
  const isAnthropic = format === 'anthropic';
  const chatUrl = isAnthropic
    ? resolveMessagesEndpoint(settings.apiEndpoint)
    : resolveChatEndpoint(settings.apiEndpoint);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.apiKey) {
    if (isAnthropic) {
      headers['x-api-key'] = settings.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${settings.apiKey}`;
    }
  } else if (!isAnthropic) {
    headers['Authorization'] = 'Bearer no-key';
  }

  const body = isAnthropic
    ? JSON.stringify({ model: settings.apiModel, max_tokens: 5, messages: [{ role: 'user', content: 'Say OK' }] })
    : JSON.stringify({ model: settings.apiModel, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 5 });

  try {
    const response = await fetch(chatUrl, { method: 'POST', headers, body });
    if (response.ok) {
      const data = await response.json().catch(() => null);
      const reply = isAnthropic
        ? (data?.content?.[0]?.text ?? '')
        : (data?.choices?.[0]?.message?.content ?? '');
      return { ok: true, message: `连接成功 (${chatUrl})${reply ? '\n模型回复: ' + reply.trim() : ''}` };
    }
    const bodyText = await response.text().catch(() => '');
    const detail = bodyText ? bodyText.slice(0, 150) : response.statusText;
    return { ok: false, message: `HTTP ${response.status} — ${chatUrl}\n${detail}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `无法连接到 ${chatUrl}\n${msg}` };
  }
}

// --- Index ---

async function handleGetIndexStats(): Promise<unknown> {
  const vectorCount = await db.getVectorCount();
  const bookmarks = await getAllBookmarks();
  return { indexed: vectorCount, total: bookmarks.length };
}

async function handleRebuildIndex(): Promise<unknown> {
  const settings = await getSettings();
  const bookmarks = await getAllBookmarks();
  await db.clear('vectors');
  const total = bookmarks.length;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = bookmarks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((b) => `${b.title} ${b.url} ${b.path}`);
    const vectors = await generateEmbeddingsBatch(texts, settings.embeddingEndpoint);

    for (let j = 0; j < batch.length; j++) {
      await db.putVector({
        id: batch[j].id,
        vector: vectors[j],
        text: texts[j],
        updatedAt: Date.now(),
      });
    }

    // Broadcast progress
    const indexed = Math.min(i + BATCH_SIZE, total);
    chrome.runtime.sendMessage({
      type: 'REBUILD_INDEX_PROGRESS',
      current: indexed,
      total,
      message: `索引构建中 (${indexed}/${total})`,
    }).catch(() => {});
  }

  return { indexed: total };
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
    // Get bookmark with path from getAllBookmarks to ensure consistency
    const allBookmarks = await getAllBookmarks();
    const bm = allBookmarks.find((b) => b.id === id);
    if (!bm) return;

    const text = `${bm.title} ${bm.url} ${bm.path}`;
    const { embeddingEndpoint } = await getSettings();
    const vector = await generateEmbedding(text, embeddingEndpoint);
    await db.putVector({
      id,
      vector,
      text,
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.error('[BM] Index update failed:', err);
  }
});

chrome.bookmarks.onRemoved.addListener(async (id) => {
  await db.deleteVector(id);
  await db.deletePageSummary(id).catch(() => {});
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
