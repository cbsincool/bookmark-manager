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

/** 整行不再铺红/绿底色——用左侧色条 + 单选圆点表达「留哪条」，安静得多 */
function RadioDot({ checked }: { checked: boolean }) {
  return (
    <span
      className={`mt-1 w-4 h-4 shrink-0 rounded-full border-2 flex items-center justify-center ${
        checked ? 'border-primary' : 'border-gray-300'
      }`}
      aria-hidden="true"
    >
      {checked && <span className="w-2 h-2 rounded-full bg-primary" />}
    </span>
  );
}

export function DedupCard({ group, onKeepChange, onConfirm, onSkip }: DedupCardProps) {
  const deleteCount = group.items.length - 1;

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
        <span className="text-xs font-medium text-gray-600">
          {t(scenarioLabels[group.scenario])} · {group.items.length}
        </span>
        <span className="text-xs text-gray-400">
          {t('dedup.card.deleteCount', { count: deleteCount })}
        </span>
      </div>

      <div className="divide-y divide-gray-100">
        {group.items.map((item) => {
          const isKeep = item.bookmark.id === group.recommendedKeepId;
          return (
            <button
              key={item.bookmark.id}
              type="button"
              onClick={() => onKeepChange(item.bookmark.id)}
              className={`w-full text-left px-4 py-3 flex items-start gap-3 cursor-pointer transition-colors border-l-2 ${
                isKeep
                  ? 'border-l-success bg-gray-50'
                  : 'border-l-transparent hover:bg-gray-50'
              }`}
            >
              <RadioDot checked={isKeep} />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-800 truncate">{item.bookmark.title}</p>
                <p className="text-xs text-gray-500 truncate">{item.bookmark.url}</p>
                <p className="text-[10px] text-gray-400 truncate mt-0.5">{item.bookmark.path}</p>
                <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-400">
                  <span>L1 {item.scores.l1}</span>
                  <span>L2 {item.scores.l2}</span>
                  <span>L3 {item.scores.l3}</span>
                  <span className={`font-medium ${isKeep ? 'text-success' : 'text-gray-500'}`}>
                    {Math.round(item.totalScore)}
                  </span>
                </div>
              </div>
              {isKeep && (
                <span className="shrink-0 text-[10px] text-success mt-1">{t('dedup.keep')}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="px-4 py-2 bg-gray-50 border-t border-gray-200 flex justify-end items-center gap-3">
        <button
          onClick={onSkip}
          className="text-xs text-gray-500 hover:text-gray-700 cursor-pointer"
        >
          {t('dedup.skipGroup')}
        </button>
        <button
          onClick={onConfirm}
          className="btn-danger"
        >
          {t('dedup.confirmGroup')}
        </button>
      </div>
    </div>
  );
}
