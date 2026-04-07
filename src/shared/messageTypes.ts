export type MessageRequest =
  | { type: 'GENERATE_EMBEDDING'; text: string }
  | { type: 'GENERATE_EMBEDDINGS_BATCH'; texts: readonly string[] }
  | { type: 'SEARCH'; query: string }
  | { type: 'GET_ALL_BOOKMARKS' }
  | { type: 'DEDUP_SCAN' }
  | { type: 'DEDUP_EXECUTE'; keepIds: readonly string[]; deleteIds: readonly string[] }
  | { type: 'ORGANIZE_DOMAIN_CLUSTER' }
  | { type: 'ORGANIZE_CONNECTIVITY_CHECK'; bookmarkIds: readonly string[] }
  | { type: 'ORGANIZE_AI_CLASSIFY'; bookmarks: readonly { id: string; title: string; url: string; path: string; summary?: string }[] }
  | { type: 'ORGANIZE_EXECUTE'; moves: readonly { bookmarkId: string; targetFolderId: string }[] }
  | { type: 'FETCH_PAGE_SUMMARY'; url: string }
  | { type: 'SCORE_QUALITY_L2'; url: string }
  | { type: 'SCORE_QUALITY_L3'; items: readonly { title: string; url: string; summary?: string }[] }
  | { type: 'GET_SETTINGS' }
  | { type: 'UPDATE_SETTINGS'; settings: Partial<import('./types').AppSettings> }
  | { type: 'REBUILD_INDEX' }
  | { type: 'GET_INDEX_STATS' }
  | { type: 'PING' };

export type MessageResponse =
  | { success: true; data: unknown }
  | { success: false; error: string };
