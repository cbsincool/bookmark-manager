import React from 'react';
import { useOrganizeStore } from '../stores/organizeStore';
import { DomainClusterView } from './DomainCluster';
import { DirectoryPreview } from './DirectoryPreview';
import { t } from '../i18n';

export function OrganizeWizard() {
  const store = useOrganizeStore();

  const startOrganize = async () => {
    store.setProcessing(true);
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'ORGANIZE_DOMAIN_CLUSTER' });
      if (resp?.success) {
        store.setDomainClusters(resp.data);
        store.setStep('domain');
      }
    } finally {
      store.setProcessing(false);
    }
  };

  const handleDomainNext = async () => {
    store.setStep('classify');
    store.setProcessing(true);

    try {
      const allResp = await chrome.runtime.sendMessage({ type: 'GET_ALL_BOOKMARKS' });
      if (!allResp?.success) return;

      const selectedBookmarkIds = new Set(
        store.domainClusters
          .filter((c) => c.selected)
          .flatMap((c) => [...c.bookmarkIds]),
      );

      const remaining = allResp.data.filter(
        (bm: { id: string }) => !selectedBookmarkIds.has(bm.id),
      );

      if (remaining.length > 0) {
        const classifyResp = await chrome.runtime.sendMessage({
          type: 'ORGANIZE_AI_CLASSIFY',
          bookmarks: remaining,
        });

        if (classifyResp?.success) {
          store.setProposal({
            directoryTree: classifyResp.data,
            lowCohesionPaths: [],
          });
        }
      }

      store.setStep('preview');
    } catch (err) {
      console.error('Classification failed:', err);
    } finally {
      store.setProcessing(false);
    }
  };

  const handleExecute = async () => {
    if (!store.proposal) return;
    store.setProcessing(true);

    try {
      const moves: { bookmarkId: string; targetFolderId: string }[] = [];

      await chrome.runtime.sendMessage({
        type: 'ORGANIZE_EXECUTE',
        moves,
      });

      store.reset();
    } finally {
      store.setProcessing(false);
    }
  };

  if (store.step === 'idle') {
    return (
      <div className="p-4 space-y-4">
        <h2 className="text-base font-semibold text-gray-800">{t('organize.title')}</h2>
        <button
          onClick={startOrganize}
          disabled={store.isProcessing}
          className="w-full py-2.5 bg-primary text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50"
        >
          {store.isProcessing ? '...' : t('organize.title')}
        </button>
      </div>
    );
  }

  return (
    <div className="p-4">
      {store.step === 'domain' && (
        <DomainClusterView
          clusters={store.domainClusters}
          onToggle={store.toggleDomainCluster}
          onRename={store.updateFolderName}
          onNext={handleDomainNext}
        />
      )}

      {store.step === 'classify' && store.isProcessing && (
        <div className="text-center py-8">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-gray-400 mt-4">{t('organize.classifyStep')}...</p>
        </div>
      )}

      {store.step === 'preview' && store.proposal && (
        <DirectoryPreview
          proposal={store.proposal}
          onExecute={handleExecute}
          onCancel={() => store.reset()}
          onRefineDir={(path) => {
            console.log('Refine:', path);
          }}
        />
      )}
    </div>
  );
}
