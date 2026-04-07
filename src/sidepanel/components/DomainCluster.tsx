import React from 'react';
import type { DomainCluster as DomainClusterType } from '@/shared/types';
import { t } from '../i18n';

interface DomainClusterProps {
  readonly clusters: readonly DomainClusterType[];
  readonly onToggle: (domain: string) => void;
  readonly onRename: (domain: string, name: string) => void;
  readonly onNext: () => void;
}

export function DomainClusterView({ clusters, onToggle, onRename, onNext }: DomainClusterProps) {
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-700">{t('organize.domainStep')}</h3>

      <div className="space-y-2">
        {clusters.map((cluster) => (
          <div
            key={cluster.domain}
            className="flex items-center gap-3 p-3 bg-white rounded-lg border border-gray-200"
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
            </div>
            <span className="text-gray-400">→</span>
            <input
              type="text"
              value={cluster.suggestedFolderName}
              onChange={(e) => onRename(cluster.domain, e.target.value)}
              disabled={!cluster.selected}
              className="w-32 px-2 py-1 text-sm border border-gray-200 rounded disabled:opacity-40"
            />
          </div>
        ))}
      </div>

      <button
        onClick={onNext}
        className="w-full py-2.5 bg-primary text-white text-sm rounded-lg hover:bg-indigo-700"
      >
        {t('organize.next')}
      </button>
    </div>
  );
}
