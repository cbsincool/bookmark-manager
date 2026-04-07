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

export interface SearchResult {
  readonly bookmark: BookmarkNode;
  readonly fuzzyScore: number;
  readonly semanticScore: number;
  readonly hybridScore: number;
}

export interface SearchResultGroup {
  readonly representative: SearchResult;
  readonly similar: readonly SearchResult[];
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
}

export interface OrganizeProposal {
  readonly directoryTree: Record<string, readonly string[]>;
  readonly lowCohesionPaths: readonly string[];
}

export interface AppSettings {
  readonly apiEndpoint: string;
  readonly apiKey: string;
  readonly apiModel: string;
  readonly searchFuzzyWeight: number;
  readonly searchSemanticWeight: number;
  readonly collapseThreshold: number;
  readonly contentEnhancement: boolean;
  readonly realtimeArchiving: boolean;
  readonly domainClusterMinCount: number;
  readonly l3Enabled: boolean;
  readonly urlNormStripUtm: boolean;
  readonly urlNormStripTrailingSlash: boolean;
  readonly urlNormStripHash: boolean;
  readonly language: 'en' | 'zh';
}
