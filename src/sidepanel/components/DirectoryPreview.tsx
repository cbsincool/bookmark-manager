import React from 'react';
import type { OrganizeProposal } from '@/shared/types';
import { t } from '../i18n';

interface DirectoryPreviewProps {
  readonly proposal: OrganizeProposal;
  readonly onExecute: () => void;
  readonly onCancel: () => void;
  readonly onRefineDir: (path: string) => void;
}

interface StatProps {
  readonly label: string;
  readonly value: number;
}

/** 必须定义在模块层：放在组件体内会被 React 当成每次渲染的新组件类型，导致整棵子树重挂载 */
function Stat({ label, value }: StatProps) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 px-2 py-1.5">
      <div className="text-base font-semibold text-gray-800">{value}</div>
      <div className="text-[10px] text-gray-500 leading-tight">{label}</div>
    </div>
  );
}

export function DirectoryPreview({ proposal, onExecute, onCancel, onRefineDir }: DirectoryPreviewProps) {
  const paths = Object.keys(proposal.directoryTree).sort();
  const overflowPaths = new Set(proposal.overflowPaths ?? []);
  const stats = proposal.stats;

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-700">{t('organize.previewStep')}</h3>

      {stats && (
        <div className="space-y-2">
          <div className="grid grid-cols-4 gap-2 text-center">
            <Stat label={t('organize.stats.skeleton')} value={stats.skeletonCount} />
            <Stat label={t('organize.stats.assigned')} value={stats.assigned} />
            <Stat label={t('organize.stats.overflowDirs')} value={stats.overflowDirectories} />
            <Stat label={t('organize.stats.unassigned')} value={stats.unassigned} />
          </div>
          {stats.warning === 'threshold-too-high' && (
            <p className="text-[11px] text-warning">{t('organize.stats.warnThreshold')}</p>
          )}
          {stats.warning === 'vector-dim-mismatch' && (
            <p className="text-[11px] text-warning">{t('organize.stats.warnVector')}</p>
          )}
          {stats.warning === 'ai-unavailable' && (
            <p className="text-[11px] text-gray-500">{t('organize.stats.warnAi')}</p>
          )}
          {stats.warning === 'ai-naming-failed' && (
            <p className="text-[11px] text-warning">{t('organize.stats.warnAiFailed')}</p>
          )}
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-1 font-mono text-sm">
        {paths.map((path) => {
          const count = proposal.directoryTree[path].length;
          const isLowCohesion = proposal.lowCohesionPaths.includes(path);
          const isOverflow = overflowPaths.has(path);
          const depth = path.split('/').length - 1;
          const indent = '  '.repeat(depth);
          const name = path.split('/').pop() ?? path;

          return (
            <div
              key={path}
              className={`flex items-center gap-2 ${isLowCohesion ? 'text-warning' : 'text-gray-700'}`}
            >
              <span>
                {indent}
                {isOverflow ? '📌' : '📁'} {name} ({count})
              </span>
              {isOverflow && (
                <span className="text-[10px] text-gray-400" title={t('organize.overflowDir')}>
                  {t('organize.overflowTag')}
                </span>
              )}
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
