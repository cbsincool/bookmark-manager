import type { BookmarkNode, DedupGroup, DedupItem, QualityScores } from '@/shared/types';
import { normalizeUrl, type NormalizeOptions } from '@/shared/urlUtils';
import { WELL_KNOWN_DOMAINS } from '@/shared/constants';

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

export async function scoreL2(url: string): Promise<number> {
  let score = 50;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (response.ok) {
      score += 25;
      const contentLength = parseInt(response.headers.get('content-length') ?? '0', 10);
      if (contentLength > 5000) score += 10;
    } else if (response.status >= 400) {
      score -= 30;
    }
  } catch {
    score -= 20; // timeout or network error
  }

  return Math.max(0, Math.min(100, score));
}

export function buildDedupGroups(
  exactUrlGroups: { items: BookmarkNode[] }[],
  sameTitleGroups: { title: string; items: BookmarkNode[] }[],
  scores: Map<string, QualityScores>,
  l1Weight: number,
  l2Weight: number,
  l3Weight: number,
): DedupGroup[] {
  const groups: DedupGroup[] = [];

  for (const group of exactUrlGroups) {
    const items: DedupItem[] = group.items.map((bm) => {
      const s = scores.get(bm.id) ?? { l1: 50, l2: 50, l3: 50 };
      return {
        bookmark: bm,
        scores: s,
        totalScore: s.l1 * l1Weight + s.l2 * l2Weight + s.l3 * l3Weight,
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
      const s = scores.get(bm.id) ?? { l1: 50, l2: 50, l3: 50 };
      return {
        bookmark: bm,
        scores: s,
        totalScore: s.l1 * l1Weight + s.l2 * l2Weight + s.l3 * l3Weight,
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
