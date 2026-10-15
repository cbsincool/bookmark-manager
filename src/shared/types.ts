export interface BookmarkNode {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly path: string;
  readonly dateAdded?: number;
}

export interface VectorEntry {
  readonly id: string;
  readonly vector: Float32Array;
  readonly text: string;
  readonly updatedAt: number;
}

export interface DirectoryVector {
  readonly id: string;
  readonly vector: Float32Array;
  readonly name: string;
  readonly childCount: number;
}

export interface BookmarkCache {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly path: string;
  readonly summary?: string;
  readonly domainScore?: number;
}

/** 命中方式：标题字面匹配 > 模糊匹配 > 仅语义相关 */
export type SearchMatchTier = 'title' | 'fuzzy' | 'semantic';

export interface SearchResult {
  readonly bookmark: BookmarkNode;
  readonly fuzzyScore: number;
  readonly semanticScore: number;
  readonly rerankScore: number;
  readonly hybridScore: number;
  /** 该结果属于哪一层命中，决定它在结果页的归区 */
  readonly tier: SearchMatchTier;
  /** 标题字面匹配得分（0 表示标题未命中），用于同层内排序 */
  readonly titleMatchScore: number;
}

export interface SearchResultGroup {
  readonly representative: SearchResult;
  readonly similar: readonly SearchResult[];
  readonly isExpanded: boolean;
}

/** 按命中方式分组的一节结果；语义相关节默认折叠，避免干扰定位 */
export interface SearchSection {
  readonly tier: SearchMatchTier;
  readonly groups: readonly SearchResultGroup[];
  readonly isExpanded: boolean;
}

export interface DedupGroup {
  readonly id: string;
  readonly scenario: 'exact-url' | 'same-title' | 'manual';
  readonly items: readonly DedupItem[];
  readonly recommendedKeepId: string;
}

export interface DedupItem {
  readonly bookmark: BookmarkNode;
  readonly scores: QualityScores;
  readonly totalScore: number;
}

/** 去重评分三维：URL 表层 / 内容质量 / 元数据。各管一件事，互不重叠 */
export interface QualityScores {
  readonly l1: number;
  readonly l2: number;
  readonly l3: number;
}

export interface DomainCluster {
  readonly domain: string;
  readonly count: number;
  readonly bookmarkIds: readonly string[];
  readonly suggestedFolderName: string;
  readonly selected: boolean;
  /** 该域名下是否含「官网门户」页（根域名页 / index 页），供 UI 提示 */
  readonly hasPortal: boolean;
}

/**
 * 整理模式。
 * - `fit`（默认）：骨架取自现有目录结构。归得对的书签移动是空操作，归错的才会被移走，
 *   所以可以反复整理而不会来回搬动。
 * - `replan`：每次重新聚类生成目录骨架，会重构目录结构——推倒重来的场景。
 */
export type OrganizeMode = 'fit' | 'replan';

/** 整理结果统计，供预览页展示归位质量 */
export interface OrganizeStats {
  readonly total: number;
  readonly skeletonCount: number;
  readonly assigned: number;
  readonly overflow: number;
  readonly overflowDirectories: number;
  readonly unassigned: number;
  readonly acceptThreshold: number;
  readonly warning?:
    | 'threshold-too-high'
    | 'vector-dim-mismatch'
    | 'ai-unavailable'
    | 'ai-naming-failed'
    /** fit 模式下没有任何书签需要换位置——现有结构已经是这个样子 */
    | 'nothing-to-do';
  /** 告警的具体原因（例如 AI 调用的原始错误），用于排查——后台日志在扩展里看不见 */
  readonly warningDetail?: string;
}

export interface OrganizeProposal {
  readonly directoryTree: Record<string, readonly string[]>;
  readonly lowCohesionPaths: readonly string[];
  /** 骨架目录路径，供 UI 与溢出目录做视觉区分 */
  readonly skeletonPaths?: readonly string[];
  /** 由溢出书签新建的目录路径 */
  readonly overflowPaths?: readonly string[];
  /** 本次一起整理的「同级同义目录」名字（文件夹范围整理时才会有） */
  readonly mergedFolderNames?: readonly string[];
  readonly stats?: OrganizeStats;
}

export interface AppSettings {
  readonly apiEndpoint: string;
  readonly apiKey: string;
  readonly apiModel: string;
  readonly apiFormat: 'openai' | 'anthropic';
  readonly searchFuzzyWeight: number;
  readonly searchSemanticWeight: number;
  readonly collapseThreshold: number;
  readonly realtimeArchiving: boolean;
  readonly onlyUseExistingDirectories: boolean;
  readonly organizeMaxDepth: 1 | 2 | 3;
  readonly domainClusterMinCount: number;
  readonly urlNormStripUtm: boolean;
  readonly urlNormStripTrailingSlash: boolean;
  readonly urlNormStripHash: boolean;
  readonly language: 'en' | 'zh';
  readonly topLevelCategories: readonly string[];
}

// 页面摘要缓存（精细去重用）
export interface PageSummary {
  readonly id: string;
  readonly summary: string;
  readonly fetchedAt: number;
}

// 统一进度信息类型
export interface AsyncTaskProgress {
  readonly current: number;
  readonly total: number;
  readonly message: string;
}

export interface AsyncTask {
  readonly id: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed';
  readonly progress?: AsyncTaskProgress;
  readonly result?: unknown;
  readonly error?: string;
}

// 精细去重 AI 分析结果
export interface FineDedupResult {
  readonly recommendedKeepId: string;
  readonly reason: string;
  readonly groups: readonly {
    readonly bookmarkIds: readonly string[];
    readonly keepId: string;
    readonly reason: string;
  }[];
}
