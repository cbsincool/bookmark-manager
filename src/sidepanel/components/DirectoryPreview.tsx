import React from 'react';
import type { OrganizeProposal } from '@/shared/types';
import { t } from '../i18n';

interface DirectoryPreviewProps {
  readonly proposal: OrganizeProposal;
  readonly onExecute: () => void;
  readonly onCancel: () => void;
  readonly onRefineDir: (path: string) => void;
}

export function DirectoryPreview({ proposal, onExecute, onCancel, onRefineDir }: DirectoryPreviewProps) {
  const paths = Object.keys(proposal.directoryTree).sort();

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-700">{t('organize.previewStep')}</h3>

      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-1 font-mono text-sm">
        {paths.map((path) => {
          const count = proposal.directoryTree[path].length;
          const isLowCohesion = proposal.lowCohesionPaths.includes(path);
          const depth = path.split('/').length - 1;
          const indent = '  '.repeat(depth);
          const name = path.split('/').pop() ?? path;

          return (
            <div
              key={path}
              className={`flex items-center gap-2 ${isLowCohesion ? 'text-warning' : 'text-gray-700'}`}
            >
              <span>{indent}📁 {name} ({count})</span>
              {isLowCohesion && (
                <button
                  onClick={() => onRefineDir(path)}
                  title={t('organize.lowCohesion')}
                  className="text-warning hover:text-yellow-600"
                >
                  ⚡
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex gap-2">
        <button
          onClick={onExecute}
          className="flex-1 py-2.5 bg-primary text-white text-sm rounded-lg hover:bg-indigo-700"
        >
          {t('organize.execute')}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2.5 text-sm text-gray-500 hover:text-gray-700"
        >
          {t('organize.cancel')}
        </button>
      </div>
    </div>
  );
}
