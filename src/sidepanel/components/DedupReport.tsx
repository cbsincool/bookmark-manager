import React, { useState, useEffect } from 'react';
import { useDedupStore } from '../stores/dedupStore';
import type { FineDedupResult } from '../stores/dedupStore';
import { DedupCard } from './DedupCard';
import { t } from '../i18n';
import type { BookmarkNode, DedupGroup } from '@/shared/types';
import { useProgressListener } from '../hooks/useProgressListener';

/**
 * 去重模块的视觉约定（与程序其余部分一致）：
 *   - 主操作    bg-primary
 *   - 次操作    border-gray-300 + text-gray-600
 *   - 破坏性    bg-danger
 *   - 彩色语义  只有「推荐保留」用 success，其余一切文字/边框走 gray
 * 之前这里自创了一套紫色（全程序只有这个文件用），外加蓝/绿/黄/红混用，
 * 按钮还挤在一行里换行——这次一并收敛。
 */

const SECONDARY_BTN =
  'py-2 text-sm border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50 cursor-pointer transition-colors disabled:opacity-50';
const PRIMARY_BTN =
  'w-full py-2.5 bg-primary text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50 cursor-pointer transition-colors flex items-center justify-center gap-2';
const TEXT_BTN = 'text-xs text-gray-500 hover:text-gray-700 cursor-pointer disabled:opacity-50';

function Spinner({ className = 'border-white' }: { className?: string }) {
  return (
    <span className={`w-3.5 h-3.5 border-2 ${className} border-t-transparent rounded-full animate-spin inline-block`} />
  );
}

// ---- 书签勾选列表（手动去重 / 精细去重共用）----

interface BookmarkPickerProps {
  readonly bookmarks: readonly BookmarkNode[];
  readonly selectedIds: readonly string[];
  readonly onToggle: (id: string) => void;
  readonly hint: string;
}

