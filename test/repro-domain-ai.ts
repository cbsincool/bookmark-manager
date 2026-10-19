/**
 * 复刻向导 handleDomainNext 的完整流程：域名预归类 + 剩余交给 AI，再合并。
 * 用用户真实书签跑，看「除了域名目录，其余全进未分类」是怎么产生的。
 *
 * 用法：BM_AI_KEY=xxx npx tsx test/repro-domain-ai.ts [选中前N个域名]
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildDomainClusters } from '../src/background/organizeEngine';
import { classifyBookmarks } from '../src/background/aiClassifier';
import { DEFAULT_SETTINGS, MAX_BATCH_SIZE, UNCLASSIFIED_DIR } from '../src/shared/constants';
import type { BookmarkNode } from '../src/shared/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY = process.env.BM_AI_KEY ?? '';

interface RealBookmark {
  readonly title: string;
  readonly url: string;
  readonly path: string;
}

async function main(): Promise<number> {
  if (!KEY) {
    console.error('缺少 BM_AI_KEY');
    return 2;
  }

  const pick = Number(process.argv[2] ?? 3);
  const raw = JSON.parse(
    readFileSync(join(HERE, '_real-bookmarks.json'), 'utf8'),
  ) as RealBookmark[];

  const bookmarks: BookmarkNode[] = raw.map((b, i) => ({
    id: String(i), title: b.title, url: b.url, path: b.path,
  }));

  // --- 域名聚类 ---
  const clusters = buildDomainClusters(bookmarks, 1, '书签栏');
  const selected = clusters.slice(0, pick);
  console.log(`域名簇 ${clusters.length} 个，模拟选中前 ${pick} 个:`);
  for (const c of selected) {
    console.log(`  ${c.domain}  ${c.count} 条  → 目录名 "${c.suggestedFolderName}"`);
  }

  const domainTree: Record<string, string[]> = {};
  const claimed = new Set<string>();
  for (const c of selected) {
    domainTree[c.suggestedFolderName] = [
      ...(domainTree[c.suggestedFolderName] ?? []),
      ...c.bookmarkIds,
    ];
    c.bookmarkIds.forEach((id) => claimed.add(id));
  }

  const remaining = bookmarks.filter((b) => !claimed.has(b.id));
  console.log(`\n域名覆盖 ${claimed.size} 条，交给 AI ${remaining.length} 条`);

  // --- AI 分类剩余书签 ---
  const settings = { ...DEFAULT_SETTINGS, apiKey: KEY };
  const outcome = await classifyBookmarks(
    remaining.map((b) => ({ id: b.id, title: b.title, url: b.url })),
    [],   // 向导传的 scope=global，fit 模式下会是现有目录；这里先按 replan 的空集合
    settings,
    { batchSize: MAX_BATCH_SIZE, maxDepth: 3 },
  );

  console.log(`\nAI 结果: usedAi=${outcome.usedAi} 归属 ${outcome.assignments.size}/${remaining.length} 条`);
  if (outcome.detail) console.log(`detail: ${outcome.detail}`);

  const aiTree: Record<string, string[]> = {};
  for (const [id, path] of outcome.assignments) {
    aiTree[path] = [...(aiTree[path] ?? []), id];
  }

  // --- 合并（与 handleDomainNext 一致） ---
  const merged: Record<string, string[]> = { ...domainTree };
  for (const [path, ids] of Object.entries(aiTree)) {
    merged[path] = [...(merged[path] ?? []), ...ids];
  }

  const assigned = new Set(Object.values(merged).flat());
  const unassigned = bookmarks.filter((b) => !assigned.has(b.id)).map((b) => b.id);
  if (unassigned.length > 0) merged[UNCLASSIFIED_DIR] = unassigned;

  console.log('\n--- 合并后的目录树 ---');
  for (const [path, ids] of Object.entries(merged).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(ids.length).padStart(3)} 条  ${path}`);
  }
  console.log(`\n未分类 ${unassigned.length} 条 / 共 ${bookmarks.length} 条`);

  return 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
