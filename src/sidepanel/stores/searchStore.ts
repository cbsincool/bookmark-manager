import { create } from 'zustand';
import type { SearchResultGroup } from '@/shared/types';

interface SearchState {
  readonly query: string;
  readonly results: readonly SearchResultGroup[];
  readonly isLoading: boolean;
  readonly setQuery: (q: string) => void;
  readonly setResults: (r: SearchResultGroup[]) => void;
  readonly setLoading: (l: boolean) => void;
  readonly toggleGroup: (index: number) => void;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  results: [],
  isLoading: false,
  setQuery: (query) => set({ query }),
  setResults: (results) => set({ results }),
  setLoading: (isLoading) => set({ isLoading }),
  toggleGroup: (index) => {
    const results = [...get().results];
    const group = results[index];
    results[index] = { ...group, isExpanded: !group.isExpanded };
    set({ results });
  },
}));
