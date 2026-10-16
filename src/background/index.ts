import { getAllBookmarks, moveBookmark, removeBookmark, findOrCreateFolderPath, getRootFolderId, getDirectoryPathsUnder, getExistingFolders, resolveMergeGroup, collectSubtreeBookmarkIds } from './bookmarkService';
import { generateEmbedding, generateEmbeddingsBatch } from './embeddingClient';
import { rerank } from './rerankerClient';
import { findExactUrlDuplicates, findSameTitleDuplicates, scoreL1, scoreL2Content, scoreL3, buildDedupGroups } from './dedupEngine';
import { buildDomainClusters, computeDirectoryCohesion, computeDirectoryVector, buildSemanticClusters, assignToSkeleton, groupOverflow, mergeDirectoryTree, buildSkeletonFromFolders, averageVectors, buildHierarchicalClusters, mergeSkeletonByPath } from './organizeEngine';
import type { SkeletonNode, OverflowItem, SemanticCluster, OverflowGroup, HierarchicalCluster } from './organizeEngine';
import { callCloudAPI, resolveChatEndpoint, resolveMessagesEndpoint, buildClassificationPrompt, parseClassificationResponse, isLowInfoTitle, buildFineDedupPrompt, parseFineDedupResponse, buildClusterNamingPrompt, buildHierarchicalNamingPrompt, parseClusterNamingResponse } from './apiClient';
import { handleNewBookmark } from './realtimeArchiver';
import { BookmarkDB } from '@/shared/db';
import { cosineSimilarity } from '@/shared/vectorSearch';
import { suggestDirectoryName, normalizeDirectoryPath } from '@/shared/directoryNaming';
import { DEFAULT_SETTINGS, BATCH_SIZE, DEPRECATED_API_ENDPOINTS, DEPRECATED_API_MODELS, ASSIGN_ACCEPT_THRESHOLD, UNCLASSIFIED_DIR, NEUTRAL_SCORE, DEDUP_WEIGHTS, MAX_SUB_CLUSTERS } from '@/shared/constants';
import type { AppSettings, QualityScores, BookmarkNode, OrganizeStats, OrganizeMode } from '@/shared/types';
import type { MessageRequest, MessageResponse, AsyncTask } from '@/shared/messageTypes';

const db = new BookmarkDB();

// Async task storage
const asyncTasks = new Map<string, AsyncTask>();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// --- Settings helpers ---

