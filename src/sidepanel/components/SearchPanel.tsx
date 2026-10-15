import React from 'react';
import { useSearchStore } from '../stores/searchStore';
import { useSearch } from '../hooks/useSearch';
import { SimilarGroup } from './SimilarGroup';
import { t } from '../i18n';

export function SearchPanel() {
  const { query, sections, isLoading, setQuery, toggleGroup, toggleSection } = useSearchStore();
  const { search } = useSearch();

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);
    search(value);
  };

  const totalResults = sections.reduce(
    (sum, section) => sum + sectionCount(section),
    0,
  );

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
          <div className="absolute right-3 top-2.5 flex items-center gap-1.5">
            <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {isLoading && query && (
        <p className="text-xs text-gray-400 text-center">{t('search.searching')}</p>
      )}

      {totalResults === 0 && query && !isLoading && (
        <p className="text-sm text-gray-400 text-center py-8">{t('search.noResults')}</p>
      )}

      {sections.map((section, sectionIndex) => (
        <div key={section.tier} className="space-y-2">
          <button
            onClick={() => toggleSection(sectionIndex)}
            className="w-full flex items-center justify-between px-1 py-1 text-xs font-medium text-gray-500 hover:text-primary transition-colors"
          >
            <span>
              {section.isExpanded ? '▾' : '▸'} {t(`search.tier.${section.tier}`)}
            </span>
            <span className="text-gray-400">{sectionCount(section)}</span>
          </button>

          {section.isExpanded && (
            <div className="space-y-2">
              {section.groups.map((group, groupIndex) => (
                <SimilarGroup
                  key={group.representative.bookmark.id}
                  group={group}
                  onToggle={() => toggleGroup(sectionIndex, groupIndex)}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function sectionCount(section: { groups: readonly { similar: readonly unknown[] }[] }): number {
  return section.groups.reduce((sum, group) => sum + 1 + group.similar.length, 0);
}
