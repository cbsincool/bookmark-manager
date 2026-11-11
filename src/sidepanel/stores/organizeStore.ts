import { create } from 'zustand';
import type { DomainCluster, OrganizeProposal, OrganizeMode } from '@/shared/types';

type WizardStep = 'idle' | 'scope' | 'category' | 'connectivity' | 'domain' | 'classify' | 'preview';
type OrganizeScope = 'global' | 'folder';

interface OrganizeState {
  readonly step: WizardStep;
  readonly organizeScope: OrganizeScope;
  readonly organizeMode: OrganizeMode;
  /** 文件夹整理时是否允许书签移出该文件夹（默认否：只在内部细分） */
  readonly allowMoveOut: boolean;
  /** 允许移出的目标目录（相对书签栏的路径）。空 = 不限制 */
  readonly moveOutTargets: readonly string[];
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
  readonly setAllowMoveOut: (v: boolean) => void;
  readonly toggleMoveOutTarget: (path: string) => void;
  readonly setMoveOutTargets: (paths: readonly string[]) => void;
  readonly setDomainClusters: (c: DomainCluster[]) => void;
  readonly toggleDomainCluster: (domain: string) => void;
  readonly updateFolderName: (domain: string, name: string) => void;
  readonly setProposal: (p: OrganizeProposal | null) => void;
  readonly renamePath: (from: string, to: string) => void;
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
  allowMoveOut: false,
  moveOutTargets: [],
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
  setAllowMoveOut: (allowMoveOut) => set({ allowMoveOut }),
  toggleMoveOutTarget: (path) => {
    const current = get().moveOutTargets;
    set({
      moveOutTargets: current.includes(path)
        ? current.filter((p) => p !== path)
        : [...current, path],
    });
  },
  setMoveOutTargets: (moveOutTargets) => set({ moveOutTargets: [...moveOutTargets] }),
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
  renamePath: (from, to) => {
    const proposal = get().proposal;
    if (!proposal || from === to) return;

    // 改名必须**连子路径一起搬**。只换自己那个 key 的话，`RAID` 改成 `RENAMED_X`
    // 之后 `RAID/MegaCli` 还挂在旧路径下，执行时会把两棵都建出来——
    // 实测结果是 `硬件/RENAMED_X` 和 `硬件/RAID/MegaCli` 同时存在，树被劈成两半。
    const remap = (path: string): string => {
      if (path === from) return to;
      if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
      return path;
    };

    const next: Record<string, readonly string[]> = {};
    for (const [path, bookmarkIds] of Object.entries(proposal.directoryTree)) {
      const target = remap(path);
      next[target] = [...(next[target] ?? []), ...bookmarkIds];
    }

    set({
      proposal: {
        ...proposal,
        directoryTree: next,
        // 标注也要跟着改，否则改名之后「新建」「内聚度低」的标记会留在旧路径上，
        // 界面上就再也对不上——重命名联动了子路径，这些标记的错位面也跟着变大
        lowCohesionPaths: proposal.lowCohesionPaths.map(remap),
        overflowPaths: proposal.overflowPaths?.map(remap),
      },
    });
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
    allowMoveOut: false,
    moveOutTargets: [],
    organizeFolderId: '',
    organizeFolderName: '',
    domainClusters: [],
    proposal: null,
    isProcessing: false,
    categories: [],
      connectivityDeadCount: 0,
  }),
}));

