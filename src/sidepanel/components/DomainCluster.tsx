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
    <div className="space-y-5">
      <div className="space-y-1">
        <p className="eyebrow">Organize · Domains</p>
        <h3 className="text-[15px] font-semibold text-gray-900">{t('organize.domainStep')}</h3>
        <p className="text-[11px] leading-relaxed text-gray-500">{t('organize.domainStep.hint')}</p>
      </div>

      <div className="flex items-center gap-1">
        <span className="flex-1 text-[11px] text-gray-500">
          {t('organize.domainStep.selected', { selected: selectedCount, total: clusters.length })}
        </span>
        <button onClick={onSelectAll} className="btn-text">{t('organize.domainStep.selectAll')}</button>
        <button onClick={onDeselectAll} className="btn-text text-gray-500">{t('organize.domainStep.deselectAll')}</button>
      </div>

      <div className="list max-h-80 divide-y divide-gray-100 overflow-y-auto">
        {clusters.map((cluster) => (
          <div
            key={cluster.domain}
            className={`list-row items-center ${cluster.selected ? 'bg-primary/[0.05]' : ''}`}
          >
            <input
              type="checkbox"
              checked={cluster.selected}
              onChange={() => onToggle(cluster.domain)}
              className="mt-0.5 h-4 w-4 rounded"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <span className="truncate text-[12px] text-gray-800">{cluster.domain}</span>
                <span className="tabular shrink-0 text-[10px] text-gray-400">{cluster.count}</span>
              </div>
              {(cluster.hasPortal || cluster.existingFolder) && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {cluster.hasPortal && (
                    <span className="badge badge-warn" title={t('organize.domainStep.portalBadgeHint')}>
                      {t('organize.domainStep.portalBadge')}
                    </span>
                  )}
                  {cluster.existingFolder && (
                    <span className="badge badge-ok" title={t('organize.domainStep.inFolderHint')}>
                      {t('organize.domainStep.inFolder', { path: cluster.existingFolder })}
                    </span>
                  )}
                </div>
              )}
            </div>
            {cluster.selected && (
              <input
                type="text"
                value={cluster.suggestedFolderName}
                onChange={(e) => onRename(cluster.domain, e.target.value)}
                className="field w-28 shrink-0"
                aria-label={t('organize.domainStep.renameLabel')}
              />
            )}
          </div>
        ))}
        {clusters.length === 0 && (
          <p className="py-5 text-center text-[11px] text-gray-400">{t('organize.domainStep.empty')}</p>
        )}
      </div>

      <div className="flex gap-2">
        <button onClick={onBack} className="btn-tonal flex-1">
          {t('organize.back')}
        </button>
        <button onClick={onNext} className="btn-grad flex-1">
          {t('organize.next')} {selectedCount > 0 ? `(${selectedCount})` : ''}
        </button>
      </div>
    </div>
  );
}
