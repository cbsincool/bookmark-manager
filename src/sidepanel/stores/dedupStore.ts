import { create } from 'zustand';
import type { DedupGroup } from '@/shared/types';

interface DedupState {
  readonly groups: readonly DedupGroup[];
  readonly isScanning: boolean;
  readonly isConfirmed: boolean;
  readonly setGroups: (g: DedupGroup[]) => void;
  readonly setScanning: (s: boolean) => void;
  readonly setConfirmed: (c: boolean) => void;
  readonly updateKeepId: (groupId: string, keepId: string) => void;
  readonly removeGroup: (groupId: string) => void;
}

export const useDedupStore = create<DedupState>((set, get) => ({
  groups: [],
  isScanning: false,
  isConfirmed: false,
  setGroups: (groups) => set({ groups }),
  setScanning: (isScanning) => set({ isScanning }),
  setConfirmed: (isConfirmed) => set({ isConfirmed }),
  updateKeepId: (groupId, keepId) => {
    const groups = get().groups.map((g) =>
      g.id === groupId ? { ...g, recommendedKeepId: keepId } : g,
    );
    set({ groups });
  },
  removeGroup: (groupId) => {
    set({ groups: get().groups.filter((g) => g.id !== groupId) });
  },
}));
