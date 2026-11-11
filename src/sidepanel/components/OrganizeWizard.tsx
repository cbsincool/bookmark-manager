import React, { useCallback, useEffect, useState } from 'react';
import { useOrganizeStore } from '../stores/organizeStore';
import { DomainClusterView } from './DomainCluster';
import { DirectoryPreview } from './DirectoryPreview';
import { ManagePanel } from './ManagePanel';
import { t } from '../i18n';
import { useProgressListener } from '../hooks/useProgressListener';
import { mergeNearDuplicateNames } from '@/shared/directoryNaming';
import { RULE_TOP_LEVELS } from '@/shared/constants';
import type { BookmarkNode, OrganizeProposal } from '@/shared/types';

interface FolderInfo {
  id: string;
  title: string;
  path: string;
  count: number;
}

interface UndoInfo {
  available: boolean;
  createdAt?: number;
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
  const [manualMode, setManualMode] = useState<'none' | 'move' | 'merge'>('none');
  const [undoInfo, setUndoInfo] = useState<UndoInfo>({ available: false });
  const [undoRunning, setUndoRunning] = useState(false);

  const { progress: connectivityProgress } = useProgressListener('CONNECTIVITY_CHECK_PROGRESS');

  // --- Undo (撤销整理) ---
  const loadUndoInfo = useCallback(async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'ORGANIZE_SNAPSHOT_INFO' });
      setUndoInfo(resp?.success ? (resp.data as UndoInfo) : { available: false });
    } catch {
      setUndoInfo({ available: false });
    }
  }, []);

  useEffect(() => {
    void loadUndoInfo();
  }, [loadUndoInfo]);

  const handleUndo = async () => {
    setUndoRunning(true);
    setErrorMsg('');
    setProgressMsg(t('organize.undo.running'));
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'ORGANIZE_ROLLBACK' });
      if (!resp?.success) throw new Error(resp?.error || t('organize.undo.none'));

      const r = (resp.data ?? {}) as {
        restored?: number; inPlace?: number; foldersRecreated?: number;
        foldersRemoved?: number; failed?: number; failures?: string[];
      };

      setProgressMsg(
        t('organize.undo.done', {
          restored: r.restored ?? 0,
          inPlace: r.inPlace ?? 0,
          recreated: r.foldersRecreated ?? 0,
          removed: r.foldersRemoved ?? 0,
        }),
      );

      // 失败时后台会**保留**快照，所以这里要把「可以再点一次」说清楚——
      // 否则用户看到一堆失败原因，只会以为撤销已经废了
      if (r.failed) {
        const detail = r.failures?.length ? `\n${r.failures.join('\n')}` : '';
        setErrorMsg(
          `${t('organize.undo.retry', { failed: r.failed })}${detail}`,
        );
      }
    } catch (err) {
      setErrorMsg(t('organize.undo.failed', { error: err instanceof Error ? err.message : String(err) }));
      setProgressMsg('');
    } finally {
      setUndoRunning(false);
      void loadUndoInfo();
    }
  };

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
      setErrorMsg(t('organize.err.operation', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      store.setProcessing(false);
    }
  };

  // --- After scope chosen (global), fetch bookmark IDs for connectivity ---
  const proceedToConnectivity = async () => {
    setErrorMsg('');
    setProgressMsg(t('organize.progress.fetchingBookmarks'));
    store.setProcessing(true);
    try {
      const allResp = await chrome.runtime.sendMessage({ type: 'GET_ALL_BOOKMARKS' });
      if (!allResp?.success) throw new Error(t('organize.err.fetchBookmarks'));
      const bms = (allResp.data as BookmarkNode[]).filter(
        (bm) => !bm.path.includes('[待删除_失效]'),
      );
      setAllBookmarkIds(bms.map((b) => b.id));
      setConnectivityDone(false);
      store.setConnectivityDeadCount(0);
      store.setStep('connectivity');
      setProgressMsg('');
    } catch (err) {
      setErrorMsg(t('organize.err.operation', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      store.setProcessing(false);
    }
  };

  // --- After connectivity (or folder scope), load categories ---
  const proceedToCategory = async () => {
    setErrorMsg('');
    setProgressMsg(t('organize.progress.fetchingFolders'));
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
      // 默认全不勾：勾选才作为移出目标。用户的心智「勾哪个就移到哪个」，
      // 默认全勾会逼他先取消再挑
      store.setMoveOutTargets([]);

      // 一级目录的分类法。
      //
      // 全局整理时直接沿用现有顶层目录是不行的：实测会得到 31 个一级目录
      // （「硬件/服务器硬件/电脑硬件/计算机硬件/Hardware」五个并存），
      // 而旧结构一旦进了候选，模型就会照抄，永远收敛不下来。
      // 所以先让模型把顶层收敛成一套 ≤12 个的分类法，用户在下面这步还能改。
      let categories: string[] = [];
      if (store.organizeScope === 'global') {
        setProgressMsg(t('organize.progress.designingTaxonomy'));
        const suggested = await chrome.runtime.sendMessage({ type: 'ORGANIZE_SUGGEST_TAXONOMY' });
        const data = suggested?.success
          ? (suggested.data as { names?: string[]; usedAi?: boolean })
          : null;
        if (data?.names?.length) categories = [...data.names];
      }

      if (categories.length === 0) {
        // AI 不可用时的降级：至少把导入残渣去掉、把互相包含的名字合并掉
        categories = mergeNearDuplicateNames([...existingFolderNames, ...savedCategories]);
      }

      // 规则类目（视频/购物/Linux/教程/其它）始终在列表里：
      // 后台的规则层会往这些顶层里放东西，白名单缺了它们就会被兜底逻辑顶掉
      categories = [
        ...RULE_TOP_LEVELS.filter((n) => !categories.some((c) => c.toLowerCase() === n.toLowerCase())),
        ...categories,
      ];

      store.setCategories(categories.length > 0 ? categories : ['其他']);
      store.setStep('category');
      setProgressMsg('');
    } catch (err) {
      setErrorMsg(t('organize.err.fetchFolders', { error: err instanceof Error ? err.message : String(err) }));
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
      setErrorMsg(t('organize.err.needCategory'));
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
        setErrorMsg(resp?.error || t('organize.err.connectivityFailed'));
      }
    } catch (err) {
      setErrorMsg(t('organize.err.checkFailed', { error: err instanceof Error ? err.message : String(err) }));
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
        setErrorMsg(resp?.error || t('organize.err.analyzeFailed'));
      }
    } catch (err) {
      setErrorMsg(t('organize.err.operation', { error: err instanceof Error ? err.message : String(err) }));
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
    setProgressMsg(t('organize.progress.processing'));

    try {
      const allResp = await chrome.runtime.sendMessage({ type: 'GET_ALL_BOOKMARKS' });
      if (!allResp?.success) throw new Error(t('organize.err.fetchBookmarks'));

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

        if (!startResp?.success) throw new Error(startResp?.error || t('organize.err.startFailed'));

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
      setErrorMsg(t('organize.err.operation', { error: err instanceof Error ? err.message : String(err) }));
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
    setProgressMsg(t('organize.progress.startingClassify'));

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

      if (!startResp?.success) throw new Error(startResp?.error || t('organize.err.startFailed'));

      const taskId = (startResp.data as { taskId: string }).taskId;
      store.setProposal(await pollClassifyTask(taskId));
      store.setStep('preview');
    } catch (err) {
      setErrorMsg(t('organize.err.operation', { error: err instanceof Error ? err.message : String(err) }));
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
      if (!pollResp?.success) throw new Error(pollResp?.error || t('organize.err.pollFailed'));

      const task = pollResp.data as {
        status: string;
        progress?: { current: number; total: number; message: string };
        result?: Partial<OrganizeProposal>;
        error?: string;
      };

      if (task.progress) {
        setProgressMsg(task.progress.message || t('organize.progress.processingCount', { current: task.progress.current, total: task.progress.total }));
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

      if (task.status === 'failed') throw new Error(task.error || t('organize.err.classifyFailed'));
    }
    throw new Error(t('organize.err.classifyTimeout'));
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

        // 失败详情必须先摆出来。此前「写了路径就 return」的写法让下面那段
        // 永远执行不到——而几乎每次整理都会写路径，等于失败原因从未显示过
        if (r.failures?.length) {
          setErrorMsg(`${t('organize.preview.failures')}\n${r.failures.join('\n')}`);
        }

        // 撤销入口跟着结果一起出现：整理刚把东西搬走，这时候才最需要「退回」
        void loadUndoInfo();

        // 把实际用到的目录路径也显示出来——「东西被建到哪儿去了」原本完全看不见，
        // 排查「没移到我指定的目录」这类问题时只能靠猜
        if (r.paths?.length) {
          setProgressMsg(
            `${t('organize.execute.done')} — ${parts.join(t('common.comma'))}
` +
            `${t('organize.execute.paths')}: ${r.paths.slice(0, 12).join(t('common.listSep'))}`,
          );
          if (!r.failed) setTimeout(() => { store.reset(); setProgressMsg(''); }, 8000);
          return;
        }

        setProgressMsg(`${t('organize.execute.done')} — ${parts.join(t('common.comma'))}`);
        if (!r.failed) {
          setTimeout(() => { store.reset(); setProgressMsg(''); }, 4000);
        }
      } else {
        setErrorMsg(resp?.error || t('organize.err.executeFailed'));
      }
    } catch (err) {
      setErrorMsg(t('organize.err.executeFailedDetail', { error: err instanceof Error ? err.message : String(err) }));
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
      <div className="banner banner-error mb-3 flex-col items-start gap-1.5">
        <span className="whitespace-pre-wrap">{errorMsg}</span>
        <div className="flex gap-1">
          <button
            onClick={() => { setErrorMsg(''); setProgressMsg(''); store.reset(); }}
            className="btn-text text-danger"
          >
            {t('organize.reset')}
          </button>
          <button onClick={() => setErrorMsg('')} className="btn-text text-gray-500">
            {t('organize.dismiss')}
          </button>
        </div>
      </div>
    ) : null;

  // --- Idle step ---
  if (store.step === 'idle') {
    // 手动调整：AI 归得不合适时的兜底，挂在整理页里而不是另开一个标签
    if (manualMode !== 'none') {
      return (
        <ManagePanel
          initialMode={manualMode}
          onBack={() => { setManualMode('none'); void loadUndoInfo(); }}
        />
      );
    }

    return (
      <div className="p-4 space-y-5 enter">
        <div className="space-y-1">
          <p className="eyebrow">{t('organize.eyebrow.auto')}</p>
          <h2 className="text-[17px] font-semibold text-gray-900">{t('organize.title')}</h2>
          <p className="text-[12px] leading-relaxed text-gray-500">{t('organize.intro')}</p>
        </div>

        {store.isProcessing || undoRunning ? (
          <Spinner msg={progressMsg || t('organize.progress.processing')} />
        ) : (
          <>
            <ErrorBanner />
            {progressMsg && (
              <p className="text-sm text-gray-600 whitespace-pre-wrap">{progressMsg}</p>
            )}

            <div className="space-y-2">
              <button onClick={startOrganize} className="btn-grad">
                {t('organize.start')}
              </button>
              <p className="text-center text-[10px] text-gray-400">{t('organize.idle.note')}</p>
            </div>

            <section className="space-y-2">
              <p className="group-label">{t('organize.group.other')}</p>
              <div className="card divide-y divide-gray-100 overflow-hidden">
              {undoInfo.available && (
                <button onClick={handleUndo} className="action-row">
                  <span className="action-icon">↺</span>
                  <span className="min-w-0 flex-1">
                    <span className="action-title block">{t('organize.undo.action')}</span>
                    <span className="action-sub block truncate">
                      {new Date(undoInfo.createdAt ?? Date.now()).toLocaleString()} ·{' '}
                      {t('organize.undo.rowSub')}
                    </span>
                  </span>
                  <span className="action-chevron">›</span>
                </button>
              )}

              <button onClick={() => setManualMode('move')} className="action-row">
                <span className="action-icon">⇄</span>
                <span className="min-w-0 flex-1">
                  <span className="action-title block">{t('organize.manual.move')}</span>
                  <span className="action-sub block">{t('organize.manual.moveHint')}</span>
                </span>
                <span className="action-chevron">›</span>
              </button>

              <button onClick={() => setManualMode('merge')} className="action-row">
                <span className="action-icon">⇉</span>
                <span className="min-w-0 flex-1">
                  <span className="action-title block">{t('organize.manual.merge')}</span>
                  <span className="action-sub block">{t('organize.manual.mergeHint')}</span>
                </span>
                <span className="action-chevron">›</span>
                </button>
              </div>
            </section>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 enter">
      <ErrorBanner />

      {/* --- Scope step --- */}
      {store.step === 'scope' && (
        <div className="space-y-5">
          <div className="space-y-1">
            <p className="eyebrow">Organize · Scope</p>
            <h3 className="text-[15px] font-semibold text-gray-900">{t('organize.scope.title')}</h3>
            <p className="text-[11px] leading-relaxed text-gray-500">{t('organize.scope.hint')}</p>
          </div>

          {/* 第一步：方式（二选一） */}
          <section>
            <div className="step">
              <span className="step-mark">1</span>
              <span className="step-label">{t('organize.mode.title')}</span>
              <span className="step-hint">{t('organize.mode.choose')}</span>
            </div>
            <div className="choice-grid">
              {(['fit', 'replan'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => store.setOrganizeMode(mode)}
                  data-active={store.organizeMode === mode}
                  className="choice"
                >
                  <span className="choice-title block">
                    {t(mode === 'fit' ? 'organize.mode.fit' : 'organize.mode.replan')}
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-gray-500">
              {t(store.organizeMode === 'fit' ? 'organize.mode.fitHint' : 'organize.mode.replanHint')}
            </p>
          </section>

          {/* 第二步：范围（全局 或 某个文件夹） */}
          <section>
            <div className="step">
              <span className="step-mark">2</span>
              <span className="step-label">{t('organize.scope.choose')}</span>
            </div>

            <div className="space-y-2">
              {/* 路径 A：全局 */}
              <div className="card overflow-hidden">
                <button
                  onClick={() => { store.setOrganizeScope('global'); proceedToConnectivity(); }}
                  className="option-row"
                >
                  <span className="min-w-0 flex-1">
                    <span className="option-title block">{t('organize.scope.global')}</span>
                    <span className="option-sub block">{t('organize.scope.globalHint')}</span>
                  </span>
                  <span className="action-chevron">›</span>
                </button>
              </div>

              <p className="or-rule">{t('organize.scope.or')}</p>

              {/* 路径 B：指定文件夹 */}
              <div className="card overflow-hidden">
                <p className="section-cap">{t('organize.scope.folder')}</p>
                <div className="max-h-52 divide-y divide-gray-100 overflow-y-auto">
                  {existingFolders.filter((f) => !f.path.includes('/')).map((folder) => (
                    <button
                      key={folder.id}
                      onClick={() => {
                        store.setOrganizeScope('folder', folder.id, folder.title);
                        proceedToCategory();
                      }}
                      className="option-row"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="option-title block truncate">{folder.title}</span>
                        <span className="option-sub block">
                          {t('organize.folderBookmarkCount', { count: folder.count })}
                        </span>
                      </span>
                      <span className="action-chevron">›</span>
                    </button>
                  ))}
                  {existingFolders.filter((f) => !f.path.includes('/')).length === 0 && (
                    <p className="px-3 py-3 text-[11px] text-gray-400">{t('organize.noFolders')}</p>
                  )}
                </div>
              </div>
            </div>
          </section>

          <button
            onClick={() => store.reset()}
            className="w-full py-2 text-[12px] text-gray-500 transition-colors hover:text-gray-700"
          >
            {t('organize.cancel')}
          </button>
        </div>
      )}

      {/* --- Category step --- */}
      {store.step === 'category' && (
        <div className="space-y-5">
          <div className="space-y-1">
            <p className="eyebrow">Organize · Taxonomy</p>
            <h3 className="text-[15px] font-semibold text-gray-900">
              {store.organizeScope === 'folder'
                ? t('organize.organizingFolder', { name: store.organizeFolderName })
                : t('organize.categoryStep')}
            </h3>
            <p className="text-[11px] leading-relaxed text-gray-500">
              {store.organizeScope === 'global'
                ? t('organize.category.taxonomyHint')
                : t('organize.category.hint')}
            </p>
          </div>

          {store.organizeScope === 'folder' && (
            <label className="card flex cursor-pointer items-start gap-2.5 p-3">
              <input
                type="checkbox"
                checked={store.allowMoveOut}
                onChange={(e) => store.setAllowMoveOut(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded"
              />
              <span>
                <span className="block text-[12px] text-gray-800">{t('organize.allowMoveOut')}</span>
                <span className="block text-[10px] leading-relaxed text-gray-500">
                  {t(store.allowMoveOut ? 'organize.allowMoveOutHint' : 'organize.keepInsideHint')}
                </span>
              </span>
            </label>
          )}

          {store.organizeScope === 'folder' && store.allowMoveOut && (
            <div className="card space-y-2 p-3">
              <p className="text-[10px] text-gray-500">{t('organize.moveOutTargets')}</p>
              {store.organizeMode === 'replan' && (
                <p className="text-[10px] text-warning">{t('organize.moveOutOverridesReplan')}</p>
              )}
              {moveOutCandidates.length === 0 && (
                <p className="text-[10px] text-gray-400">{t('organize.moveOutNoTargets')}</p>
              )}
              <div className="flex flex-wrap gap-1.5">
                {moveOutCandidates.map((name) => (
                  <label
                    key={name}
                    data-active={store.moveOutTargets.includes(name)}
                    className="chip cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={store.moveOutTargets.includes(name)}
                      onChange={() => store.toggleMoveOutTarget(name)}
                      className="h-3 w-3"
                    />
                    {name}
                  </label>
                ))}
              </div>
            </div>
          )}

          <section className="space-y-2">
            <div className="step">
              <span className="step-label">{t('organize.category.listLabel')}</span>
              <span className="step-hint">{store.categories.length}</span>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {store.categories.map((cat) => (
                <div key={cat} className="chip">
                  <span>{cat}</span>
                  <button
                    onClick={() => store.removeCategory(cat)}
                    disabled={store.categories.length <= 1}
                    className="chip-x"
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
                className="field flex-1"
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
                className="btn-tonal shrink-0"
              >
                {t('organize.category.add')}
              </button>
            </div>

            {store.organizeMode === 'fit' && (
              <p className="text-[10px] leading-relaxed text-gray-400">{t('organize.category.fitNote')}</p>
            )}
          </section>

          <div className="flex gap-2 pt-1">
            <button
              onClick={() => store.setStep(store.organizeScope === 'global' ? 'connectivity' : 'scope')}
              className="btn-tonal flex-1"
            >
              {t('organize.back')}
            </button>
            <button
              onClick={handleCategoryNext}
              disabled={store.isProcessing}
              className="btn-grad flex-1"
            >
              {store.isProcessing ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  {progressMsg || t('organize.progress.processing')}
                </span>
              ) : (
                t('organize.next')
              )}
            </button>
          </div>
        </div>
      )}

      {/* --- Connectivity step (global only) --- */}
      {store.step === 'connectivity' && (
        <div className="space-y-5">
          <div className="space-y-1">
            <p className="eyebrow">Organize · Links</p>
            <h3 className="text-[15px] font-semibold text-gray-900">{t('organize.connectivityStep')}</h3>
            <p className="text-[11px] leading-relaxed text-gray-500">{t('organize.connectivity.hint')}</p>
          </div>

          {connectivityRunning && connectivityProgress && (
            <div className="banner banner-info">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              <span>{connectivityProgress.message}</span>
            </div>
          )}

          {connectivityDone && (
            <div className={`banner ${store.connectivityDeadCount > 0 ? 'banner-warn' : 'banner-ok'}`}>
              <span>
                {store.connectivityDeadCount > 0
                  ? t('organize.connectivity.done', { count: store.connectivityDeadCount })
                  : t('organize.connectivity.noDead')}
              </span>
            </div>
          )}

          <button onClick={handleRunConnectivity} disabled={connectivityRunning} className="btn-tonal w-full">
            {connectivityRunning && (
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            )}
            {connectivityRunning ? t('organize.progress.checking') : t('organize.connectivity.run')}
          </button>

          <div className="flex gap-2 pt-1">
            <button onClick={() => store.setStep('scope')} className="btn-tonal flex-1">
              {t('organize.back')}
            </button>
            <button
              onClick={handleConnectivityNext}
              disabled={store.isProcessing || connectivityRunning}
              className="btn-grad flex-1"
            >
              {store.isProcessing && (
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
              )}
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
