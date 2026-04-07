import { useCallback, useRef } from 'react';
import Fuse from 'fuse.js';
import { useSearchStore } from '../stores/searchStore';
import type { BookmarkNode, SearchResult, SearchResultGroup } from '@/shared/types';

export function useSearch() {
  const { setResults, setLoading } = useSearchStore();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const search = useCallback(async (query: string) => {
    if (!query.trim()) {
      setResults([]);
      return;
    }

    setLoading(true);

    try {
      const resp = await chrome.runtime.sendMessage({ type: 'SEARCH', query });
      if (!resp?.success) {
        setResults([]);
        return;
      }

      const { bookmarks, semanticScores, settings } = resp.data as {
        bookmarks: BookmarkNode[];
        semanticScores: { id: string; semanticScore: number }[];
        settings: { fuzzyWeight: number; semanticWeight: number; collapseThreshold: number };
      };

      // Fuzzy search
      const fuse = new Fuse(bookmarks, {
        keys: ['title', 'url', 'path'],
        threshold: 0.4,
        includeScore: true,
      });
      const fuseResults = fuse.search(query);
      const fuzzyMap = new Map<string, number>();
      for (const r of fuseResults) {
        fuzzyMap.set(r.item.id, 1 - (r.score ?? 1));
      }

      // Semantic scores map
      const semanticMap = new Map<string, number>();
      for (const s of semanticScores) {
        semanticMap.set(s.id, Math.max(0, s.semanticScore));
      }

      // Merge and rank
      const allIds = new Set([...fuzzyMap.keys(), ...semanticMap.keys()]);
      const bookmarkMap = new Map(bookmarks.map((b) => [b.id, b]));

      const results: SearchResult[] = [];
      for (const id of allIds) {
        const bm = bookmarkMap.get(id);
        if (!bm) continue;

        const fuzzyScore = fuzzyMap.get(id) ?? 0;
        const semanticScore = semanticMap.get(id) ?? 0;
        const hybridScore = fuzzyScore * settings.fuzzyWeight + semanticScore * settings.semanticWeight;

        if (hybridScore > 0.05) {
          results.push({ bookmark: bm, fuzzyScore, semanticScore, hybridScore });
        }
      }

      results.sort((a, b) => b.hybridScore - a.hybridScore);
      const top50 = results.slice(0, 50);

      const groups = buildSearchGroups(top50, settings.collapseThreshold);
      setResults(groups);
    } catch (err) {
      console.error('Search failed:', err);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [setResults, setLoading]);

  const debouncedSearch = useCallback((query: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(query), 200);
  }, [search]);

  return { search: debouncedSearch };
}

function buildSearchGroups(
  results: readonly SearchResult[],
  threshold: number,
): SearchResultGroup[] {
  const groups: SearchResultGroup[] = [];
  const used = new Set<number>();

  for (let i = 0; i < results.length; i++) {
    if (used.has(i)) continue;
    const similar: SearchResult[] = [];
    used.add(i);

    for (let j = i + 1; j < results.length; j++) {
      if (used.has(j)) continue;
      const titleA = results[i].bookmark.title.toLowerCase();
      const titleB = results[j].bookmark.title.toLowerCase();
      const overlap = titleSimilarity(titleA, titleB);
      if (overlap >= threshold) {
        similar.push(results[j]);
        used.add(j);
      }
    }

    groups.push({
      representative: results[i],
      similar,
      isExpanded: false,
    });
  }

  return groups;
}

function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}
