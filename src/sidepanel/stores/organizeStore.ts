import { create } from 'zustand';
import type { DomainCluster, OrganizeProposal, OrganizeMode } from '@/shared/types';

type WizardStep = 'idle' | 'scope' | 'category' | 'connectivity' | 'domain' | 'classify' | 'preview';
type OrganizeScope = 'global' | 'folder';

interface OrganizeState {
  readonly step: WizardStep;
  readonly organizeScope: OrganizeScope;
  readonly organizeMode: OrganizeMode;
  readonly organizeFolderId: string;
  readonly organizeFolderName: string;
  readonly domainClusters: readonly DomainCluster[];
  readonly proposal: OrganizeProposal | null;
  readonly isProcessing: boolean;
  readonly categories: readonly string[];
  readonly connectivityDeadCount: number;
  readonly setStep: (s: WizardStep) => void;
  readonly setOrganizeScope: (s: OrganizeScope, folderId?: string, folderName?: string) => void;
  readonly setOrganizeMode: (m: OrganizeMode) => void;
  readonly setDomainClusters: (c: DomainCluster[]) => void;
  readonly toggleDomainCluster: (domain: string) => void;
  readonly updateFolderName: (domain: string, name: string) => void;
  readonly setProposal: (p: OrganizeProposal | null) => void;
  readonly setProcessing: (p: boolean) => void;
  readonly setCategories: (c: string[]) => void;
  readonly addCategory: (c: string) => void;
  readonly removeCategory: (c: string) => void;
  readonly setConnectivityDeadCount: (n: number) => void;
  readonly reset: () => void;
}

export const useOrganizeStore = create<OrganizeState>((set, get) => ({
  step: 'idle',
  organizeScope: 'global',
  organizeMode: 'fit',
  organizeFolderId: '',
  organizeFolderName: '',
  domainClusters: [],
  proposal: null,
  isProcessing: false,
  categories: [],
  connectivityDeadCount: 0,
  setStep: (step) => set({ step }),
  setOrganizeScope: (organizeScope, organizeFolderId = '', organizeFolderName = '') =>
    set({ organizeScope, organizeFolderId, organizeFolderName }),
  setOrganizeMode: (organizeMode) => set({ organizeMode }),
  setDomainClusters: (domainClusters) => set({ domainClusters }),
  toggleDomainCluster: (domain) => {
    const clusters = get().domainClusters.map((c) =>
      c.domain === domain ? { ...c, selected: !c.selected } : c,
    );
    set({ domainClusters: clusters });
  },
  updateFolderName: (domain, suggestedFolderName) => {
    const clusters = get().domainClusters.map((c) =>
      c.domain === domain ? { ...c, suggestedFolderName } : c,
    );
    set({ domainClusters: clusters });
  },
  setProposal: (proposal) => set({ proposal }),
  setProcessing: (isProcessing) => set({ isProcessing }),
  setCategories: (categories) => set({ categories }),
  addCategory: (category) => {
    const current = get().categories;
    if (!current.includes(category)) {
      set({ categories: [...current, category] });
    }
  },
  removeCategory: (category) => {
    const current = get().categories;
    if (current.length > 1) {
      set({ categories: current.filter((c) => c !== category) });
    }
  },
  setConnectivityDeadCount: (connectivityDeadCount) => set({ connectivityDeadCount }),
  reset: () => set({
    step: 'idle',
    organizeScope: 'global',
    organizeMode: 'fit',
    organizeFolderId: '',
    organizeFolderName: '',
    domainClusters: [],
    proposal: null,
    isProcessing: false,
    categories: [],
      connectivityDeadCount: 0,
  }),
}));

