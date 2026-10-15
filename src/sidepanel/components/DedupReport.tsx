import React, { useState, useEffect } from 'react';
import { useDedupStore } from '../stores/dedupStore';
import type { FineDedupResult } from '../stores/dedupStore';
import { DedupCard } from './DedupCard';
import { t } from '../i18n';
import type { BookmarkNode, DedupGroup } from '@/shared/types';
import { useProgressListener } from '../hooks/useProgressListener';

// ---- Fine Dedup Result Panel ----

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

  const toggleDelete = (id: string) => {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const summaryMap = new Map(result.summaries.map((s) => [s.id, s]));

  if (!result.aiResult) {
    // No AI — just show summaries for user to compare
    return (
      <div className="space-y-3">
        <p className="text-xs text-gray-500">{t('dedup.fine.noAi')}</p>
        {result.summaries.map((s) => (
          <div key={s.id} className="p-3 bg-white border border-gray-200 rounded-lg space-y-1">
            <p className="text-sm font-medium text-gray-800 truncate">{s.title}</p>
            <p className="text-xs text-blue-500 truncate">{s.url}</p>
            {s.summary && <p className="text-xs text-gray-500 line-clamp-2">{s.summary}</p>}
          </div>
        ))}
        <button onClick={onClose} className="w-full py-2 text-sm border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50">
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
          <div key={i} className="p-3 bg-indigo-50 border border-indigo-200 rounded-lg space-y-2">
            <p className="text-xs text-indigo-600 font-medium">{g.reason}</p>
            {keepBm && (
              <div className="p-2 bg-green-50 border border-green-200 rounded">
                <p className="text-xs text-green-700 font-medium">✓ {t('dedup.fine.recommend')}</p>
                <p className="text-sm text-gray-800 truncate">{keepBm.title}</p>
                {keepBm.summary && <p className="text-xs text-gray-500 line-clamp-1">{keepBm.summary}</p>}
              </div>
            )}
            {g.deleteIds.map((id) => {
              const bm = summaryMap.get(id);
              if (!bm) return null;
              const checked = selected[id] ?? true;
              return (
                <label key={id} className="flex items-start gap-2 p-2 bg-white border border-gray-200 rounded cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleDelete(id)}
                    className="mt-0.5 w-4 h-4 text-red-500 rounded"
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
        <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg">
          <p className="text-xs text-gray-500 mb-1">{t('dedup.fine.standalone')}</p>
          {standalone.map((id) => {
            const bm = summaryMap.get(id);
            return bm ? (
              <p key={id} className="text-sm text-gray-700 truncate">• {bm.title}</p>
            ) : null;
          })}
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={onClose}
          className="flex-1 py-2 text-sm border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50"
        >
          {t('dedup.fine.close')}
        </button>
        {allDeleteIds.length > 0 && (
          <button
            onClick={() => onExecute(allDeleteIds)}
            className="flex-1 py-2 text-sm bg-danger text-white rounded-lg hover:bg-red-700"
          >
            {t('dedup.fine.execute', { count: allDeleteIds.length })}
          </button>
        )}
      </div>
    </div>
  );
}

// ---- Main Component ----

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
      if (resp?.success) {
        setGroups(resp.data);
      }
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

  const handleEnterManualMode = async () => {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_ALL_BOOKMARKS' });
    if (resp?.success) setAllBookmarks(resp.data as BookmarkNode[]);
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

  // --- Fine dedup ---

  const handleEnterFineMode = async () => {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_ALL_BOOKMARKS' });
    if (resp?.success) setAllBookmarks(resp.data as BookmarkNode[]);
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
        setFineStatusMsg(`❌ ${resp?.error ?? t('dedup.fine.failed')}`);
      }
    } catch (err) {
      setFineStatusMsg(`❌ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setFineAnalyzing(false);
    }
  };

  // Reflect backend progress in status message while analyzing
  useEffect(() => {
    if (fineAnalyzing && fineProgress?.message && !fineStatusMsg.startsWith('❌')) {
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
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-800">{t('dedup.title')}</h2>
        <div className="flex gap-2 flex-wrap justify-end">
          {deletedHistory.length > 0 && !isAnyMode && (
            <button
              onClick={handleUndo}
              disabled={undoing}
              className="px-3 py-1.5 text-xs border border-blue-300 text-blue-600 rounded-lg hover:bg-blue-50 disabled:opacity-50"
            >
              {undoing ? (
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin inline-block" />
                  {t('dedup.undo')}
                </span>
              ) : t('dedup.undo')}
            </button>
          )}

          {!isAnyMode ? (
            <>
              {groups.length > 0 && (
                <button onClick={reset} className="px-3 py-1.5 text-xs border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50">
                  {t('dedup.reset')}
                </button>
              )}
              <button onClick={handleEnterManualMode} className="px-3 py-1.5 text-xs border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50">
                {t('dedup.manual.selectMode')}
              </button>
              <button onClick={handleEnterFineMode} className="px-3 py-1.5 text-xs border border-purple-300 text-purple-600 rounded-lg hover:bg-purple-50">
                {t('dedup.fine.btn')}
              </button>
              <button
                onClick={startScan}
                disabled={isScanning}
                className="px-4 py-2 bg-primary text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                {isScanning ? (
                  <span className="flex items-center gap-2">
                    <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin inline-block" />
                    {scanProgress?.message ?? t('dedup.scanning')}
                  </span>
                ) : t('dedup.startScan')}
              </button>
            </>
          ) : (
            <button
              onClick={manualMode ? handleExitManualMode : exitFineMode}
              className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700"
            >
              {t('dedup.manual.cancel')}
            </button>
          )}
        </div>
      </div>

      {/* Manual select mode */}
      {manualMode && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">{t('dedup.manual.hint')}</p>
          <div className="space-y-1 max-h-80 overflow-y-auto">
            {allBookmarks.map((bm) => {
              const selected = manualSelectedIds.includes(bm.id);
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
                    onChange={() => toggleManualSelect(bm.id)}
                    className="mt-0.5 w-4 h-4 text-primary rounded"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-800 truncate">{bm.title}</p>
                    <p className="text-xs text-blue-500 truncate">{bm.url}</p>
                    <p className="text-xs text-gray-400">📁 {bm.path}</p>
                  </div>
                </label>
              );
            })}
          </div>
          {manualSelectedIds.length >= 2 && (
            <button
              onClick={handleForceDedup}
              disabled={isForcing}
              className="w-full py-2.5 bg-warning text-white text-sm rounded-lg hover:bg-yellow-600 disabled:opacity-50"
            >
              {isForcing ? t('dedup.processing') : t('dedup.manual.forceBtn', { count: manualSelectedIds.length })}
            </button>
          )}
        </div>
      )}

      {/* Fine dedup mode */}
      {fineMode && (
        <div className="space-y-3">
          {!fineResult ? (
            <>
              <p className="text-xs text-gray-500">{t('dedup.fine.hint')}</p>
              <div className="space-y-1 max-h-72 overflow-y-auto">
                {allBookmarks.map((bm) => {
                  const sel = fineSelectedIds.includes(bm.id);
                  return (
                    <label
                      key={bm.id}
                      className={`flex items-start gap-3 p-2 rounded-lg cursor-pointer transition-colors ${
                        sel ? 'bg-purple-50 border border-purple-200' : 'bg-white border border-gray-100 hover:bg-gray-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={sel}
                        onChange={() => toggleFineSelect(bm.id)}
                        className="mt-0.5 w-4 h-4 text-purple-600 rounded"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-800 truncate">{bm.title}</p>
                        <p className="text-xs text-blue-500 truncate">{bm.url}</p>
                        <p className="text-xs text-gray-400">📁 {bm.path}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
              {fineStatusMsg && (
                <p className="text-xs text-gray-500">{fineStatusMsg}</p>
              )}
              {fineSelectedIds.length >= 2 && (
                <button
                  onClick={handleFineAnalyze}
                  disabled={fineAnalyzing}
                  className="w-full py-2.5 bg-purple-600 text-white text-sm rounded-lg hover:bg-purple-700 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {fineAnalyzing && (
                    <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin inline-block" />
                  )}
                  {fineAnalyzing
                    ? fineStatusMsg || t('dedup.fine.analyzing')
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
          <p className="text-sm text-gray-400">{t('dedup.scanningHint')}</p>
        </div>
      )}

      {!isScanning && !isAnyMode && groups.length === 0 && (
        <div className="text-center py-8 space-y-2">
          <p className="text-sm text-gray-400">{t('dedup.noResults')}</p>
          <p className="text-xs text-gray-300">{t('dedup.scanHint')}</p>
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
            className="w-full py-2.5 bg-danger text-white text-sm rounded-lg hover:bg-red-700"
          >
            {t('dedup.confirmAll')}
          </button>
        </>
      )}
    </div>
  );
}
