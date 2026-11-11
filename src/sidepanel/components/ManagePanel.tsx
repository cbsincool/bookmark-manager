import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { t } from '../i18n';

interface FolderInfo {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly count: number;
}

interface FolderBookmark {
  readonly id: string;
  readonly title: string;
  readonly url: string;
}

type Mode = 'move' | 'merge';

/**
 * 手动管理：AI 归得不合理时的人工兜底。
 *
 * 两件事：把若干书签挪到另一个目录；把几个目录合并成一个。
 * 界面刻意做得朴素——侧边栏很窄，下拉框 + 勾选列表比树形控件好用，
 * 而且这两件事都是低频、需要明确确认的操作。
 */
export interface ManagePanelProps {
  /** 打开时默认展示哪个工具 */
  readonly initialMode?: Mode;
  /** 返回整理向导。不传就不显示返回按钮 */
  readonly onBack?: () => void;
}

export function ManagePanel({ initialMode = 'move', onBack }: ManagePanelProps) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  // 移动
  const [sourceId, setSourceId] = useState('');
  const [bookmarks, setBookmarks] = useState<FolderBookmark[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [moveTargetId, setMoveTargetId] = useState('');

  // 合并
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const [mergeTargetId, setMergeTargetId] = useState('');

  const loadFolders = useCallback(async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_FOLDER_STRUCTURE' });
      if (resp?.success) setFolders(resp.data as FolderInfo[]);
    } catch {
      setError(t('manage.loadFailed'));
    }
  }, []);

  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  const loadBookmarks = useCallback(async (folderId: string) => {
    if (!folderId) {
      setBookmarks([]);
      return;
    }
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_FOLDER_BOOKMARKS', folderId });
      setBookmarks(resp?.success ? (resp.data as FolderBookmark[]) : []);
      setSelectedIds([]);
    } catch {
      setBookmarks([]);
    }
  }, []);

  useEffect(() => {
    void loadBookmarks(sourceId);
  }, [sourceId, loadBookmarks]);

  const toggle = (list: readonly string[], id: string): string[] =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  const runMove = async () => {
    if (selectedIds.length === 0) {
      setError(t('manage.needSelection'));
      return;
    }
    if (!moveTargetId) {
      setError(t('manage.needTarget'));
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'MOVE_BOOKMARKS',
        ids: selectedIds,
        targetFolderId: moveTargetId,
      });
      if (!resp?.success) throw new Error(resp?.error || t('manage.actionFailed'));
      const r = resp.data as { moved: number; failed: number; failures: string[] };
      setMessage(t('manage.moved', { moved: r.moved }));
      if (r.failed > 0) setError(r.failures.join('\n'));
      setSelectedIds([]);
      await loadBookmarks(sourceId);
      await loadFolders();
    } catch (err) {
      setError(t('manage.failed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const runMerge = async () => {
    if (mergeIds.length === 0 || !mergeTargetId) {
      setError(t('manage.needSelection'));
      return;
    }
    if (!window.confirm(t('manage.confirmMerge'))) return;

    setBusy(true);
    setError('');
    setMessage('');
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'MERGE_FOLDERS',
        sourceIds: mergeIds.filter((id) => id !== mergeTargetId),
        targetFolderId: mergeTargetId,
      });
      if (!resp?.success) throw new Error(resp?.error || t('manage.actionFailed'));
      const r = resp.data as { moved: number; removed: number; failures: string[] };
      setMessage(t('manage.merged', { moved: r.moved, removed: r.removed }));
      if (r.failures.length > 0) setError(r.failures.join('\n'));
      setMergeIds([]);
      await loadFolders();
    } catch (err) {
      setError(t('manage.failed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const folderOptions = useMemo(
    () => folders.map((f) => ({ ...f, label: `${'　'.repeat(f.path.split('/').length - 1)}${f.title}` })),
    [folders],
  );

  return (
    <div className="p-4 space-y-4 enter">
      <div className="flex items-end justify-between">
        <div>
          <p className="eyebrow">Organize · Manual</p>
          <h2 className="text-[17px] font-semibold text-gray-900">{t('manage.title')}</h2>
        </div>
        {onBack && (
          <button onClick={onBack} className="btn-text">
            ← {t('organize.manual.back')}
          </button>
        )}
      </div>

      <div className="segment">
        {(['move', 'merge'] as const).map((m) => (
          <button
            key={m}
            onClick={() => { setMode(m); setMessage(''); setError(''); }}
            data-active={mode === m}
          >
            {t(m === 'move' ? 'manage.move.title' : 'manage.merge.title')}
          </button>
        ))}
      </div>

      {message && <div className="banner banner-ok"><span>{message}</span></div>}
      {error && <div className="banner banner-error"><span className="whitespace-pre-wrap">{error}</span></div>}

      {mode === 'move' ? (
        <div className="space-y-3">
          <p className="text-[11px] leading-relaxed text-gray-500">{t('manage.move.hint')}</p>

          <label className="block space-y-1 text-[11px] font-medium text-gray-600">
            {t('manage.move.source')}
            <select
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              className="field"
            >
              <option value="">{t('manage.selectFolder')}</option>
              {folderOptions.map((f) => (
                <option key={f.id} value={f.id}>{f.label} ({f.count})</option>
              ))}
            </select>
          </label>

          {sourceId && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">
                  {t('manage.move.selectedCount', { count: selectedIds.length, total: bookmarks.length })}
                </span>
                <button
                  onClick={() => setSelectedIds(
                    selectedIds.length === bookmarks.length ? [] : bookmarks.map((b) => b.id),
                  )}
                  className="btn-text"
                >
                  {selectedIds.length === bookmarks.length ? t('manage.none') : t('manage.all')}
                </button>
              </div>

              <div className="list max-h-64 overflow-y-auto divide-y divide-gray-100">
                {bookmarks.length === 0 && (
                  <p className="px-3 py-4 text-sm text-gray-400">{t('manage.move.empty')}</p>
                )}
                {bookmarks.map((b) => (
                  <label key={b.id} className="flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-gray-50">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(b.id)}
                      onChange={() => setSelectedIds(toggle(selectedIds, b.id))}
                      className="mt-0.5 w-4 h-4"
                    />
                    <span className="text-sm text-gray-700 break-all">{b.title || b.url}</span>
                  </label>
                ))}
              </div>

              <label className="block space-y-1 text-[11px] font-medium text-gray-600">
                {t('manage.move.target')}
                <select
                  value={moveTargetId}
                  onChange={(e) => setMoveTargetId(e.target.value)}
                  className="field"
                >
                  <option value="">{t('manage.selectFolder')}</option>
                  {folderOptions.map((f) => (
                    <option key={f.id} value={f.id}>{f.label}</option>
                  ))}
                </select>
              </label>

              <button
                onClick={runMove}
                disabled={busy || selectedIds.length === 0 || !moveTargetId}
                className="btn-grad mt-1"
              >
                {busy ? t('manage.busy') : t('manage.move.action', { count: selectedIds.length })}
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[11px] leading-relaxed text-gray-500">{t('manage.merge.hint')}</p>

          <div className="list max-h-64 overflow-y-auto divide-y divide-gray-100">
            {folderOptions.length === 0 && (
              <p className="px-3 py-4 text-sm text-gray-400">{t('manage.noFolders')}</p>
            )}
            {folderOptions.map((f) => (
              <label key={f.id} className="flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-gray-50">
                <input
                  type="checkbox"
                  checked={mergeIds.includes(f.id)}
                  onChange={() => setMergeIds(toggle(mergeIds, f.id))}
                  className="mt-0.5 w-4 h-4"
                />
                <span className="text-sm text-gray-700">
                  {f.label} <span className="text-xs text-gray-400">({f.count})</span>
                </span>
              </label>
            ))}
          </div>

          <label className="block space-y-1 text-[11px] font-medium text-gray-600">
            {t('manage.merge.target')}
            <select
              value={mergeTargetId}
              onChange={(e) => setMergeTargetId(e.target.value)}
              className="field"
            >
              <option value="">{t('manage.selectFolder')}</option>
              {folderOptions.map((f) => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </select>
          </label>

          <button
            onClick={runMerge}
            disabled={busy || mergeIds.length === 0 || !mergeTargetId}
            className="btn-grad mt-1"
          >
            {busy ? t('manage.busy') : t('manage.merge.action', { count: mergeIds.length })}
          </button>
        </div>
      )}
    </div>
  );
}
