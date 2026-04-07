import React from 'react';
import { useSearchStore } from '../stores/searchStore';
import { useSearch } from '../hooks/useSearch';
import { SimilarGroup } from './SimilarGroup';
import { t } from '../i18n';

export function SearchPanel() {
  const { query, results, isLoading, setQuery, toggleGroup } = useSearchStore();
  const { search } = useSearch();

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);
    search(value);
  };

  return (
    <div className="p-4 space-y-4">
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={handleQueryChange}
          placeholder={t('search.placeholder')}
          className="w-full px-4 py-2.5 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
        />
        {isLoading && (
          <div className="absolute right-3 top-3">
            <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {results.length === 0 && query && !isLoading && (
        <p className="text-sm text-gray-400 text-center py-8">{t('search.noResults')}</p>
      )}

      <div className="space-y-2">
        {results.map((group, index) => (
          <SimilarGroup
            key={group.representative.bookmark.id}
            group={group}
            onToggle={() => toggleGroup(index)}
          />
        ))}
      </div>
    </div>
  );
}
