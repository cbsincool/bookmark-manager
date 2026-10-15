import { useCallback, useRef } from 'react';
import Fuse from 'fuse.js';
import { useSearchStore } from '../stores/searchStore';
import type {
  BookmarkNode,
  SearchMatchTier,
  SearchResult,
  SearchResultGroup,
  SearchSection,
} from '@/shared/types';

/** 结果页的分区顺序：标题命中 → 模糊命中 → 仅语义相关 */
const TIER_ORDER: readonly SearchMatchTier[] = ['title', 'fuzzy', 'semantic'];

/** 模糊命中低于此分视为噪声 */
const FUZZY_MIN_SCORE = 0.2;

/**
 * 语义相关区的准入门槛按「本次查询的分数分布」相对确定，而不是固定阈值。
 *
 * 原因：bge-m3 的绝对余弦会随语言与领域漂移——中文查询对中文标题的相关项在 0.6+，
 * 而对英文标题（跨语言）只有 0.47 左右，不相关项则在 0.43~0.50。固定阈值在跨语言
 * 场景下会把真正相关的项一起滤掉。
 *
 * 规则：保留分数 >= max(下限, 本次最高分 - 容差) 的项。
 */
const SEMANTIC_SCORE_FLOOR = 0.45;
const SEMANTIC_SCORE_MARGIN = 0.12;
/** 语义区最多展示条数——它是折叠的补充区，不需要长尾 */
const SEMANTIC_MAX_ITEMS = 5;

/** 每区最多展示多少条（定位场景不需要长尾） */
const MAX_PER_TIER = 30;

