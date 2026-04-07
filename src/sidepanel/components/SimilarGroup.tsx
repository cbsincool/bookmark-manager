import React from 'react';
import type { SearchResultGroup } from '@/shared/types';
import { SearchResultCard } from './SearchResultCard';
import { t } from '../i18n';

interface SimilarGroupProps {
  readonly group: SearchResultGroup;
  readonly onToggle: () => void;
}

export function SimilarGroup({ group, onToggle }: SimilarGroupProps) {
  return (
    <div className="space-y-1">
      <SearchResultCard result={group.representative} isRecommended />

      {group.similar.length > 0 && (
        <button
          onClick={onToggle}
          className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:text-primary transition-colors"
        >
          {group.isExpanded ? '▾' : '▸'}{' '}
          {t('search.similarCount', { count: group.similar.length })}
        </button>
      )}

      {group.isExpanded && (
        <div className="pl-4 space-y-1 border-l-2 border-gray-200">
          {group.similar.map((result) => (
            <SearchResultCard key={result.bookmark.id} result={result} />
          ))}
        </div>
      )}
    </div>
  );
}