async function getSettings(): Promise<AppSettings> {
  const stored = await db.getSetting('appSettings') as Partial<AppSettings> | undefined;
  const merged = { ...DEFAULT_SETTINGS, ...stored };

  // A persisted config still pointing at a retired gateway would leave every AI
  // feature failing with no obvious cause — fall back to the current default.
  const endpoint = (stored?.apiEndpoint ?? '').replace(/\/+$/, '');
  if (endpoint && DEPRECATED_API_ENDPOINTS.includes(endpoint)) {
    return {
      ...merged,
      apiEndpoint: DEFAULT_SETTINGS.apiEndpoint,
      apiModel: DEFAULT_SETTINGS.apiModel,
      apiFormat: DEFAULT_SETTINGS.apiFormat,
    };
  }

  // 模型同样会下架：网关对已下架模型直接回 400，而 {...DEFAULT, ...stored}
  // 里 stored 优先，光改默认值对老用户不生效。只迁移 endpoint 盖不住这种情况。
  if (stored?.apiModel && DEPRECATED_API_MODELS.includes(stored.apiModel)) {
    return { ...merged, apiModel: DEFAULT_SETTINGS.apiModel };
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

    case 'GENERATE_EMBEDDING':
      // Float32Array does not survive chrome.runtime.sendMessage's JSON
      // serialization — it arrives as {0:..,1:..} with no length. Return a
      // plain number[] to match the documented contract.
      return Array.from(await generateEmbedding(msg.text));

    case 'GENERATE_EMBEDDINGS_BATCH':
      return (await generateEmbeddingsBatch(msg.texts)).map((v) => Array.from(v));

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

    case 'ORGANIZE_SEMANTIC_CLUSTER':
      return handleSemanticCluster(msg.bookmarkIds);

    case 'ORGANIZE_CONNECTIVITY_CHECK':
      return handleConnectivityCheck(msg.bookmarkIds);

    case 'ORGANIZE_AI_CLASSIFY_START':
      return handleAIClassifyStart(msg.bookmarkIds, msg.scope, msg.folderId, msg.categories, msg.mode);

    case 'ORGANIZE_AI_CLASSIFY_POLL':
      return handleAIClassifyPoll(msg.taskId);

    case 'ORGANIZE_EXECUTE':
      return handleOrganizeExecute(msg.directoryTree, msg.rootId);

    case 'GET_FOLDER_STRUCTURE':
      return handleGetFolderStructure();

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
  const queryVector = await generateEmbedding(query);

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
      const scores = await rerank(query, candidateTexts);
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
  // Return ALL domains (minCount=1) so user can choose which to use as directories
  return buildDomainClusters(filteredBookmarks, 1);
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
        `检测中 (${done}/${filteredIds.length})`);
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
    const folderId = await findOrCreateFolderPath(['[待删除_失效]'], rootId);
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
): Promise<{ taskId: string }> {
  const taskId = generateTaskId();

  asyncTasks.set(taskId, {
    id: taskId,
    status: 'pending',
    progress: { current: 0, total: 1, message: '正在准备...' },
  });

  const settings = await getSettings();
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

  processAIClassify(taskId, bookmarks, settings, mode, categories, mergedFolderNames).catch((err) => {
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
 * 把分层聚类落成目录骨架。
 *
 * 层级由代码拼：大类名 + 子类名 → `大类/子类`。模型只负责给每一段起名字，
 * 不需要理解「这几个子类属于同一个大类」，所以层级不会被它搞乱。
 */
function buildHierarchicalSkeleton(
  groups: readonly HierarchicalCluster[],
  names: Readonly<Record<string, string>>,
  vectorMap: ReadonlyMap<string, Float32Array>,
): SkeletonNode[] {
  const nodes: SkeletonNode[] = [];

  groups.forEach((group, i) => {
    const topName = names[String(i)] || group.top.topicName || `分类${i + 1}`;

    if (group.children.length === 0) {
      nodes.push({
        path: topName,
        memberIds: group.top.bookmarkIds,
        centroid: group.top.centroid,
        isOverflow: false,
      });
      return;
    }

    group.children.forEach((child, j) => {
      const subName = names[`${i}.${j}`] || child.topicName || `子类${j + 1}`;
      // 走一遍归一化：降级命名时父子可能拿到同一个词（「文档/文档」），
      // normalizeDirectoryPath 会折叠连续重复段
      nodes.push({
        path: normalizeDirectoryPath(`${topName}/${subName}`),
        memberIds: child.bookmarkIds,
        centroid: child.centroid,
        isOverflow: false,
      });
    });
  });

  return nodes;
}

/** 给分层聚类命名。与 nameClusters 同构，只是输入输出带上了层级 */
async function nameHierarchical(
  groups: readonly HierarchicalCluster[],
  titleById: ReadonlyMap<string, string>,
  settings: AppSettings,
  canUseAI: boolean,
  userCategories: readonly string[] | undefined,
): Promise<NamingOutcome> {
  const fallback: Record<string, string> = {};
  groups.forEach((group, i) => {
    fallback[String(i)] = group.top.topicName;
    group.children.forEach((child, j) => {
      fallback[`${i}.${j}`] = child.topicName;
    });
  });

  if (!canUseAI) return { paths: fallback, usedAi: false, detail: '未配置可用的模型' };

  const titlesOf = (ids: readonly string[]): string[] =>
    ids.slice(0, 8).map((id) => titleById.get(id) ?? '').filter(Boolean);

  const input = groups.map((group, i) => ({
    groupId: String(i),
    titles: titlesOf(group.top.bookmarkIds),
    children: group.children.map((child, j) => ({
      id: `${i}.${j}`,
      titles: titlesOf(child.bookmarkIds),
    })),
  }));

  const prompt = buildHierarchicalNamingPrompt(input, userCategories);
  const ATTEMPTS = 2;
  let lastDetail = '';

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const raw = await callCloudAPI(prompt, settings);
      const parsed = parseClusterNamingResponse(raw);
      // 至少要有一个大类被命名，否则整份输出都是废的
      const covered = groups.filter((_, i) => parsed[String(i)]).length;
      if (covered > 0) {
        return { paths: { ...fallback, ...parsed }, usedAi: true };
      }
      lastDetail = `模型输出解析不出任何大类（${raw.length} 字符）: ${raw.trim().slice(0, 150)}`;
    } catch (err) {
      console.warn(`[Organize] 分层命名第 ${attempt} 次失败:`, err);
      lastDetail = String(err).slice(0, 300);
    }
  }

  console.warn('[Organize] 分层命名失败，退回关键词命名:', lastDetail);
  return { paths: fallback, usedAi: false, detail: lastDetail };
}

/** 给溢出新建的目录命名。它们是平级目录，所以深度固定为 1 */
async function nameOverflowGroups(
  groups: readonly OverflowGroup[],
  settings: AppSettings,
  canUseAI: boolean,
): Promise<string[]> {
  const fallback = groups.map((group) => suggestDirectoryName(group.titles));
  if (!canUseAI || groups.length === 0) return fallback;

  try {
    const clusterInput = groups.map((group, i) => ({
      clusterId: String(i),
      titles: group.titles.slice(0, 12),
    }));
    const raw = await callCloudAPI(buildClusterNamingPrompt(clusterInput, 1), settings);
    // 强制 1 层：模型偶尔会无视 prompt 里的深度约束，回出 "户外/露营" 这种两层路径
    const parsed = parseClusterNamingResponse(raw, 1);
    return groups.map((_, i) => parsed[String(i)] || fallback[i]);
  } catch (err) {
    console.warn('[Organize] 溢出目录命名失败，退回关键词命名:', err);
    return fallback;
  }
}

/**
 * 整理流程：定骨架 → 逐条归位 → 溢出成组 → 汇合。
 *
 * 骨架来源由 mode 决定：
 *   fit    —— 现有目录结构。归得对的书签移动是空操作，归错的才会被移走，
 *             所以可以反复整理而不会来回搬动。
 *   replan —— 分层聚类重新生成（先分大类，再在大类内细分一层）。
 * 无论哪种，每条书签的最终归属都由它自己的向量与各目录中心的余弦决定。
 */
async function processAIClassify(
  taskId: string,
  bookmarks: readonly BookmarkNode[],
  settings: AppSettings,
  mode: OrganizeMode,
  userCategories?: readonly string[],
  mergedFolderNames: readonly string[] = [],
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

    if (total === 0) {
      finish({}, [], [], statsFor({}));
      return;
    }

    // --- 阶段 0：补齐向量 ---
    updateProgress(0, total, `获取向量中 (0/${total})`);
    const allVectors = await db.getAllVectors();
    const vectorMap = new Map(allVectors.map((v) => [v.id, v.vector]));

    const missing = bookmarks.filter((b) => !vectorMap.has(b.id));
    if (missing.length > 0) {
      for (let i = 0; i < missing.length; i += BATCH_SIZE) {
        const batch = missing.slice(i, i + BATCH_SIZE);
        const texts = batch.map((b) => `${b.title} ${b.url}`);
        const vectors = await generateEmbeddingsBatch(texts);
        for (let j = 0; j < batch.length; j++) {
          vectorMap.set(batch[j].id, vectors[j]);
          await db.putVector({ id: batch[j].id, vector: vectors[j], text: texts[j], updatedAt: Date.now() });
        }
        updateProgress(i + batch.length, missing.length, `生成向量中 (${i + batch.length}/${missing.length})`);
      }
    }

    const vectors = bookmarks
      .map((b) => ({ id: b.id, vector: vectorMap.get(b.id) }))
      .filter((v): v is { id: string; vector: Float32Array } => v.vector !== undefined);

    const titleById = new Map(bookmarks.map((b) => [b.id, b.title]));

    // 书签太少，聚类没有意义
    if (vectors.length < 4) {
      finish({ [UNCLASSIFIED_DIR]: bookmarks.map((b) => b.id) }, [], [], statsFor({}));
      return;
    }

    const canUseAI = Boolean(
      settings.apiEndpoint && (settings.apiFormat === 'anthropic' || settings.apiKey),
    );

    // --- 阶段 1：定骨架 ---
    // fit（默认）：骨架取自**现有目录结构**。归得对的书签自然匹配到自己所在的目录，
    //   移动变成空操作；归错的才会匹配到别处从而被移走。「正确的不动、错误的被纠正」
    //   由此结构性成立，不靠任何「已归类」记账，重复整理也就安全了。
    // replan：每次重新聚类生成骨架，目录结构会重构（推倒重来的场景）。
    let skeleton: SkeletonNode[] = [];
    // 骨架是否真的来自现有目录。聚类生成的骨架里 memberIds 是「簇成员」而非
    // 「已在该目录里」，不能拿来做「无需移动」的判断
    let skeletonFromFolders = false;

    if (mode === 'fit') {
      const rootFolderId = await getRootFolderId();
      const folders = await getExistingFolders(rootFolderId);
      const usable = folders.filter(
        (f) =>
          f.bookmarkIds.length > 0 &&
          f.path !== UNCLASSIFIED_DIR &&
          !f.path.includes('[待删除_失效]'),
      );
      updateProgress(0, usable.length, `读取现有目录 (${usable.length} 个)`);
      skeleton = buildSkeletonFromFolders(usable, vectorMap);
      skeletonFromFolders = skeleton.length > 0;
    }

    // 没有可用目录（首次整理）或用户选择重新规划 → 退回聚类生成骨架
    let namedWithAi: boolean | null = null;
    let namingDetail: string | undefined;

    if (skeleton.length === 0) {
      // 分层聚类：按「目标每目录条数」反推簇数，并在大类内再细分一层。
      // 单层 K-means 只能靠书签总数猜粒度，1643 条书签给 18 个目录、每目录 91 条，
      // 等于没整理。organizeMaxDepth=1 时用户明确不要层级，就不细分。
      const maxSub = (settings.organizeMaxDepth ?? 3) >= 2 ? MAX_SUB_CLUSTERS : 0;
      updateProgress(0, total, '语义聚类中');
      const groups = buildHierarchicalClusters(vectors, [...bookmarks], { maxSub });

      if (groups.length === 0) {
        finish({ [UNCLASSIFIED_DIR]: bookmarks.map((b) => b.id) }, [], [], statsFor({}));
        return;
      }

      const leafCount = groups.reduce((n, g) => n + Math.max(1, g.children.length), 0);
      updateProgress(0, groups.length, `AI 命名中 (${groups.length} 个大类 / ${leafCount} 个目录)`);
      const naming = await nameHierarchical(groups, titleById, settings, canUseAI, userCategories);
      updateProgress(groups.length, groups.length, 'AI 命名完成');
      namedWithAi = naming.usedAi;
      namingDetail = naming.detail;

      skeleton = buildHierarchicalSkeleton(groups, naming.paths, vectorMap);

      // 「只使用已有目录」时，骨架里不存在于书签树的目录一律不建。
      // 必须用 getDirectoryPathsUnder（相对书签栏）——findOrCreateFolderPath 的基准
      // 就是书签栏，用从书签树根开始走的路径会多一层前缀，永远匹配不上。
      if (settings.onlyUseExistingDirectories) {
        const existing = new Set(await getDirectoryPathsUnder(await getRootFolderId()));
        skeleton = skeleton.filter((node) => existing.has(node.path));
      }
    }

    // 路径重复会让 bucketize 产出重复的桶（同一批书签被写进多个目录）
    skeleton = mergeSkeletonByPath(skeleton);

    // --- 阶段 2：逐条归位 ---
    updateProgress(0, total, `归位中 (0/${total})`);
    const assignment = assignToSkeleton(vectors, skeleton, ASSIGN_ACCEPT_THRESHOLD);
    updateProgress(total, total, '归位完成');

    // fit 模式下，骨架的成员就是各目录现有的书签。若每条书签都已经在它该去的
    // 目录里，整理结果就是「原地不动」——这在书签全挤在一个文件夹时必然发生，
    // 而界面上看不出任何变化，用户只会以为功能坏了。明确报出来。
    let needMove = Number.POSITIVE_INFINITY;
    if (skeletonFromFolders) {
      const alreadyHome = assignment.assigned.reduce((sum, bucket) => {
        const node = skeleton.find((s) => s.path === bucket.path);
        const own = new Set(node?.memberIds ?? []);
        return sum + bucket.ids.filter((id) => own.has(id)).length;
      }, 0);
      needMove =
        assignment.assigned.reduce((sum, b) => sum + b.ids.length, 0) -
        alreadyHome +
        assignment.overflowIds.length;
    }

    // --- 阶段 3：溢出成组 ---
    let overflowEntries: { path: string; ids: string[] }[] = [];
    let unassignedIds = [...assignment.overflowIds];

    if (assignment.overflowIds.length > 0 && !settings.onlyUseExistingDirectories) {
      updateProgress(0, assignment.overflowIds.length, `处理 ${assignment.overflowIds.length} 条未归位书签`);

      const overflowItems: OverflowItem[] = assignment.overflowIds
        .map((id) => {
          const vector = vectorMap.get(id);
          const bookmark = bookmarks.find((b) => b.id === id);
          if (!vector || !bookmark) return null;
          return { id, vector, title: bookmark.title };
        })
        .filter((item): item is OverflowItem => item !== null);

      const overflow = groupOverflow(overflowItems);
      const names = await nameOverflowGroups(overflow.groups, settings, canUseAI);

      overflowEntries = overflow.groups.map((group, i) => ({
        path: names[i],
        ids: [...group.ids],
      }));
      unassignedIds = [...overflow.unassignedIds];
    }

    // --- 阶段 4：汇合 ---
    const assignedIds = new Set(assignment.assigned.flatMap((b) => b.ids));
    const accounted = new Set([...assignedIds, ...unassignedIds]);
    // 没有向量、因而没参与归位的书签，一并落进未分类——保证 Σ成员 + 未分类 === 总数
    unassignedIds = [...unassignedIds, ...bookmarks.filter((b) => !accounted.has(b.id)).map((b) => b.id)];

    const directoryTree = mergeDirectoryTree(
      [...assignment.assigned.map((b) => ({ path: b.path, ids: [...b.ids] })), ...overflowEntries],
      unassignedIds,
    );

    const stats = statsFor({
      skeletonCount: skeleton.length,
      assigned: assignedIds.size,
      overflow: assignment.overflowIds.length,
      overflowDirectories: overflowEntries.length,
      unassigned: unassignedIds.length,
      warning:
        (needMove === 0 ? 'nothing-to-do' : undefined) ??
        assignment.warning ??
        (namedWithAi === null
          ? undefined
          : namedWithAi
            ? undefined
            : canUseAI
              ? 'ai-naming-failed'
              : 'ai-unavailable'),
      warningDetail: namingDetail,
    });

    finish(
      directoryTree,
      skeleton.map((node) => node.path),
      overflowEntries.map((entry) => entry.path),
      stats,
    );
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
  const failures: string[] = [];
  const allVectors = await db.getAllVectors();
  const vectorMap = new Map(allVectors.map((v) => [v.id, v.vector]));

  // 防御性校验：即便上游没拦住，执行阶段也不新建目录。
  // 预览与执行之间用户可能改了设置，这里以执行时的设置为准。
  const settings = await getSettings();
  const existingPaths = settings.onlyUseExistingDirectories
    ? new Set(await getDirectoryPathsUnder(await getRootFolderId()))
    : null;

  // 记录每个书签原本在哪个目录，整理结束后只清理这些被搬空的目录
  const parentOf = await buildParentMap();
  const emptied = new Set<string>();

  for (const [path, bookmarkIds] of Object.entries(directoryTree)) {
    if (existingPaths && !existingPaths.has(path)) {
      skipped += bookmarkIds.length;
      continue;
    }

    // Create folder path
    const pathParts = path.split('/');
    const folderId = await findOrCreateFolderPath(pathParts, rootId);

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
        // 静默跳过会让「整理没反应」变成一个查不出的谜
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

  // 清理本次搬空的目录（不动用户自己留的空文件夹）
  const pruned = await pruneEmptiedFolders(emptied);

  return { moved, inPlace, skipped, pruned, failed: failures.length, failures };
}

/**
 * 只删除**本次整理搬空的**目录。
 *
 * 原实现从书签栏递归删除任何空目录——包括用户自己留的空文件夹。跑一次整理
 * （哪怕一条书签都没移动）就会把「稍后阅读」这类占位目录删掉；在
 * `onlyUseExistingDirectories=true` 下尤其矛盾，那个开关的语义正是保持用户既有结构。
 *
 * 现在只考虑「被搬走过书签的父目录」，且删除时再次确认它确实空了。
 * 删掉一个目录可能让它的父目录也变空——但只有那个父目录**同样在搬空集合里**
 * 才会被继续删除，用户自己的空目录一律不动。
 */
async function pruneEmptiedFolders(emptied: ReadonlySet<string>): Promise<number> {
  let pruned = 0;
  let changed = true;

  while (changed) {
    changed = false;
    for (const id of emptied) {
      const node = await chrome.bookmarks.get(id).catch(() => []);
      if (node.length === 0) continue; // 已被删除

      const children = await chrome.bookmarks.getChildren(id).catch(() => [null]);
      if (children.length > 0) continue;

      await chrome.bookmarks.remove(id).catch(() => {});
      pruned++;
      changed = true;
    }
  }

  return pruned;
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
        const bookmarkCount = child.children?.filter((c) => c.url).length ?? 0;
        results.push({
          id: child.id,
          title: child.title,
          path: currentPath,
          count: bookmarkCount,
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
  const bookmarks = await getAllBookmarks();
  await db.clear('vectors');
  const total = bookmarks.length;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = bookmarks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((b) => `${b.title} ${b.url} ${b.path}`);
    const vectors = await generateEmbeddingsBatch(texts);

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
    const vector = await generateEmbedding(text);
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
