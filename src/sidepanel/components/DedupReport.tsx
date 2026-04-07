import React, { useState } from 'react';
import { useDedupStore } from '../stores/dedupStore';
import { DedupCard } from './DedupCard';
import { t } from '../i18n';

export function DedupReport() {
  const { groups, isScanning, setGroups, setScanning, updateKeepId, removeGroup } = useDedupStore();
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);

  const startScan = async () => {
    setShowConfirmDialog(true);
  };

  const confirmScan = async () => {
    setShowConfirmDialog(false);
    setScanning(true);
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

    await chrome.runtime.sendMessage({
      type: 'DEDUP_EXECUTE',
      keepIds,
      deleteIds,
    });

    removeGroup(groupId);
  };

  const handleConfirmAll = async () => {
    for (const group of groups) {
      await handleConfirmGroup(group.id);
    }
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-800">{t('dedup.title')}</h2>
        <button
          onClick={startScan}
          disabled={isScanning}
          className="px-4 py-2 bg-primary text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50"
        >
          {isScanning ? t('dedup.scanning') : t('dedup.title')}
        </button>
      </div>

      {showConfirmDialog && (
        <div className="p-4 bg-warning/10 border border-warning/30 rounded-lg">
          <p className="text-sm text-gray-700">{t('dedup.confirm')}</p>
          <div className="flex gap-2 mt-3">
            <button
              onClick={confirmScan}
              className="px-3 py-1.5 bg-warning text-white text-xs rounded"
            >
              {t('organize.execute')}
            </button>
            <button
              onClick={() => setShowConfirmDialog(false)}
              className="px-3 py-1.5 text-xs text-gray-500"
            >
              {t('organize.cancel')}
            </button>
          </div>
        </div>
      )}

      {groups.length === 0 && !isScanning && (
        <p className="text-sm text-gray-400 text-center py-8">{t('dedup.noResults')}</p>
      )}

      {groups.length > 0 && (
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
