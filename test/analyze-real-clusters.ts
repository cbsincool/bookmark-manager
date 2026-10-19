/**
 * 用**用户真实的书签标题**离线跑一遍新的「分批 AI 归档」，看产出什么目录结构。
 * 不碰浏览器、不动书签。
 *
 * 用法：BM_AI_KEY=xxx npx tsx test/analyze-real-clusters.ts [初始目录...]
 *   不传初始目录 = 模拟 replan（从空目录集合开始）
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { classifyBookmarks } from '../src/background/aiClassifier';
import { DEFAULT_SETTINGS, MAX_BATCH_SIZE } from '../src/shared/constants';

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

  // --must=a,b  必须归入这些目录（模拟用户勾选的移出目标）
  // --only=xxx  只看路径含 xxx 的书签（模拟「整理指定文件夹」）
  const args = process.argv.slice(2);
  const mustUse = (args.find((a) => a.startsWith('--must='))?.slice(7) ?? '')
    .split(',').map((x) => x.trim()).filter(Boolean);
  const only = args.find((a) => a.startsWith('--only='))?.slice(7);
  const initialPaths = args.filter((a) => !a.startsWith('--'));

  let items = JSON.parse(
    readFileSync(join(HERE, '_real-bookmarks.json'), 'utf8'),
  ) as RealBookmark[];
  if (only) items = items.filter((b) => b.path.includes(only));
  console.log(`真实书签 ${items.length} 条，初始目录 ${initialPaths.length} 个`);
  if (initialPaths.length > 0) console.log(`  ${initialPaths.join(' / ')}`);
  if (mustUse.length > 0) console.log(`  ⚠️ 必须归入: ${mustUse.join(' / ')}`);
  console.log(`批大小 ${MAX_BATCH_SIZE}\n`);

  const settings = { ...DEFAULT_SETTINGS, apiKey: KEY };
  const started = Date.now();

  const outcome = await classifyBookmarks(
    items.map((b, i) => ({ id: String(i), title: b.title, url: b.url })),
    initialPaths,
    settings,
    {
      batchSize: MAX_BATCH_SIZE,
      maxDepth: 3,
      mustUsePaths: mustUse,
      onProgress: (done, total) => console.log(`  … ${done}/${total}`),
    },
  );

  console.log(`\n耗时 ${((Date.now() - started) / 1000).toFixed(1)}s，usedAi=${outcome.usedAi}`);
  if (outcome.detail) console.log(`detail: ${outcome.detail}`);

  const byPath = new Map<string, string[]>();
  for (const [id, path] of outcome.assignments) {
    byPath.set(path, [...(byPath.get(path) ?? []), id]);
  }

  console.log(`\n--- 产出目录（${byPath.size} 个）---`);
  for (const [path, ids] of [...byPath.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const created = outcome.createdPaths.includes(path) ? ' [新建]' : '';
    console.log(`\n  ${path}${created}  (${ids.length} 条)`);
    for (const id of ids.slice(0, 8)) {
      console.log(`      ${items[Number(id)].title.slice(0, 50)}`);
    }
    if (ids.length > 8) console.log(`      …还有 ${ids.length - 8} 条`);
  }

  const unassigned = items.length - outcome.assignments.size;
  console.log(`\n合计 ${outcome.assignments.size} / ${items.length} 条，未归类 ${unassigned}`);
  return 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