function BookmarkPicker({ bookmarks, selectedIds, onToggle, hint }: BookmarkPickerProps) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500">{hint}</p>
      <div className="space-y-1 max-h-80 overflow-y-auto">
        {bookmarks.map((bm) => {
          const selected = selectedIds.includes(bm.id);
          return (
            <label
              key={bm.id}
              className={`flex items-start gap-3 p-2 rounded-lg cursor-pointer transition-colors ${
                selected ? 'bg-indigo-50 border border-indigo-200' : 'bg-white border border-gray-100 hover:bg-gray-50'
              }`}
            >
              <input
                type="checkbox"
                checked={selected}
                onChange={() => onToggle(bm.id)}
                className="mt-0.5 w-4 h-4 text-primary rounded cursor-pointer"
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-800 truncate">{bm.title}</p>
                <p className="text-xs text-gray-500 truncate">{bm.url}</p>
                <p className="text-[10px] text-gray-400 truncate">{bm.path}</p>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ---- 精细去重结果面板 ----

function FineDedupResultPanel({
  result,
  onExecute,
  onClose,
}: {
  result: FineDedupResult;
  onExecute: (deleteIds: string[]) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const summaryMap = new Map(result.summaries.map((s) => [s.id, s]));

  const toggleDelete = (id: string) => setSelected((prev) => ({ ...prev, [id]: !prev[id] }));

  if (!result.aiResult) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-gray-500">{t('dedup.fine.noAi')}</p>
        {result.summaries.map((s) => (
          <div key={s.id} className="p-3 bg-white border border-gray-200 rounded-lg space-y-1">
            <p className="text-sm text-gray-800 truncate">{s.title}</p>
            <p className="text-xs text-gray-500 truncate">{s.url}</p>
            {s.summary && <p className="text-xs text-gray-500 line-clamp-2">{s.summary}</p>}
          </div>
        ))}
        <button onClick={onClose} className={`w-full ${SECONDARY_BTN}`}>
          {t('dedup.fine.close')}
        </button>
      </div>
    );
  }

  const { groups, standalone } = result.aiResult;
  const allDeleteIds = Object.entries(selected).filter(([, v]) => v).map(([k]) => k);

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">{t('dedup.fine.aiHint')}</p>

      {groups.map((g, i) => {
        const keepBm = summaryMap.get(g.keepId);
        return (
          <div key={i} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <p className="px-3 py-2 text-xs text-gray-600 bg-gray-50 border-b border-gray-200">{g.reason}</p>

            {keepBm && (
              <div className="px-3 py-2 border-l-2 border-l-success bg-gray-50">
                <p className="text-[10px] text-success">{t('dedup.fine.recommend')}</p>
                <p className="text-sm text-gray-800 truncate">{keepBm.title}</p>
                {keepBm.summary && (
                  <p className="text-xs text-gray-500 line-clamp-1">{keepBm.summary}</p>
                )}
              </div>
            )}

            {g.deleteIds.map((id) => {
              const bm = summaryMap.get(id);
              if (!bm) return null;
              const checked = selected[id] ?? true;
              return (
                <label
                  key={id}
                  className="flex items-start gap-2 px-3 py-2 border-t border-gray-100 cursor-pointer hover:bg-gray-50"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleDelete(id)}
                    className="mt-0.5 w-4 h-4 text-danger rounded cursor-pointer"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-700 truncate">{bm.title}</p>
                    {bm.summary && <p className="text-xs text-gray-400 line-clamp-1">{bm.summary}</p>}
                  </div>
                </label>
              );
            })}
          </div>
        );
      })}

      {standalone.length > 0 && (
        <div className="p-3 bg-white border border-gray-200 rounded-lg">
          <p className="text-xs text-gray-500 mb-1">{t('dedup.fine.standalone')}</p>
          {standalone.map((id) => {
            const bm = summaryMap.get(id);
            return bm ? (
              <p key={id} className="text-sm text-gray-600 truncate">{bm.title}</p>
            ) : null;
          })}
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={onClose} className={`flex-1 ${SECONDARY_BTN}`}>
          {t('dedup.fine.close')}
        </button>
        {allDeleteIds.length > 0 && (
          <button
            onClick={() => onExecute(allDeleteIds)}
            className="flex-1 py-2 text-sm bg-danger text-white rounded-lg hover:bg-red-700 cursor-pointer transition-colors"
          >
            {t('dedup.fine.execute', { count: allDeleteIds.length })}
          </button>
        )}
      </div>
    </div>
  );
}

// ---- 主组件 ----

export function DedupReport() {
  const {
    groups, isScanning, setGroups, setScanning, updateKeepId, removeGroup,
    manualSelectedIds, toggleManualSelect, clearManualSelect,
    progress, deletedHistory, addDeletedHistory, clearDeletedHistory, reset,
    fineMode, fineSelectedIds, fineResult, fineAnalyzing,
    enterFineMode, exitFineMode, toggleFineSelect, setFineResult, setFineAnalyzing,
  } = useDedupStore();

  const [manualMode, setManualMode] = useState(false);
  const [allBookmarks, setAllBookmarks] = useState<BookmarkNode[]>([]);
  const [isForcing, setIsForcing] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [fineStatusMsg, setFineStatusMsg] = useState('');

  const { progress: scanProgress, clearProgress: clearScanProgress } = useProgressListener('DEDUP_SCAN_PROGRESS');
  const { progress: fineProgress } = useProgressListener('FINE_DEDUP_PROGRESS');

  const startScan = async () => {
    setScanning(true);
    clearScanProgress();
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'DEDUP_SCAN' });
      if (resp?.success) setGroups(resp.data);
    } catch (err) {
      console.error('Dedup scan failed:', err);
    } finally {
      setScanning(false);
    }
  };

  const handleConfirmGroup = async (groupId: string) => {
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;

    const keepIds = [group.recommendedKeepId];
    const deleteIds = group.items
      .filter((i) => i.bookmark.id !== group.recommendedKeepId)
      .map((i) => i.bookmark.id);

    const resp = await chrome.runtime.sendMessage({ type: 'DEDUP_EXECUTE', keepIds, deleteIds });
    if (resp?.success) {
      addDeletedHistory(groupId, deleteIds);
      removeGroup(groupId);
    }
  };

  const handleConfirmAll = async () => {
    const groupIds = groups.map((g) => g.id);
    const results = await Promise.all(
      groupIds.map(async (groupId) => {
        const group = groups.find((g) => g.id === groupId);
        if (!group) return null;
        const keepIds = [group.recommendedKeepId];
        const deleteIds = group.items
          .filter((i) => i.bookmark.id !== group.recommendedKeepId)
          .map((i) => i.bookmark.id);
        const resp = await chrome.runtime.sendMessage({ type: 'DEDUP_EXECUTE', keepIds, deleteIds });
        return resp?.success ? { groupId, deleteIds } : null;
      }),
    );
    for (const result of results) {
      if (result) {
        addDeletedHistory(result.groupId, result.deleteIds);
        removeGroup(result.groupId);
      }
    }
  };

  const handleUndo = async () => {
    if (deletedHistory.length === 0) return;
    setUndoing(true);
    try {
      const recent = deletedHistory[deletedHistory.length - 1];
      const resp = await chrome.runtime.sendMessage({ type: 'DEDUP_UNDO', deletedIds: recent.deletedIds });
      if (resp?.success) {
        const newHistory = deletedHistory.slice(0, -1);
        clearDeletedHistory();
        for (const h of newHistory) addDeletedHistory(h.groupId, h.deletedIds);
      }
    } finally {
      setUndoing(false);
    }
  };

  const loadBookmarks = async () => {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_ALL_BOOKMARKS' });
    if (resp?.success) setAllBookmarks(resp.data as BookmarkNode[]);
  };

  const handleEnterManualMode = async () => {
    await loadBookmarks();
    clearManualSelect();
    setManualMode(true);
  };

  const handleExitManualMode = () => {
    clearManualSelect();
    setManualMode(false);
  };

  const handleForceDedup = async () => {
    if (manualSelectedIds.length < 2) return;
    setIsForcing(true);
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'DEDUP_MANUAL_FORCE', bookmarkIds: manualSelectedIds });
      if (resp?.success) {
        setGroups([...groups, resp.data as DedupGroup]);
        clearManualSelect();
        setManualMode(false);
      }
    } finally {
      setIsForcing(false);
    }
  };

  const handleEnterFineMode = async () => {
    await loadBookmarks();
    enterFineMode();
  };

  const handleFineAnalyze = async () => {
    if (fineSelectedIds.length < 2) return;
    setFineAnalyzing(true);
    setFineStatusMsg(t('dedup.fine.fetchingSummaries'));
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'FINE_DEDUP_ANALYZE',
        bookmarkIds: fineSelectedIds,
      });
      if (resp?.success) {
        setFineResult(resp.data as FineDedupResult);
        setFineStatusMsg('');
      } else {
        setFineStatusMsg(resp?.error ?? t('dedup.fine.failed'));
      }
    } catch (err) {
      setFineStatusMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setFineAnalyzing(false);
    }
  };

  // 分析过程中把后端进度同步到状态行
  useEffect(() => {
    if (fineAnalyzing && fineProgress?.message) {
      setFineStatusMsg(fineProgress.message);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fineProgress?.message, fineAnalyzing]);

  const handleFineExecute = async (deleteIds: string[]) => {
    const resp = await chrome.runtime.sendMessage({
      type: 'DEDUP_EXECUTE',
      keepIds: fineSelectedIds.filter((id) => !deleteIds.includes(id)),
      deleteIds,
    });
    if (resp?.success) {
      addDeletedHistory('fine-' + Date.now(), deleteIds);
      exitFineMode();
    }
  };

  const isAnyMode = manualMode || fineMode;

  return (
    <div className="p-4 space-y-4">
      {/* 标题栏：撤销 / 重置是低频操作，降级成文字按钮，不跟主操作抢视觉 */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-800">{t('dedup.title')}</h2>
        <div className="flex items-center gap-3">
          {isAnyMode ? (
            <button onClick={manualMode ? handleExitManualMode : exitFineMode} className={TEXT_BTN}>
              {t('dedup.manual.cancel')}
            </button>
          ) : (
            <>
              {deletedHistory.length > 0 && (
                <button onClick={handleUndo} disabled={undoing} className={TEXT_BTN}>
                  {t('dedup.undo')}
                </button>
              )}
              {groups.length > 0 && (
                <button onClick={reset} className={TEXT_BTN}>
                  {t('dedup.reset')}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* 操作区：主操作占满一行，两个模式入口并排作次按钮 */}
      {!isAnyMode && (
        <div className="space-y-2">
          <button onClick={startScan} disabled={isScanning} className={PRIMARY_BTN}>
            {isScanning ? (
              <>
                <Spinner />
                {scanProgress?.message ?? t('dedup.scanning')}
              </>
            ) : (
              t('dedup.startScan')
            )}
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={handleEnterManualMode} className={SECONDARY_BTN}>
              {t('dedup.manual.selectMode')}
            </button>
            <button onClick={handleEnterFineMode} className={SECONDARY_BTN}>
              {t('dedup.fine.btn')}
            </button>
          </div>
        </div>
      )}

      {/* 手动选择模式 */}
      {manualMode && (
        <div className="space-y-2">
          <BookmarkPicker
            bookmarks={allBookmarks}
            selectedIds={manualSelectedIds}
            onToggle={toggleManualSelect}
            hint={t('dedup.manual.hint')}
          />
          {manualSelectedIds.length >= 2 && (
            <button onClick={handleForceDedup} disabled={isForcing} className={PRIMARY_BTN}>
              {isForcing ? t('dedup.processing') : t('dedup.manual.forceBtn', { count: manualSelectedIds.length })}
            </button>
          )}
        </div>
      )}

      {/* 精细去重模式 */}
      {fineMode && (
        <div className="space-y-3">
          {!fineResult ? (
            <>
              <BookmarkPicker
                bookmarks={allBookmarks}
                selectedIds={fineSelectedIds}
                onToggle={toggleFineSelect}
                hint={t('dedup.fine.hint')}
              />
              {fineStatusMsg && <p className="text-xs text-gray-500">{fineStatusMsg}</p>}
              {fineSelectedIds.length >= 2 && (
                <button onClick={handleFineAnalyze} disabled={fineAnalyzing} className={PRIMARY_BTN}>
                  {fineAnalyzing && <Spinner />}
                  {fineAnalyzing
                    ? t('dedup.fine.analyzing')
                    : t('dedup.fine.analyzeBtn', { count: fineSelectedIds.length })}
                </button>
              )}
            </>
          ) : (
            <FineDedupResultPanel
              result={fineResult}
              onExecute={handleFineExecute}
              onClose={exitFineMode}
            />
          )}
        </div>
      )}

      {isScanning && groups.length === 0 && (
        <div className="flex flex-col items-center py-8 space-y-3">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-500">{t('dedup.scanningHint')}</p>
        </div>
      )}

      {!isScanning && !isAnyMode && groups.length === 0 && (
        <div className="text-center py-8 space-y-2">
          <p className="text-sm text-gray-500">{t('dedup.noResults')}</p>
          <p className="text-xs text-gray-400">{t('dedup.scanHint')}</p>
        </div>
      )}

      {groups.length > 0 && !isAnyMode && (
        <>
          <p className="text-sm text-gray-600">
            {t('dedup.foundGroups', { count: groups.length })}
          </p>
          <div className="space-y-4">
            {groups.map((group) => (
              <DedupCard
                key={group.id}
                group={group}
                onKeepChange={(keepId) => updateKeepId(group.id, keepId)}
                onConfirm={() => handleConfirmGroup(group.id)}
                onSkip={() => removeGroup(group.id)}
              />
            ))}
          </div>
          <button
            onClick={handleConfirmAll}
            className="w-full py-2.5 bg-danger text-white text-sm rounded-lg hover:bg-red-700 cursor-pointer transition-colors"
          >
            {t('dedup.confirmAll')}
          </button>
        </>
      )}
    </div>
  );
}
