import React, { useEffect, useState } from 'react';
import type { OrganizeProposal } from '@/shared/types';
import { t } from '../i18n';

interface DirectoryPreviewProps {
  readonly proposal: OrganizeProposal;
  readonly onExecute: () => void;
  readonly onCancel: () => void;
  readonly onRefineDir: (path: string) => void;
  readonly onRenameDir: (from: string, to: string) => void;
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

interface EditableNameProps {
  readonly path: string;
  readonly onCommit: (nextLeaf: string) => void;
}

/**
 * 可编辑的目录名。用本地 state 缓冲输入，失焦或回车才提交——
 * 每敲一个字就改 store 会让整棵树重排，光标都会跳。
 */
function EditableName({ path, onCommit }: EditableNameProps) {
  const leaf = path.split('/').pop() ?? path;
  const [draft, setDraft] = useState(leaf);

  // 外部改名（例如合并了同义目录）后同步回来
  useEffect(() => setDraft(leaf), [leaf]);

  const commit = () => {
    const next = draft.trim();
    if (!next || next === leaf) {
      setDraft(leaf);
      return;
    }
    onCommit(next);
  };

  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') { setDraft(leaf); (e.target as HTMLInputElement).blur(); }
      }}
      spellCheck={false}
      className="min-w-0 flex-1 px-1 py-0.5 text-sm border border-transparent rounded hover:border-gray-200 focus:border-indigo-400 focus:outline-none bg-transparent"
    />
  );
}

export function DirectoryPreview({
  proposal,
  onExecute,
  onCancel,
  onRefineDir,
  onRenameDir,
}: DirectoryPreviewProps) {
  const paths = Object.keys(proposal.directoryTree).sort();
  const overflowPaths = new Set(proposal.overflowPaths ?? []);
  const stats = proposal.stats;

  const renameLeaf = (path: string, nextLeaf: string) => {
    const parent = path.split('/').slice(0, -1).join('/');
    onRenameDir(path, parent ? `${parent}/${nextLeaf}` : nextLeaf);
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-700">{t('organize.previewStep')}</h3>
      <p className="text-xs text-gray-400">{t('organize.preview.renameHint')}</p>

      {(proposal.mergedFolderNames?.length ?? 0) > 1 && (
        <p className="text-[11px] text-gray-500">
          {t('organize.mergedFolders')}
          {proposal.mergedFolderNames!.join(' + ')}
        </p>
      )}

      {stats && (
        <div className="space-y-2">
          <div className="grid grid-cols-4 gap-2 text-center">
            <Stat label={t('organize.stats.skeleton')} value={stats.skeletonCount} />
            <Stat label={t('organize.stats.assigned')} value={stats.assigned} />
            <Stat label={t('organize.stats.overflowDirs')} value={stats.overflowDirectories} />
            <Stat label={t('organize.stats.unassigned')} value={stats.unassigned} />
          </div>
          {stats.warning === 'nothing-to-do' && (
            <p className="text-[11px] text-warning">{t('organize.stats.warnNothingToDo')}</p>
          )}
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

      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-1 text-sm">
        {paths.map((path) => {
          const count = proposal.directoryTree[path].length;
          const isLowCohesion = proposal.lowCohesionPaths.includes(path);
          const isOverflow = overflowPaths.has(path);
          const depth = path.split('/').length - 1;
          const indent = '  '.repeat(depth);

          return (
            <div
              key={path}
              className={`flex items-center gap-2 ${isLowCohesion ? 'text-warning' : 'text-gray-700'}`}
            >
              <span className="shrink-0 text-gray-400">
                {indent}
                {isOverflow ? '📌' : '📁'}
              </span>
              <EditableName path={path} onCommit={(leaf) => renameLeaf(path, leaf)} />
              <span className="shrink-0 text-xs text-gray-400">({count})</span>
              {isOverflow && (
                <span className="shrink-0 text-[10px] text-gray-400" title={t('organize.overflowDir')}>
                  {t('organize.overflowTag')}
                </span>
              )}
              {isLowCohesion && (
                <button
                  onClick={() => onRefineDir(path)}
                  title={t('organize.lowCohesion')}
                  className="shrink-0 text-warning hover:text-yellow-600"
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
