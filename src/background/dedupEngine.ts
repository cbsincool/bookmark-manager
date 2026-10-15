import type { BookmarkNode, DedupGroup, DedupItem, QualityScores } from '@/shared/types';
import { normalizeUrl, type NormalizeOptions } from '@/shared/urlUtils';
import { WELL_KNOWN_DOMAINS, LOW_INFO_TITLES } from '@/shared/constants';

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
 * L2: Structure density score - evaluates URL structure quality without network requests.
 * Focuses on content indicators from URL structure:
 * - Path depth and semantic meaningfulness
 * - Document/article indicators vs generic pages
 * - Content-rich URL patterns
 */
export function scoreL2(url: string): number {
  let score = 50; // base

  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const hostname = parsed.hostname;

    // Path depth - deeper paths often indicate specific content
    const pathSegments = pathname.split('/').filter((s) => s.length > 0);
    if (pathSegments.length >= 2 && pathSegments.length <= 4) {
      score += 10; // Good depth for content pages
    } else if (pathSegments.length > 4) {
      score -= 5; // Too deep, might be nested navigation
    }

    // Document/content indicators in path
    const docPatterns = [
      /\/docs?\//i, /\/guide/i, /\/tutorial/i, /\/learn\//i,
      /\/api\//i, /\/reference\//i, /\/manual\//i,
      /\/blog\//i, /\/article\//i, /\/post\//i,
      /\/wiki\//i, /\/book\//i, /\/course\//i,
    ];
    if (docPatterns.some((p) => p.test(pathname))) {
      score += 15;
    }

    // Generic/homepage indicators - lower score
    const genericPatterns = [
      /^\/$/, /^\/(index|home|main|default)\.?(html|php|asp)?$/i,
      /^\/(category|tag|archive|search)$/i,
    ];
    if (genericPatterns.some((p) => p.test(pathname))) {
      score -= 20;
    }

    // File extension - specific formats often indicate documents
    if (/\.(pdf|md|txt|html|htm)$/i.test(pathname)) {
      score += 10;
    }

    // Query string with meaningful content indicators
    const searchParams = parsed.searchParams;
    const hasContentParam = searchParams.has('id') || searchParams.has('page') ||
                           searchParams.has('article') || searchParams.has('post');
    if (hasContentParam && pathSegments.length === 0) {
      score += 5; // Content via query params is OK but not ideal
    }

    // Subdomain indicating specific content area
    const subdomain = hostname.split('.')[0];
    const contentSubdomains = ['docs', 'doc', 'guide', 'learn', 'api', 'dev', 'blog', 'help', 'support', 'wiki'];
    if (contentSubdomains.includes(subdomain.toLowerCase())) {
      score += 10;
    }

  } catch {
    // Invalid URL
    score -= 10;
  }

  return Math.max(0, Math.min(100, score));
}

/** Run scoreL2 for multiple URLs (synchronous since no network requests). */
export function scoreL2Batch(urls: string[]): number[] {
  return urls.map((url) => scoreL2(url));
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
  l1Weight: number,
  l3Weight: number,
): DedupGroup[] {
  const groups: DedupGroup[] = [];

  for (const group of exactUrlGroups) {
    const items: DedupItem[] = group.items.map((bm) => {
      const s = scores.get(bm.id) ?? { l1: 50, l3: 50 };
      return {
        bookmark: bm,
        scores: s,
        totalScore: s.l1 * l1Weight + s.l3 * l3Weight,
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
      const s = scores.get(bm.id) ?? { l1: 50, l3: 50 };
      return {
        bookmark: bm,
        scores: s,
        totalScore: s.l1 * l1Weight + s.l3 * l3Weight,
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
