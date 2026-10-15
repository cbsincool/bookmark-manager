import React from 'react';
import type { DedupGroup } from '@/shared/types';
import { t } from '../i18n';

interface DedupCardProps {
  readonly group: DedupGroup;
  readonly onKeepChange: (keepId: string) => void;
  readonly onConfirm: () => void;
  readonly onSkip: () => void;
}

const scenarioLabels: Record<string, string> = {
  'exact-url': 'dedup.scenario.exactUrl',
  'same-title': 'dedup.scenario.sameTitle',
  'manual': 'dedup.scenario.manual',
};

export function DedupCard({ group, onKeepChange, onConfirm, onSkip }: DedupCardProps) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
        <span className="text-xs font-medium text-gray-600">
          {t(scenarioLabels[group.scenario])} ({group.items.length})
        </span>
      </div>

      <div className="divide-y divide-gray-100">
        {group.items.map((item) => {
          const isKeep = item.bookmark.id === group.recommendedKeepId;
          return (
            <div
              key={item.bookmark.id}
              className={`px-4 py-3 flex items-start gap-3 cursor-pointer transition-colors ${
                isKeep ? 'bg-green-50' : 'bg-red-50/30 hover:bg-red-50/50'
              }`}
              onClick={() => onKeepChange(item.bookmark.id)}
            >
              <span className="text-lg mt-0.5">{isKeep ? '⭐' : '🗑'}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">
                  {item.bookmark.title}
                </p>
                <p className="text-xs text-blue-500 truncate">{item.bookmark.url}</p>
                <p className="text-xs text-gray-400 mt-1">📁 {item.bookmark.path}</p>
                <div className="flex gap-3 mt-1 text-xs text-gray-400">
                  <span>L1: {item.scores.l1}</span>
                  <span>L3: {item.scores.l3}</span>
                  <span className="font-medium text-gray-600">
                    {t(isKeep ? 'dedup.keep' : 'dedup.delete')}: {Math.round(item.totalScore)}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="px-4 py-2 bg-gray-50 border-t border-gray-200 flex justify-end gap-2">
        <button
          onClick={onSkip}
          className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700"
        >
          {t('dedup.skipGroup')}
        </button>
        <button
          onClick={onConfirm}
          className="px-3 py-1.5 text-xs bg-danger text-white rounded hover:bg-red-700"
        >
          {t('dedup.confirmGroup')}
        </button>
      </div>
    </div>
  );
}