export function useSearch() {
  const { setSections, setLoading } = useSearchStore();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const search = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSections([]);
      return;
    }

    setLoading(true);

    try {
      const resp = await chrome.runtime.sendMessage({ type: 'SEARCH', query: trimmed });
      if (!resp?.success) {
        setSections([]);
        return;
      }

      const { bookmarks, semanticScores, settings } = resp.data as {
        bookmarks: BookmarkNode[];
        semanticScores: { id: string; semanticScore: number; rerankScore: number }[];
        settings: { fuzzyWeight: number; semanticWeight: number; collapseThreshold: number };
      };

      // 路径命中仍保留（需求要求支持按文件夹路径搜索），但权重最低，
      // 以免标题命中被同分级的路径命中淹没。
      const fuse = new Fuse(bookmarks, {
        keys: [
          { name: 'title', weight: 0.6 },
          { name: 'url', weight: 0.25 },
          { name: 'path', weight: 0.15 },
        ],
        threshold: 0.25,
        includeScore: true,
      });
      const fuzzyMap = new Map<string, number>();
      for (const r of fuse.search(trimmed)) {
        fuzzyMap.set(r.item.id, 1 - (r.score ?? 1));
      }

      const semanticMap = new Map<string, number>();
      const rerankMap = new Map<string, number>();
      for (const s of semanticScores) {
        semanticMap.set(s.id, Math.max(0, s.semanticScore));
        rerankMap.set(s.id, s.rerankScore ?? 0);
      }

      const allIds = new Set([...fuzzyMap.keys(), ...semanticMap.keys()]);
      const bookmarkMap = new Map(bookmarks.map((b) => [b.id, b]));

      const candidates: SearchResult[] = [];
      for (const id of allIds) {
        const bm = bookmarkMap.get(id);
        if (!bm) continue;

        const fuzzyScore = fuzzyMap.get(id) ?? 0;
        const semanticScore = semanticMap.get(id) ?? 0;
        const rerankScore = rerankMap.get(id) ?? 0;

        // rerank 是最干净的判别信号（相关 0.7~0.85 / 不相关 0.00x），
        // 用它加权后再参与排序；但它只覆盖 top-N，且跨语言时整体偏低，
        // 所以不能拿它当绝对门槛（见下方语义区准入）。
        const effectiveSemanticScore = rerankScore > 0
          ? semanticScore * 0.4 + rerankScore * 0.6
          : semanticScore;

        const hybridScore =
          fuzzyScore * settings.fuzzyWeight + effectiveSemanticScore * settings.semanticWeight;

        const titleMatchScore = literalMatchScore(bm.title, bm.url, trimmed);
        const tier: SearchMatchTier =
          titleMatchScore > 0 ? 'title'
          : fuzzyScore >= FUZZY_MIN_SCORE ? 'fuzzy'
          : 'semantic';

        candidates.push({
          bookmark: bm,
          fuzzyScore,
          semanticScore,
          rerankScore,
          hybridScore,
          tier,
          titleMatchScore,
        });
      }

      const topSemanticScore = candidates.reduce(
        (max, r) => (r.tier === 'semantic' ? Math.max(max, r.semanticScore) : max),
        0,
      );
      const semanticGate = Math.max(
        SEMANTIC_SCORE_FLOOR,
        topSemanticScore - SEMANTIC_SCORE_MARGIN,
      );

      const results = candidates.filter(
        (r) => r.tier !== 'semantic' || r.semanticScore >= semanticGate,
      );

      results.sort((a, b) => {
        const tierDiff = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
        if (tierDiff !== 0) return tierDiff;
        if (a.tier === 'title') {
          // 命中越靠前、标题越短，越可能是用户要找的那一条
          return b.titleMatchScore - a.titleMatchScore
            || a.bookmark.title.length - b.bookmark.title.length;
        }
        return b.hybridScore - a.hybridScore;
      });

      const built = TIER_ORDER
        .map((tier) => {
          const cap = tier === 'semantic' ? SEMANTIC_MAX_ITEMS : MAX_PER_TIER;
          const items = results.filter((r) => r.tier === tier).slice(0, cap);
          return { tier, groups: buildSearchGroups(items, settings.collapseThreshold) };
        })
        .filter((section) => section.groups.length > 0);

      // 语义区默认折叠以免干扰定位；但如果本次查询只有语义命中（标题/模糊都为空），
      // 再折叠就等于给用户看一片空白，此时展开。
      const hasHigherTier = built.some((s) => s.tier !== 'semantic');
      const sections: SearchSection[] = built.map((section) => ({
        ...section,
        isExpanded: section.tier !== 'semantic' || !hasHigherTier,
      }));

      setSections(sections);
    } catch (err) {
      console.error('Search failed:', err);
      setSections([]);
    } finally {
      setLoading(false);
    }
  }, [setSections, setLoading]);

  const debouncedSearch = useCallback((query: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(query), 200);
  }, [search]);

  return { search: debouncedSearch };
}

/**
 * 字面匹配得分。标题命中优先于 URL 命中——用户要的是「标题里含关键字」的定位效果，
 * 而 URL 命中（如按域名找）同样精确，故并入同一层但排序靠后。
 */
function literalMatchScore(title: string, url: string, query: string): number {
  const q = query.toLowerCase();
  const t = title.toLowerCase();

  if (t === q) return 1;
  if (t.startsWith(q)) return 0.9;
  if (t.includes(q)) return 0.8;
  if (url.toLowerCase().includes(q)) return 0.6;
  return 0;
}

function buildSearchGroups(
  results: readonly SearchResult[],
  threshold: number,
): SearchResultGroup[] {
  const groups: SearchResultGroup[] = [];
  const used = new Set<number>();

  for (let i = 0; i < results.length; i++) {
    if (used.has(i)) continue;
    const similar: SearchResult[] = [];
    used.add(i);

    for (let j = i + 1; j < results.length; j++) {
      if (used.has(j)) continue;
      const titleA = results[i].bookmark.title.toLowerCase();
      const titleB = results[j].bookmark.title.toLowerCase();
      const overlap = titleSimilarity(titleA, titleB);
      if (overlap >= threshold) {
        similar.push(results[j]);
        used.add(j);
      }
    }

    groups.push({
      representative: results[i],
      similar,
      isExpanded: false,
    });
  }

  return groups;
}

function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}
