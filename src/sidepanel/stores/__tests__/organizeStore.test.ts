import { describe, it, expect, beforeEach } from 'vitest';
import { useOrganizeStore } from '../organizeStore';
import type { OrganizeProposal } from '@/shared/types';

const proposal = (tree: Record<string, readonly string[]>): OrganizeProposal => ({
  directoryTree: tree,
  lowCohesionPaths: [],
  skeletonPaths: [],
  overflowPaths: [],
});

describe('renamePath', () => {
  beforeEach(() => {
    useOrganizeStore.getState().reset();
  });

  it('renames the directory itself', () => {
    useOrganizeStore.getState().setProposal(proposal({ RAID: ['1', '2'] }));

    useOrganizeStore.getState().renamePath('RAID', 'RAID卡');

    expect(useOrganizeStore.getState().proposal?.directoryTree).toEqual({ RAID卡: ['1', '2'] });
  });

  it('renames descendants too', () => {
    // 只换自己那个 key 的话，执行时会把 `RENAMED_X` 和 `RAID/MegaCli` 两棵都建出来，
    // 树被劈成两半——实测就是这个结果
    useOrganizeStore.getState().setProposal(
      proposal({ RAID: ['1'], 'RAID/MegaCli': ['2'], 'RAID/DellPERC5': ['3'] }),
    );

    useOrganizeStore.getState().renamePath('RAID', 'RENAMED_X');

    expect(useOrganizeStore.getState().proposal?.directoryTree).toEqual({
      RENAMED_X: ['1'],
      'RENAMED_X/MegaCli': ['2'],
      'RENAMED_X/DellPERC5': ['3'],
    });
  });

  it('leaves unrelated paths untouched', () => {
    useOrganizeStore.getState().setProposal(
      proposal({ RAID: ['1'], 'RAIDX/other': ['2'], 存储: ['3'] }),
    );

    useOrganizeStore.getState().renamePath('RAID', 'RAID卡');

    const tree = useOrganizeStore.getState().proposal?.directoryTree;
    // `RAIDX/other` 前缀相同但不是子路径，不能被误改
    expect(tree).toEqual({ RAID卡: ['1'], 'RAIDX/other': ['2'], 存储: ['3'] });
  });

  it('merges into an existing directory instead of dropping bookmarks', () => {
    useOrganizeStore.getState().setProposal(proposal({ A: ['1'], B: ['2'] }));

    useOrganizeStore.getState().renamePath('A', 'B');

    expect(useOrganizeStore.getState().proposal?.directoryTree).toEqual({ B: ['1', '2'] });
  });

  it('keeps the overflow and low-cohesion markers pointing at the new path', () => {
    // 标记留在旧路径上，改名之后界面上就再也对不上
    useOrganizeStore.getState().setProposal({
      ...proposal({ RAID: ['1'], 'RAID/MegaCli': ['2'] }),
      overflowPaths: ['RAID/MegaCli'],
      lowCohesionPaths: ['RAID'],
    });

    useOrganizeStore.getState().renamePath('RAID', 'RENAMED_X');

    const state = useOrganizeStore.getState().proposal;
    expect(state?.overflowPaths).toEqual(['RENAMED_X/MegaCli']);
    expect(state?.lowCohesionPaths).toEqual(['RENAMED_X']);
  });

  it('is a no-op when renaming to the same name', () => {
    useOrganizeStore.getState().setProposal(proposal({ RAID: ['1'] }));

    useOrganizeStore.getState().renamePath('RAID', 'RAID');

    expect(useOrganizeStore.getState().proposal?.directoryTree).toEqual({ RAID: ['1'] });
  });
});
