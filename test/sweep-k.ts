/**
 * 用用户真实书签扫一遍 k 值，看多少个簇才让每个簇内部是同一个主题。
 * 纯离线分析，不碰浏览器。
 *
 * 用法：npx tsx test/sweep-k.ts
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { generateEmbeddingsBatch } from '../src/background/embeddingClient';
import { buildSemanticClusters, computeDirectoryCohesion } from '../src/background/organizeEngine';
import type { BookmarkNode } from '../src/shared/types';

const HERE = dirname(fileURLToPath(import.meta.url));

interface RealBookmark {
  readonly title: string;
  readonly url: string;
  readonly path: string;
}

async function main(): Promise<void> {
  const items = JSON.parse(
    readFileSync(join(HERE, '_real-bookmarks.json'), 'utf8'),
  ) as RealBookmark[];

  const vectors = await generateEmbeddingsBatch(items.map((b) => `${b.title} ${b.url}`));
  const entries = items.map((b, i) => ({ id: String(i), vector: vectors[i] }));
  const bookmarks: BookmarkNode[] = items.map((b, i) => ({
    id: String(i), title: b.title, url: b.url, path: b.path,
  }));

  const n = entries.length;
  console.log(`真实书签 ${n} 条\n`);

  for (const k of [3, 5, 7, 10, 14]) {
    if (n < k) continue;
    const clusters = buildSemanticClusters(entries, bookmarks, k, { minClusterSize: 1 });
    const sizes = clusters.map((c) => c.bookmarkIds.length).sort((a, b) => b - a);
    const cohesion = clusters.map((c) =>
      computeDirectoryCohesion(c.bookmarkIds.map((id) => entries[Number(id)].vector)),
    );
    const avgCohesion = cohesion.reduce((a, b) => a + b, 0) / Math.max(cohesion.length, 1);

    console.log(`k=${k}: ${clusters.length} 个簇，大小 ${sizes.join('/')}，平均内聚度 ${avgCohesion.toFixed(3)}`);

    // 只打印最大的那个簇的成员，看它是不是混装
    const biggest = clusters.reduce((a, b) => (a.bookmarkIds.length > b.bookmarkIds.length ? a : b));
    console.log(`   最大簇（${biggest.bookmarkIds.length} 条）的成员:`);
    for (const id of biggest.bookmarkIds) {
      console.log(`     - ${items[Number(id)].title.slice(0, 52)}`);
    }
    console.log();
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
