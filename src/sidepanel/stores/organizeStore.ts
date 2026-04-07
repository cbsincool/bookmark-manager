import { create } from 'zustand';
import type { DomainCluster, OrganizeProposal } from '@/shared/types';

type WizardStep = 'idle' | 'domain' | 'connectivity' | 'classify' | 'preview';

interface OrganizeState {
  readonly step: WizardStep;
  readonly domainClusters: readonly DomainCluster[];
  readonly proposal: OrganizeProposal | null;
  readonly isProcessing: boolean;
  readonly setStep: (s: WizardStep) => void;
  readonly setDomainClusters: (c: DomainCluster[]) => void;
  readonly toggleDomainCluster: (domain: string) => void;
  readonly updateFolderName: (domain: string, name: string) => void;
  readonly setProposal: (p: OrganizeProposal | null) => void;
  readonly setProcessing: (p: boolean) => void;
  readonly reset: () => void;
}

export const useOrganizeStore = create<OrganizeState>((set, get) => ({
  step: 'idle',
  domainClusters: [],
  proposal: null,
  isProcessing: false,
  setStep: (step) => set({ step }),
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
  reset: () => set({ step: 'idle', domainClusters: [], proposal: null, isProcessing: false }),
}));
