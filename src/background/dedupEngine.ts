import type { BookmarkNode, DedupGroup, DedupItem, QualityScores } from '@/shared/types';
import { normalizeUrl, type NormalizeOptions } from '@/shared/urlUtils';
import {
  WELL_KNOWN_DOMAINS,
  LOW_INFO_TITLES,
  NEUTRAL_SCORE,
  SHORT_SUMMARY_LENGTH,
  RICH_SUMMARY_LENGTH,
} from '@/shared/constants';

/** 三维权重 */
export interface DedupWeights {
  readonly l1: number;
  readonly l2: number;
  readonly l3: number;
}

const NEUTRAL_SCORES: QualityScores = {
  l1: NEUTRAL_SCORE,
  l2: NEUTRAL_SCORE,
  l3: NEUTRAL_SCORE,
};

function weightedScore(scores: QualityScores, weights: DedupWeights): number {
  return scores.l1 * weights.l1 + scores.l2 * weights.l2 + scores.l3 * weights.l3;
}

export function findExactUrlDuplicates(
  bookmarks: readonly BookmarkNode[],
  normOpts: NormalizeOptions,
): { items: BookmarkNode[] }[] {
  const urlMap = new Map<string, BookmarkNode[]>();

  for (const bm of bookmarks) {
    const normalized = normalizeUrl(bm.url, normOpts);
    const existing = urlMap.get(normalized);
    if (existing) {
      existing.push(bm);
    } else {
      urlMap.set(normalized, [bm]);
    }
  }

  return Array.from(urlMap.values())
    .filter((group) => group.length > 1)
    .map((items) => ({ items }));
}

export function findSameTitleDuplicates(
  bookmarks: readonly BookmarkNode[],
): { title: string; items: BookmarkNode[] }[] {
  const titleMap = new Map<string, BookmarkNode[]>();

  for (const bm of bookmarks) {
    const key = bm.title.trim().toLowerCase();
    if (!key) continue;
    const existing = titleMap.get(key);
    if (existing) {
      existing.push(bm);
    } else {
      titleMap.set(key, [bm]);
    }
  }

  return Array.from(titleMap.entries())
    .filter(([_, items]) => {
      if (items.length < 2) return false;
      const urls = new Set(items.map((i) => i.url));
      return urls.size > 1; // same title, different URLs
    })
    .map(([_, items]) => ({ title: items[0].title, items }));
}

export function scoreL1(url: string): number {
  let score = 50; // base

  // HTTPS bonus
  if (url.startsWith('https://')) score += 20;

  // Well-known domain bonus
  try {
    const hostname = new URL(url).hostname;
    const isKnown = WELL_KNOWN_DOMAINS.some(
      (d) => hostname === d || hostname.endsWith(`.${d}`),
    );
    if (isKnown) score += 15;
  } catch {
    // invalid URL, no bonus
  }

  // Semantic URL path (contains words, not just IDs)
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  const hasWords = /[a-zA-Z]{3,}/.test(path);
  const isPureId = /^\/[a-f0-9-]+\/?$/.test(path) || /^\/\d+\/?$/.test(path);
  if (hasWords && !isPureId) score += 10;

  // Excessive query params penalty
  const paramCount = (url.match(/[&?]/g) || []).length;
  if (paramCount > 3) score -= 10;

  // Long URL penalty
  if (url.length > 200) score -= 20;

  return Math.max(0, Math.min(100, score));
}

/**
 * L2: 内容质量分 —— 用**已缓存**的页面摘要判断这条书签指向的页面有没有实质内容。
 *
 * 刻意不发网络请求：一次全库扫描可能涉及上千条书签，逐条抓取会让去重变得不可用。
 * 摘要在「精细去重」时被抓取并缓存，所以这里的数据会随着使用逐步积累——
 * 跑过一次精细去重之后，自动推荐保留哪一条会明显更准；没跑过则一律中性分，
 * 不奖不罚，退化成 L1+L3 两维。
 *
 * 这一维和精细去重里的 AI 重叠度分析不重复：那个判断「哪两条讲的是同一件事」，
 * 这个只判断「这一条的页面里到底有没有东西」。
 */
export function scoreL2Content(summary: string | undefined): number {
  if (summary === undefined) return NEUTRAL_SCORE; // 没有缓存

  const text = summary.trim();
  if (text.length === 0) return 20; // 抓过但拿不到内容：登录墙 / 空壳页
  if (text.length < SHORT_SUMMARY_LENGTH) return 40;
  if (text.length < RICH_SUMMARY_LENGTH) return 60;
  return 75;
}

/**
 * L3: Bookmark metadata quality score (local, no network/API needed).
 * - Title informativeness: penalizes meaningless titles
 * - Recency: newer bookmarks score higher
 */
export function scoreL3(bookmark: BookmarkNode): number {
  let score = 50;

  // Title informativeness
  const titleLower = bookmark.title.trim().toLowerCase();
  const isLowInfo = (LOW_INFO_TITLES as readonly string[]).some(
    (t) => titleLower === t || titleLower.startsWith(t + ' ') || titleLower.endsWith(' ' + t),
  );
  if (isLowInfo) score -= 30;
  if (!bookmark.title.trim()) score -= 40;

  // Recency: full score if bookmarked within last 90 days, decays to 0 over 2 years
  if (bookmark.dateAdded) {
    const ageMs = Date.now() - bookmark.dateAdded;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays <= 90) {
      score += 20;
    } else if (ageDays <= 730) {
      score += Math.round(20 * (1 - (ageDays - 90) / 640));
    }
  }

  return Math.max(0, Math.min(100, score));
}

export function buildDedupGroups(
  exactUrlGroups: { items: BookmarkNode[] }[],
  sameTitleGroups: { title: string; items: BookmarkNode[] }[],
  scores: Map<string, QualityScores>,
  weights: DedupWeights,
): DedupGroup[] {
  const groups: DedupGroup[] = [];

  for (const group of exactUrlGroups) {
    const items: DedupItem[] = group.items.map((bm) => {
      const s = scores.get(bm.id) ?? NEUTRAL_SCORES;
      return {
        bookmark: bm,
        scores: s,
        totalScore: weightedScore(s, weights),
      };
    });
    items.sort((a, b) => b.totalScore - a.totalScore);
    groups.push({
      id: `url-${group.items[0].id}`,
      scenario: 'exact-url',
      items,
      recommendedKeepId: items[0].bookmark.id,
    });
  }

  for (const group of sameTitleGroups) {
    const items: DedupItem[] = group.items.map((bm) => {
      const s = scores.get(bm.id) ?? NEUTRAL_SCORES;
      return {
        bookmark: bm,
        scores: s,
        totalScore: weightedScore(s, weights),
      };
    });
    items.sort((a, b) => b.totalScore - a.totalScore);
    groups.push({
      id: `title-${group.items[0].id}`,
      scenario: 'same-title',
      items,
      recommendedKeepId: items[0].bookmark.id,
    });
  }

  return groups;
}
