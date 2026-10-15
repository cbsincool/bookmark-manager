import { create } from 'zustand';
import type { DedupGroup } from '@/shared/types';

interface DeletedHistory {
  readonly groupId: string;
  readonly deletedIds: readonly string[];
  readonly timestamp: number;
}

export interface FineDedupSummary {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly summary: string;
}

export interface FineDedupGroup {
  readonly reason: string;
  readonly keepId: string;
  readonly deleteIds: readonly string[];
}

export interface FineDedupResult {
  readonly summaries: readonly FineDedupSummary[];
  readonly aiResult: {
    readonly groups: readonly FineDedupGroup[];
    readonly standalone: readonly string[];
  } | null;
}

interface DedupState {
  readonly groups: readonly DedupGroup[];
  readonly isScanning: boolean;
  readonly isConfirmed: boolean;
  readonly manualSelectedIds: readonly string[];
  readonly progress: { step: string; current: number; total: number } | null;
  readonly deletedHistory: readonly DeletedHistory[];
  // Fine dedup
  readonly fineMode: boolean;
  readonly fineSelectedIds: readonly string[];
  readonly fineResult: FineDedupResult | null;
  readonly fineAnalyzing: boolean;
  readonly setGroups: (g: DedupGroup[]) => void;
  readonly setScanning: (s: boolean) => void;
  readonly setConfirmed: (c: boolean) => void;
  readonly setProgress: (p: { step: string; current: number; total: number } | null) => void;
  readonly updateKeepId: (groupId: string, keepId: string) => void;
  readonly removeGroup: (groupId: string) => void;
  readonly addDeletedHistory: (groupId: string, deletedIds: readonly string[]) => void;
  readonly clearDeletedHistory: () => void;
  readonly toggleManualSelect: (id: string) => void;
  readonly clearManualSelect: () => void;
  // Fine dedup actions
  readonly enterFineMode: () => void;
  readonly exitFineMode: () => void;
  readonly toggleFineSelect: (id: string) => void;
  readonly clearFineSelect: () => void;
  readonly setFineResult: (r: FineDedupResult | null) => void;
  readonly setFineAnalyzing: (v: boolean) => void;
  readonly reset: () => void;
}

export const useDedupStore = create<DedupState>((set, get) => ({
  groups: [],
  isScanning: false,
  isConfirmed: false,
  manualSelectedIds: [],
  progress: null,
  deletedHistory: [],
  fineMode: false,
  fineSelectedIds: [],
  fineResult: null,
  fineAnalyzing: false,
  setGroups: (groups) => set({ groups }),
  setScanning: (isScanning) => set({ isScanning }),
  setConfirmed: (isConfirmed) => set({ isConfirmed }),
  setProgress: (progress) => set({ progress }),
  updateKeepId: (groupId, keepId) => {
    const groups = get().groups.map((g) =>
      g.id === groupId ? { ...g, recommendedKeepId: keepId } : g,
    );
    set({ groups });
  },
  removeGroup: (groupId) => {
    set({ groups: get().groups.filter((g) => g.id !== groupId) });
  },
  addDeletedHistory: (groupId, deletedIds) => {
    set({
      deletedHistory: [...get().deletedHistory, { groupId, deletedIds, timestamp: Date.now() }],
    });
  },
  clearDeletedHistory: () => set({ deletedHistory: [] }),
  toggleManualSelect: (id) => {
    const ids = get().manualSelectedIds;
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    set({ manualSelectedIds: next });
  },
  clearManualSelect: () => set({ manualSelectedIds: [] }),
  enterFineMode: () => set({ fineMode: true, fineSelectedIds: [], fineResult: null }),
  exitFineMode: () => set({ fineMode: false, fineSelectedIds: [], fineResult: null, fineAnalyzing: false }),
  toggleFineSelect: (id) => {
    const ids = get().fineSelectedIds;
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    set({ fineSelectedIds: next });
  },
  clearFineSelect: () => set({ fineSelectedIds: [] }),
  setFineResult: (fineResult) => set({ fineResult }),
  setFineAnalyzing: (fineAnalyzing) => set({ fineAnalyzing }),
  reset: () => set({
    groups: [],
    isScanning: false,
    isConfirmed: false,
    progress: null,
    deletedHistory: [],
    manualSelectedIds: [],
    fineMode: false,
    fineSelectedIds: [],
    fineResult: null,
    fineAnalyzing: false,
  }),
}));