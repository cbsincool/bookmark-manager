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
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
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
      title={t('organize.preview.renameTitle')}
      className="min-w-0 flex-1 rounded-md border border-transparent px-1.5 py-0.5 text-[12px] text-gray-800
                 transition-colors hover:border-gray-200 hover:bg-gray-50
                 focus:border-indigo-400 focus:bg-white focus:outline-none"
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
    <div className="space-y-4 enter">
      <div className="space-y-1">
        <p className="eyebrow">Organize · Preview</p>
        <h3 className="text-[15px] font-semibold text-gray-900">{t('organize.previewStep')}</h3>
      </div>
      <p className="text-[11px] leading-relaxed text-gray-500">{t('organize.preview.renameHint')}</p>

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

      <div className="list p-2 text-[12px]">
        {paths.map((path) => {
          const count = proposal.directoryTree[path].length;
          const isLowCohesion = proposal.lowCohesionPaths.includes(path);
          const isOverflow = overflowPaths.has(path);
          const parts = path.split('/');
          const leaf = parts[parts.length - 1];
          const parentPath = parts.slice(0, -1).join('/');
          const depth = parts.length - 1;

          return (
            <div
              key={path}
              className={`flex items-center gap-2 rounded-md px-1 py-1 ${isLowCohesion ? 'text-warning' : 'text-gray-700'}`}
              // 缩进必须走 padding：原先是往 span 里塞 `'  '.repeat(depth)` 空格，
              // 而 HTML 会把连续空格折叠掉——实测每一行的图标左偏移都是同一个值，
              // 树被拍平成一个列表
              style={{ paddingLeft: depth * 14 }}
            >
              <span className={`tree-icon shrink-0 ${isOverflow ? 'text-primary' : 'text-gray-500'}`}>
                {isOverflow ? '📌' : '📁'}
              </span>
              {/* 父路径要显出来。只显示叶子名时，`存储设备/硬盘` 和 `存储/硬盘`
                  两行都是「硬盘」，缩进也一样（同层），根本分不出谁是谁；
                  父目录没有直属书签时它自己根本没有行，层级也就无从对照 */}
              {parentPath && (
                <span className="shrink-0 text-xs text-gray-400">{parentPath}/</span>
              )}
              <EditableName path={path} onCommit={(leaf) => renameLeaf(path, leaf)} />
              <span className="tabular shrink-0 text-[11px] text-gray-400">{count}</span>
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
        <button onClick={onExecute} className="btn-grad flex-1">
          {t('organize.execute')}
        </button>
        <button onClick={onCancel} className="btn-tonal px-4">
          {t('organize.cancel')}
        </button>
      </div>
    </div>
  );
}
