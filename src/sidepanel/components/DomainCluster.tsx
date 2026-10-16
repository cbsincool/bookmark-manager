import React from 'react';
import type { DomainCluster as DomainClusterType } from '@/shared/types';
import { t } from '../i18n';

interface DomainClusterProps {
  readonly clusters: readonly DomainClusterType[];
  readonly onToggle: (domain: string) => void;
  readonly onRename: (domain: string, name: string) => void;
  readonly onSelectAll: () => void;
  readonly onDeselectAll: () => void;
  readonly onNext: () => void;
  readonly onBack: () => void;
}

export function DomainClusterView({ clusters, onToggle, onRename, onSelectAll, onDeselectAll, onNext, onBack }: DomainClusterProps) {
  const selectedCount = clusters.filter((c) => c.selected).length;

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-700">{t('organize.domainStep')}</h3>
      <p className="text-xs text-gray-500">{t('organize.domainStep.hint')}</p>

      <div className="flex gap-2 items-center">
        <span className="text-xs text-gray-400 flex-1">已选 {selectedCount}/{clusters.length} 个域名</span>
        <button onClick={onSelectAll} className="text-xs text-indigo-600 hover:underline">{t('organize.domainStep.selectAll')}</button>
        <button onClick={onDeselectAll} className="text-xs text-gray-500 hover:underline">{t('organize.domainStep.deselectAll')}</button>
      </div>

      <div className="space-y-1 max-h-80 overflow-y-auto">
        {clusters.map((cluster) => (
          <div
            key={cluster.domain}
            className={`flex items-center gap-3 p-2 rounded-lg border ${cluster.selected ? 'border-indigo-200 bg-indigo-50' : 'border-gray-200 bg-white'}`}
          >
            <input
              type="checkbox"
              checked={cluster.selected}
              onChange={() => onToggle(cluster.domain)}
              className="w-4 h-4 text-primary rounded"
            />
            <div className="flex-1 min-w-0">
              <span className="text-sm text-gray-700">{cluster.domain}</span>
              <span className="text-xs text-gray-400 ml-2">({cluster.count})</span>
              {cluster.hasPortal && (
                <span
                  className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-amber-50 text-amber-700 border border-amber-200"
                  title={t('organize.domainStep.portalBadgeHint')}
                >
                  {t('organize.domainStep.portalBadge')}
                </span>
              )}
              {cluster.existingFolder && (
                <span
                  className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-emerald-50 text-emerald-700 border border-emerald-200"
                  title={t('organize.domainStep.inFolderHint')}
                >
                  {t('organize.domainStep.inFolder', { path: cluster.existingFolder })}
                </span>
              )}
            </div>
            {cluster.selected && (
              <>
                <span className="text-gray-400 text-xs">→</span>
                <input
                  type="text"
                  value={cluster.suggestedFolderName}
                  onChange={(e) => onRename(cluster.domain, e.target.value)}
                  className="w-28 px-2 py-1 text-xs border border-gray-200 rounded focus:border-indigo-400 focus:outline-none"
                />
              </>
            )}
          </div>
        ))}
        {clusters.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-4">无域名数据</p>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={onBack}
          className="flex-1 py-2.5 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200"
        >
          {t('organize.back')}
        </button>
        <button
          onClick={onNext}
          className="flex-1 py-2.5 bg-primary text-white text-sm rounded-lg hover:bg-indigo-700"
        >
          {t('organize.next')} {selectedCount > 0 ? `(${selectedCount})` : ''}
        </button>
      </div>
    </div>
  );
}
