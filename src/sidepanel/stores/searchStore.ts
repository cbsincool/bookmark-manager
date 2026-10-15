import { create } from 'zustand';
import type { SearchSection } from '@/shared/types';

interface SearchState {
  readonly query: string;
  readonly sections: readonly SearchSection[];
  readonly isLoading: boolean;
  readonly setQuery: (q: string) => void;
  readonly setSections: (s: SearchSection[]) => void;
  readonly setLoading: (l: boolean) => void;
  readonly toggleGroup: (sectionIndex: number, groupIndex: number) => void;
  readonly toggleSection: (sectionIndex: number) => void;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  sections: [],
  isLoading: false,
  setQuery: (query) => set({ query }),
  setSections: (sections) => set({ sections }),
  setLoading: (isLoading) => set({ isLoading }),
  toggleGroup: (sectionIndex, groupIndex) => {
    const section = get().sections[sectionIndex];
    if (!section) return;

    const groups = section.groups.map((group, i) =>
      i === groupIndex ? { ...group, isExpanded: !group.isExpanded } : group,
    );
    const sections = get().sections.map((s, i) =>
      i === sectionIndex ? { ...s, groups } : s,
    );
    set({ sections });
  },
  toggleSection: (sectionIndex) => {
    const sections = get().sections.map((s, i) =>
      i === sectionIndex ? { ...s, isExpanded: !s.isExpanded } : s,
    );
    set({ sections });
  },
}));
