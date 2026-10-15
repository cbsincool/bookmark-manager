export const DB_NAME = 'bookmark-manager';
export const DB_VERSION = 3;

export const STORES = {
  VECTORS: 'vectors',
  BOOKMARK_CACHE: 'bookmarkCache',
  DIRECTORY_VECTORS: 'directoryVectors',
  SETTINGS: 'settings',
  DELETED_BOOKMARKS: 'deletedBookmarks',
  CLASSIFIED_BOOKMARKS: 'classifiedBookmarks',
  PAGE_SUMMARIES: 'pageSummaries',
} as const;

// 向量嵌入服务（tei-bge-m3）
// 注意：model-server 于 2026-04 重部署，旧端口 9080-9084 已全部失效
export const EMBEDDING_API_URL = 'http://10.3.28.194:8080';
export const EMBEDDING_DIM = 1024; // bge-m3 输出维度

// 重排序服务（tei-bge-reranker）
export const RERANKER_API_URL = 'http://10.3.28.194:8081';

// 已下线的 LLM 端点。a800 网关自 2026-08-25 起整体 403，历史配置若仍指向它，
// 读取设置时会自动迁移到 DEFAULT_SETTINGS 的端点，否则 AI 功能会静默失效。
export const DEPRECATED_API_ENDPOINTS: readonly string[] = [
  'https://api-ai.haplat.net/a800',
];

// 已下架的模型名。deepseek-v4-flash-0731 于 2026-10 被 inside 网关下架，
// 请求直接返回 400「模型已下架，请使用替代模型 deepseek-v4.1-flash」。
// 只迁移 endpoint 盖不住这种情况——老用户存着旧模型名会一直 400。
export const DEPRECATED_API_MODELS: readonly string[] = [
  'deepseek-v4-flash-0731',
];

export const BATCH_SIZE = 50;
export const API_BATCH_SIZE = 30;

// tei-bge-m3 的 max_client_batch_size（见 GET /info）。单次请求超过这个数量
// 服务端直接返回 422 "batch size N > maximum allowed batch size 32"，
// 所以分片必须发生在 embeddingClient 内部，调用方不应自行拼接大批量。
export const EMBEDDING_MAX_BATCH = 32;
export const CONNECTIVITY_CONCURRENCY = 5;
export const CONNECTIVITY_TIMEOUT_MS = 15000;

// --- 整理流程（骨架 → 归位 → 溢出）---

/** 书签数低于此值时骨架只取 1 个簇，避免小样本被最小簇长过滤后全军覆没 */
export const SKELETON_SMALL_N = 8;
/** 骨架聚类的最小簇长（语义聚类入口仍用 3） */
export const MIN_SKELETON_CLUSTER_SIZE = 1;
/** 书签向量与骨架目录中心的余弦达到此值才归位，否则进入溢出池 */
export const ASSIGN_ACCEPT_THRESHOLD = 0.55;
/** 溢出比例超过此值说明阈值与数据不匹配，降级为「全部接受最近邻」 */
export const OVERFLOW_ACCEPT_RATIO = 0.6;
/** 溢出二次聚类的凝聚度下限，低于此值的簇是硬凑，解散为碎片 */
export const OVERFLOW_COHESION_MIN = 0.45;
/** 碎片池不足此规模时不建目录，直接并入「未分类」 */
export const MIN_FRAGMENT_FOR_DIR = 3;
/** 碎片池按域名兜底成组时，同域名的最小出现次数 */
export const DOMAIN_FALLBACK_MIN = 3;
/** 溢出阶段新建目录的硬上限 */
export const MAX_NEW_DIRS_CAP = 8;

/** 溢出新建目录的数量上限：溢出条目越多允许建越多，但有硬顶 */
export function maxNewDirectories(overflowCount: number): number {
  return Math.min(MAX_NEW_DIRS_CAP, Math.max(1, Math.ceil(overflowCount / 5)));
}

export const DEFAULT_SETTINGS: import('./types').AppSettings = {
  // LLM 网关（OpenAI 兼容）。默认指向 inside 网关的 deepseek flash；
  // 端点为死值时 AI 功能（分类命名/精细去重/实时归档兜底）会整体不可用，
  // 用户可在设置页改成任意 OpenAI 或 Anthropic 兼容端点。
  apiEndpoint: 'https://ai-gateway-inside.haplat.net/devops/v1',
  apiKey: '',
  apiModel: 'deepseek-v4.1-flash',
  apiFormat: 'openai',
  searchFuzzyWeight: 0.4,
  searchSemanticWeight: 0.6,
  collapseThreshold: 0.85,
  realtimeArchiving: true,
  onlyUseExistingDirectories: false,
  organizeMaxDepth: 3,
  domainClusterMinCount: 3,
  urlNormStripUtm: true,
  urlNormStripTrailingSlash: true,
  urlNormStripHash: true,
  language: 'en',
  topLevelCategories: ['技术文档', '兴趣爱好', '工作相关', '学习资料', '生活实用', '其他'],
};

// L1 评分用知名域名列表
export const WELL_KNOWN_DOMAINS = [
  'github.com', 'stackoverflow.com', 'developer.mozilla.org',
  'docs.python.org', 'docs.microsoft.com', 'learn.microsoft.com',
  'react.dev', 'vuejs.org', 'angular.io', 'nodejs.org',
  'npmjs.com', 'pypi.org', 'crates.io',
  'medium.com', 'dev.to', 'css-tricks.com',
  'wikipedia.org', 'arxiv.org',
] as const;

// 目录名中的通用/描述性词。这类词只是修饰，不承载主题信息，
// 生成目录名时剥离（"Machine Learning Tutorial" → "MachineLearning"）。
// 注意：只在词被空白分隔时才会被识别，中文目录名（"文档备份"）不受影响。
export const GENERIC_NAME_WORDS = [
  'guide', 'guides', 'tutorial', 'tutorials', 'intro', 'introduction',
  'advanced', 'basic', 'basics', 'awesome', 'complete', 'ultimate',
  'collection', 'collections', 'resources', 'notes', 'note',
  'docs', 'doc', 'documentation', 'reference', 'manual', 'handbook',
  '教程', '入门', '指南', '笔记', '资料', '合集', '大全', '汇总', '手册',
] as const;

// 低信息量标题（无意义标题，不包含首页类）
export const LOW_INFO_TITLES = [
  'untitled', 'document', 'page', 'welcome',
  'login', 'sign in', 'register',
  'click here', 'read more', 'learn more',
  '无标题', '文档', '欢迎',
  '登录', '注册',
  '新标签页', 'new tab',
] as const;
