export const DB_NAME = 'bookmark-manager';
export const DB_VERSION = 1;

export const STORES = {
  VECTORS: 'vectors',
  BOOKMARK_CACHE: 'bookmarkCache',
  DIRECTORY_VECTORS: 'directoryVectors',
  SETTINGS: 'settings',
} as const;

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIM = 384;

export const BATCH_SIZE = 50;
export const API_BATCH_SIZE = 30;
export const CONNECTIVITY_CONCURRENCY = 5;
export const CONNECTIVITY_TIMEOUT_MS = 3000;

export const DEFAULT_SETTINGS: import('./types').AppSettings = {
  apiEndpoint: '',
  apiKey: '',
  apiModel: 'gpt-4o-mini',
  searchFuzzyWeight: 0.4,
  searchSemanticWeight: 0.6,
  collapseThreshold: 0.85,
  contentEnhancement: false,
  realtimeArchiving: true,
  domainClusterMinCount: 3,
  l3Enabled: true,
  urlNormStripUtm: true,
  urlNormStripTrailingSlash: true,
  urlNormStripHash: true,
  language: 'en',
};

export const WELL_KNOWN_DOMAINS = [
  'github.com', 'stackoverflow.com', 'developer.mozilla.org',
  'docs.python.org', 'docs.microsoft.com', 'learn.microsoft.com',
  'react.dev', 'vuejs.org', 'angular.io', 'nodejs.org',
  'npmjs.com', 'pypi.org', 'crates.io',
  'medium.com', 'dev.to', 'css-tricks.com',
  'wikipedia.org', 'arxiv.org',
] as const;

export const LOW_INFO_TITLES = [
  'home', 'index', 'untitled', 'document', 'page', 'welcome',
  '首页', '主页', '无标题', '文档',
] as const;
