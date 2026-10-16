import React, { useState } from 'react';
import { useOrganizeStore } from '../stores/organizeStore';
import { DomainClusterView } from './DomainCluster';
import { DirectoryPreview } from './DirectoryPreview';
import { t } from '../i18n';
import { useProgressListener } from '../hooks/useProgressListener';
import type { BookmarkNode, OrganizeProposal } from '@/shared/types';

interface FolderInfo {
  id: string;
  title: string;
  path: string;
  count: number;
}

export function OrganizeWizard() {
  const store = useOrganizeStore();
  const [progressMsg, setProgressMsg] = useState('');
  const [moveOutCandidates, setMoveOutCandidates] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [existingFolders, setExistingFolders] = useState<FolderInfo[]>([]);
  const [connectivityRunning, setConnectivityRunning] = useState(false);
  const [connectivityDone, setConnectivityDone] = useState(false);
  const [allBookmarkIds, setAllBookmarkIds] = useState<string[]>([]);

  const { progress: connectivityProgress } = useProgressListener('CONNECTIVITY_CHECK_PROGRESS');

  // --- Load folder structure ---
  const loadFolderStructure = async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_FOLDER_STRUCTURE' });
      if (resp?.success) setExistingFolders(resp.data as FolderInfo[]);
    } catch {
      // non-critical
    }
  };

  // --- Start organize: go to scope selection ---
  const startOrganize = async () => {
    setErrorMsg('');
    store.setProcessing(true);
    try {
      await loadFolderStructure();
      store.setStep('scope');
    } catch (err) {
      setErrorMsg(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      store.setProcessing(false);
    }
  };

  // --- After scope chosen (global), fetch bookmark IDs for connectivity ---
  const proceedToConnectivity = async () => {
    setErrorMsg('');
    setProgressMsg('正在获取书签列表...');
    store.setProcessing(true);
    try {
      const allResp = await chrome.runtime.sendMessage({ type: 'GET_ALL_BOOKMARKS' });
      if (!allResp?.success) throw new Error('获取书签失败');
      const bms = (allResp.data as BookmarkNode[]).filter(
        (bm) => !bm.path.includes('[待删除_失效]'),
      );
      setAllBookmarkIds(bms.map((b) => b.id));
      setConnectivityDone(false);
      store.setConnectivityDeadCount(0);
      store.setStep('connectivity');
      setProgressMsg('');
    } catch (err) {
      setErrorMsg(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      store.setProcessing(false);
    }
  };

  // --- After connectivity (or folder scope), load categories ---
  const proceedToCategory = async () => {
    setErrorMsg('');
    setProgressMsg('正在获取收藏夹结构...');
    store.setProcessing(true);
    try {
      const tree = await chrome.bookmarks.getTree();
      const rootChildren = tree[0]?.children?.[0]?.children ?? [];

      let existingFolderNames: string[];
      if (store.organizeScope === 'folder' && store.organizeFolderId) {
        const folderTree = await chrome.bookmarks.getSubTree(store.organizeFolderId);
        existingFolderNames = folderTree[0]?.children
          ?.filter((n) => !n.url && n.title)
          .map((n) => n.title) ?? [];
        if (existingFolderNames.length === 0) {
          existingFolderNames = [store.organizeFolderName];
        }
      } else {
        existingFolderNames = rootChildren
          .filter((node) => !node.url && node.title)
          .map((node) => node.title);
      }

      const settingsResp = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      const savedCategories: string[] = settingsResp?.success
        ? (settingsResp.data as { topLevelCategories: string[] }).topLevelCategories ?? []
        : [];

      // 允许移出时的候选目标：书签栏的顶层目录（不含当前选中的文件夹本身）
      const barFolders = rootChildren
        .filter((node) => !node.url && node.title && node.id !== store.organizeFolderId)
        .map((node) => node.title);
      setMoveOutCandidates(barFolders);
      // 默认全不勾：勾选才作为移出目标。用户的心智是「勾哪个就移到哪个」，
      // 默认全勾会逼他先取消再挑
      store.setMoveOutTargets([]);

      const merged = new Set([...existingFolderNames, ...savedCategories]);
      const categories = Array.from(merged);
      store.setCategories(categories.length > 0 ? categories : ['其他']);
      store.setStep('category');
      setProgressMsg('');
    } catch (err) {
      setErrorMsg(`获取目录失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      store.setProcessing(false);
    }
  };

  const saveCategories = async () => {
    try {
      await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        settings: { topLevelCategories: store.categories },
      });
    } catch {
      // non-critical
    }
  };

  // --- Category → Domain (global) or folder classify ---
  const handleCategoryNext = async () => {
    if (store.categories.length === 0) {
      setErrorMsg('至少需要一个目录');
      return;
    }
    await saveCategories();
    setErrorMsg('');

    if (store.organizeScope === 'global') {
      await loadDomainClusters();
    } else {
      await handleFolderClassify();
    }
  };

  // --- Connectivity step ---
  const handleRunConnectivity = async () => {
    setConnectivityRunning(true);
    setErrorMsg('');
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'ORGANIZE_CONNECTIVITY_CHECK',
        bookmarkIds: allBookmarkIds,
      });
      if (resp?.success) {
        const { deadIds } = resp.data as { deadIds: string[]; checkedCount: number };
        store.setConnectivityDeadCount(deadIds.length);
        setConnectivityDone(true);
      } else {
        setErrorMsg(resp?.error || '连通性检测失败');
      }
    } catch (err) {
      setErrorMsg(`检测失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConnectivityRunning(false);
    }
  };

  const handleConnectivityNext = async () => {
    // After connectivity check, proceed to category configuration
    await proceedToCategory();
  };

  // --- Load domain clusters ---
  // 门户页（根域名页 / index 页）不再是独立步骤，而是作为域名簇的 hasPortal 属性
  // 一并返回；选中某域名时其门户页随该域名的其余书签一起归入同一目录。
  const loadDomainClusters = async () => {
    store.setProcessing(true);
    setProgressMsg(t('organize.domain.analyzing'));
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'ORGANIZE_DOMAIN_CLUSTER' });
      if (resp?.success) {
        store.setDomainClusters(resp.data);
        store.setStep('domain');
      } else {
        setErrorMsg(resp?.error || '分析失败，请重试');
      }
    } catch (err) {
      setErrorMsg(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      store.setProcessing(false);
      setProgressMsg('');
    }
  };

  // --- Domain step → AI Classify ---
  const handleDomainNext = async () => {
    setErrorMsg('');
    store.setStep('classify');
    store.setProcessing(true);
    setProgressMsg('正在准备书签数据...');

    try {
      const allResp = await chrome.runtime.sendMessage({ type: 'GET_ALL_BOOKMARKS' });
      if (!allResp?.success) throw new Error('获取书签失败');

      const allBookmarks = (allResp.data as { id: string; path: string }[]).filter(
        (bm) => !bm.path.includes('[待删除_失效]'),
      );

      // 选中的域名簇整体预归类（含其门户页）；未选中的域名交由 AI 分类
      const selectedClusters = store.domainClusters.filter((c) => c.selected);
      const domainTree: Record<string, string[]> = {};
      const domainBookmarkIds = new Set<string>();

      for (const cluster of selectedClusters) {
        // 追加而不是覆盖：suggestFolderName 会把 example.com / www.example.com /
        // docs.example.com 都收敛成 "Example"，覆盖会让先处理的簇凭空消失——
        // 那批书签既不在预览里，也不会被移动
        domainTree[cluster.suggestedFolderName] = [
          ...(domainTree[cluster.suggestedFolderName] ?? []),
          ...cluster.bookmarkIds,
        ];
        cluster.bookmarkIds.forEach((id) => domainBookmarkIds.add(id));
      }

      const remainingIds = allBookmarks
        .filter((bm) => !domainBookmarkIds.has(bm.id))
        .map((bm) => bm.id);

      let aiProposal: OrganizeProposal | null = null;

      if (remainingIds.length > 0) {
        const startResp = await chrome.runtime.sendMessage({
          type: 'ORGANIZE_AI_CLASSIFY_START',
          bookmarkIds: remainingIds,
          scope: 'global',
          categories: store.categories,
          mode: store.organizeMode,
        });

        if (!startResp?.success) throw new Error(startResp?.error || '启动失败');

        const taskId = (startResp.data as { taskId: string }).taskId;
        aiProposal = await pollClassifyTask(taskId);
      }

      // Merge domain + AI results
      const mergedTree: Record<string, readonly string[]> = { ...domainTree };
      for (const [path, ids] of Object.entries(aiProposal?.directoryTree ?? {})) {
        const existing = mergedTree[path] ?? [];
        mergedTree[path] = [...existing, ...ids];
      }

      store.setProposal({
        directoryTree: mergedTree,
        lowCohesionPaths: aiProposal?.lowCohesionPaths ?? [],
        skeletonPaths: aiProposal?.skeletonPaths,
        overflowPaths: aiProposal?.overflowPaths,
        mergedFolderNames: aiProposal?.mergedFolderNames,
        stats: aiProposal?.stats,
      });
      store.setStep('preview');
      setProgressMsg('');
    } catch (err) {
      setErrorMsg(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
      store.setStep('domain');
    } finally {
      store.setProcessing(false);
      setProgressMsg('');
    }
  };

  // --- Folder scope classify (no pre-steps) ---
  const handleFolderClassify = async () => {
    setErrorMsg('');
    store.setStep('classify');
    store.setProcessing(true);
    setProgressMsg('正在启动语义分类...');

    try {
      const startResp = await chrome.runtime.sendMessage({
        type: 'ORGANIZE_AI_CLASSIFY_START',
        bookmarkIds: [],
        scope: 'folder',
        folderId: store.organizeFolderId,
        mode: store.organizeMode,
        allowMoveOut: store.allowMoveOut,
        moveOutTargets: store.moveOutTargets,
      });

      if (!startResp?.success) throw new Error(startResp?.error || '启动失败');

      const taskId = (startResp.data as { taskId: string }).taskId;
      store.setProposal(await pollClassifyTask(taskId));
      store.setStep('preview');
    } catch (err) {
      setErrorMsg(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
      store.setStep('category');
    } finally {
      store.setProcessing(false);
      setProgressMsg('');
    }
  };

  // Shared polling helper — 返回完整的整理提案（含骨架/溢出标注与统计），
  // 由调用方决定何时写入 store：全局整理还要先与域名簇结果合并
  const pollClassifyTask = async (taskId: string): Promise<OrganizeProposal> => {
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 2000));

      const pollResp = await chrome.runtime.sendMessage({ type: 'ORGANIZE_AI_CLASSIFY_POLL', taskId });
      if (!pollResp?.success) throw new Error(pollResp?.error || '轮询失败');

      const task = pollResp.data as {
        status: string;
        progress?: { current: number; total: number; message: string };
        result?: Partial<OrganizeProposal>;
        error?: string;
      };

      if (task.progress) {
        setProgressMsg(task.progress.message || `处理中 (${task.progress.current}/${task.progress.total})`);
      }

      if (task.status === 'completed' && task.result) {
        return {
          directoryTree: task.result.directoryTree ?? {},
          lowCohesionPaths: task.result.lowCohesionPaths ?? [],
          skeletonPaths: task.result.skeletonPaths,
          overflowPaths: task.result.overflowPaths,
          mergedFolderNames: task.result.mergedFolderNames,
          stats: task.result.stats,
        };
      }

      if (task.status === 'failed') throw new Error(task.error || '分类失败');
    }
    throw new Error('分类超时，请重试');
  };

  // --- Execute ---
  const handleExecute = async () => {
    if (!store.proposal) return;
    setErrorMsg('');
    setProgressMsg(t('organize.execute.running'));
    store.setProcessing(true);
    try {
      const tree = await chrome.bookmarks.getTree();
      const barId = tree[0]?.children?.[0]?.id ?? '1';
      // 文件夹整理时新目录建在**该文件夹内部**，不是书签栏顶层。
      // 此前一律用书签栏，于是「整理指定文件夹」会把书签搬出该文件夹。
      // 允许移出时路径必须相对书签栏（既要指向文件夹内部的子目录，又要指向外面的目标目录）
      const rootId =
        store.organizeScope === 'folder' && store.organizeFolderId && !store.allowMoveOut
          ? store.organizeFolderId
          : barId;

      const resp = await chrome.runtime.sendMessage({
        type: 'ORGANIZE_EXECUTE',
        directoryTree: store.proposal.directoryTree,
        rootId,
      });

      if (resp?.success) {
        // 把执行结果如实报出来。此前只显示一句「完成」，而 moved 里混着
        // 「本来就在这个目录」的空操作，用户看不出整理到底动没动
        const r = (resp.data ?? {}) as {
          moved?: number; inPlace?: number; skipped?: number;
          pruned?: number; failed?: number; failures?: string[]; paths?: string[];
        };
        const parts = [
          `${t('organize.execute.moved')} ${r.moved ?? 0}`,
          `${t('organize.execute.inPlace')} ${r.inPlace ?? 0}`,
        ];
        if (r.skipped) parts.push(`${t('organize.execute.skipped')} ${r.skipped}`);
        if (r.pruned) parts.push(`${t('organize.execute.pruned')} ${r.pruned}`);
        if (r.failed) parts.push(`${t('organize.execute.failed')} ${r.failed}`);

        // 把实际用到的目录路径也显示出来——「东西被建到哪儿去了」原本完全看不见，
        // 排查「没移到我指定的目录」这类问题时只能靠猜
        if (r.paths?.length) {
          setProgressMsg(
            `${t('organize.execute.done')} — ${parts.join('，')}
` +
            `${t('organize.execute.paths')}: ${r.paths.slice(0, 12).join('、')}`,
          );
          if (!r.failed) setTimeout(() => { store.reset(); setProgressMsg(''); }, 8000);
          return;
        }

        setProgressMsg(`${t('organize.execute.done')} — ${parts.join('，')}`);
        if (r.failures?.length) setErrorMsg(r.failures.join('\n'));
        if (!r.failed) {
          setTimeout(() => { store.reset(); setProgressMsg(''); }, 4000);
        }
      } else {
        setErrorMsg(resp?.error || '执行失败');
      }
    } catch (err) {
      setErrorMsg(`执行失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      store.setProcessing(false);
    }
  };

  const Spinner = ({ msg }: { msg: string }) => (
    <div className="flex flex-col items-center py-8 space-y-3">
      <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      <p className="text-sm text-gray-500 text-center">{msg}</p>
    </div>
  );

  const ErrorBanner = () =>
    errorMsg ? (
      <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg">
        <p className="text-sm text-red-600">{errorMsg}</p>
        <div className="flex gap-2 mt-2">
          <button
            onClick={() => { setErrorMsg(''); setProgressMsg(''); store.reset(); }}
            className="text-xs text-red-600 hover:text-red-700 font-medium"
          >
            {t('organize.reset')}
          </button>
          <button onClick={() => setErrorMsg('')} className="text-xs text-red-400 hover:text-red-600">
            {t('organize.dismiss')}
          </button>
        </div>
      </div>
    ) : null;

  // --- Idle step ---
  if (store.step === 'idle') {
    return (
      <div className="p-4 space-y-4">
        <h2 className="text-base font-semibold text-gray-800">{t('organize.title')}</h2>
        {store.isProcessing ? (
          <Spinner msg={progressMsg || '正在处理...'} />
        ) : (
          <>
            <p className="text-sm text-gray-500">自动将书签按语义聚类，通过 AI 命名目录结构，支持最多 3 层子目录。</p>
            <ErrorBanner />
            <button onClick={startOrganize} className="w-full py-2.5 bg-primary text-white text-sm rounded-lg hover:bg-indigo-700">
              开始整理
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="p-4">
      <ErrorBanner />

      {/* --- Scope step --- */}
      {store.step === 'scope' && (
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-700">{t('organize.scope.title')}</h3>
          <p className="text-xs text-gray-500">{t('organize.scope.hint')}</p>

          <div className="space-y-1">
            <p className="text-xs font-medium text-gray-600">{t('organize.mode.title')}</p>
            {(['fit', 'replan'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => store.setOrganizeMode(mode)}
                className={`w-full px-3 py-2 text-left rounded-lg border transition-colors ${
                  store.organizeMode === mode
                    ? 'border-indigo-400 bg-indigo-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <p className="text-sm text-gray-800">
                  {t(mode === 'fit' ? 'organize.mode.fit' : 'organize.mode.replan')}
                </p>
                <p className="text-xs text-gray-500">
                  {t(mode === 'fit' ? 'organize.mode.fitHint' : 'organize.mode.replanHint')}
                </p>
              </button>
            ))}
          </div>

          <div className="space-y-2">
            <button
              onClick={() => { store.setOrganizeScope('global'); proceedToConnectivity(); }}
              className="w-full py-3 text-sm rounded-lg border border-gray-200 hover:bg-indigo-50 hover:border-indigo-300 text-left px-4"
            >
              <p className="font-medium text-gray-800">{t('organize.scope.global')}</p>
              <p className="text-xs text-gray-500">{t('organize.scope.globalHint')}</p>
            </button>

            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <p className="px-4 py-2 text-xs font-medium text-gray-600 bg-gray-50">{t('organize.scope.folder')}</p>
              <div className="max-h-48 overflow-y-auto divide-y divide-gray-100">
                {existingFolders.filter((f) => !f.path.includes('/')).map((folder) => (
                  <button
                    key={folder.id}
                    onClick={() => {
                      store.setOrganizeScope('folder', folder.id, folder.title);
                      proceedToCategory();
                    }}
                    className="w-full px-4 py-2.5 text-left hover:bg-indigo-50 transition-colors"
                  >
                    <p className="text-sm text-gray-800">{folder.title}</p>
                    <p className="text-xs text-gray-400">{folder.count} 个书签</p>
                  </button>
                ))}
                {existingFolders.filter((f) => !f.path.includes('/')).length === 0 && (
                  <p className="px-4 py-3 text-sm text-gray-400">无文件夹</p>
                )}
              </div>
            </div>
          </div>

          <button onClick={() => store.reset()} className="w-full py-2 text-sm text-gray-500 hover:text-gray-700">
            {t('organize.cancel')}
          </button>
        </div>
      )}

      {/* --- Category step --- */}
      {store.step === 'category' && (
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-700">
            {store.organizeScope === 'folder'
              ? `整理文件夹：${store.organizeFolderName}`
              : t('organize.categoryStep')}
          </h3>
          <p className="text-xs text-gray-500">{t('organize.category.hint')}</p>
          {store.organizeScope === 'folder' && (
            <label className="flex items-start gap-2 p-2 rounded-lg border border-gray-200 cursor-pointer">
              <input
                type="checkbox"
                checked={store.allowMoveOut}
                onChange={(e) => store.setAllowMoveOut(e.target.checked)}
                className="mt-0.5 w-4 h-4 text-primary rounded"
              />
              <span>
                <span className="block text-sm text-gray-700">{t('organize.allowMoveOut')}</span>
                <span className="block text-xs text-gray-500">
                  {t(store.allowMoveOut ? 'organize.allowMoveOutHint' : 'organize.keepInsideHint')}
                </span>
              </span>
            </label>
          )}
          {store.organizeScope === 'folder' && store.allowMoveOut && (
            <div className="p-2 rounded-lg border border-gray-200 space-y-1">
              <p className="text-xs text-gray-500">{t('organize.moveOutTargets')}</p>
              {store.organizeMode === 'replan' && (
                <p className="text-xs text-amber-600">{t('organize.moveOutOverridesReplan')}</p>
              )}
              {moveOutCandidates.length === 0 && (
                <p className="text-xs text-gray-400">{t('organize.moveOutNoTargets')}</p>
              )}
              <div className="flex flex-wrap gap-1">
                {moveOutCandidates.map((name) => (
                  <label
                    key={name}
                    className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-xs cursor-pointer ${
                      store.moveOutTargets.includes(name)
                        ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                        : 'border-gray-200 text-gray-600'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={store.moveOutTargets.includes(name)}
                      onChange={() => store.toggleMoveOutTarget(name)}
                      className="w-3 h-3"
                    />
                    {name}
                  </label>
                ))}
              </div>
            </div>
          )}
          {store.organizeMode === 'fit' && (
            <p className="text-xs text-gray-400">{t('organize.category.fitNote')}</p>
          )}

          <div className="flex flex-wrap gap-2">
            {store.categories.map((cat) => (
              <div key={cat} className="flex items-center gap-1 px-2 py-1 bg-gray-100 rounded-lg text-sm">
                <span>{cat}</span>
                <button
                  onClick={() => store.removeCategory(cat)}
                  disabled={store.categories.length <= 1}
                  className="text-gray-400 hover:text-red-500 disabled:opacity-30"
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder={t('organize.category.add')}
              className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg"
            />
            <button
              onClick={() => {
                const trimmed = newCategory.trim();
                if (trimmed && !store.categories.includes(trimmed)) {
                  store.addCategory(trimmed);
                  setNewCategory('');
                }
              }}
              disabled={!newCategory.trim() || store.categories.includes(newCategory.trim())}
              className="px-3 py-1.5 text-xs bg-primary text-white rounded-lg disabled:opacity-40"
            >
              {t('organize.category.add')}
            </button>
          </div>

          <div className="flex gap-2 pt-2 border-t">
            <button onClick={() => store.setStep(store.organizeScope === 'global' ? 'connectivity' : 'scope')} className="flex-1 py-2 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200">
              {t('organize.back')}
            </button>
            <button
              onClick={handleCategoryNext}
              disabled={store.isProcessing}
              className="flex-1 py-2 bg-primary text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              {store.isProcessing ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin inline-block" />
                  {progressMsg || '处理中...'}
                </span>
              ) : t('organize.next')}
            </button>
          </div>
        </div>
      )}

      {/* --- Connectivity step (global only) --- */}
      {store.step === 'connectivity' && (
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-700">{t('organize.connectivityStep')}</h3>
          <p className="text-xs text-gray-500">检测失效链接（404/410），自动移入「待删除_失效」文件夹，不参与后续整理。</p>

          {connectivityRunning && connectivityProgress && (
            <div className="flex items-center gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
              <span className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin inline-block" />
              <p className="text-sm text-blue-700">{connectivityProgress.message}</p>
            </div>
          )}

          {connectivityDone && (
            <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
              <p className="text-sm text-green-700">
                {store.connectivityDeadCount > 0
                  ? `检测完成：发现 ${store.connectivityDeadCount} 个失效链接，已移入 [待删除_失效]`
                  : t('organize.connectivity.noDead')}
              </p>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleRunConnectivity}
              disabled={connectivityRunning}
              className="flex-1 py-2 bg-orange-500 text-white text-sm rounded-lg hover:bg-orange-600 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {connectivityRunning && <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin inline-block" />}
              {connectivityRunning ? '检测中...' : t('organize.connectivity.run')}
            </button>
          </div>

          <div className="flex gap-2 pt-2 border-t">
            <button onClick={() => store.setStep('scope')} className="flex-1 py-2 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200">
              {t('organize.back')}
            </button>
            <button
              onClick={handleConnectivityNext}
              disabled={store.isProcessing || connectivityRunning}
              className="flex-1 py-2 bg-primary text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {store.isProcessing && <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin inline-block" />}
              {connectivityDone ? t('organize.next') : t('organize.connectivity.skip')}
            </button>
          </div>
        </div>
      )}

      {/* --- Domain step (global only) --- */}
      {store.step === 'domain' && (
        <DomainClusterView
          clusters={store.domainClusters}
          onToggle={store.toggleDomainCluster}
          onRename={store.updateFolderName}
          onSelectAll={() => {
            store.domainClusters.forEach((c) => { if (!c.selected) store.toggleDomainCluster(c.domain); });
          }}
          onDeselectAll={() => {
            store.domainClusters.forEach((c) => { if (c.selected) store.toggleDomainCluster(c.domain); });
          }}
          onNext={handleDomainNext}
          onBack={() => store.setStep('category')}
        />
      )}

      {/* --- Classify step --- */}
      {store.step === 'classify' && store.isProcessing && (
        <Spinner msg={progressMsg || t('organize.classify.analyzing', { count: '?' })} />
      )}

      {/* --- Preview step --- */}
      {store.step === 'preview' && store.proposal && (
        <DirectoryPreview
          proposal={store.proposal}
          onExecute={handleExecute}
          onCancel={() => store.reset()}
          onRenameDir={store.renamePath}
          onRefineDir={() => {}}
        />
      )}

      {store.step === 'preview' && store.isProcessing && (
        <Spinner msg={progressMsg || t('organize.execute.running')} />
      )}
    </div>
  );
}
