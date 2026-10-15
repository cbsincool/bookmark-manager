export type MessageRequest =
  | { type: 'GENERATE_EMBEDDING'; text: string }
  | { type: 'GENERATE_EMBEDDINGS_BATCH'; texts: readonly string[] }
  | { type: 'SEARCH'; query: string }
  | { type: 'GET_ALL_BOOKMARKS' }
  | { type: 'DEDUP_SCAN'; scope?: { folderIds?: readonly string[] } }
  | { type: 'DEDUP_EXECUTE'; keepIds: readonly string[]; deleteIds: readonly string[] }
  | { type: 'DEDUP_MANUAL_FORCE'; bookmarkIds: readonly string[] }
  | { type: 'DEDUP_UNDO'; deletedIds: readonly string[] }
  | { type: 'FETCH_PAGE_SUMMARY'; bookmarkId: string; url: string }
  | { type: 'FINE_DEDUP_ANALYZE'; bookmarkIds: readonly string[] }
  | { type: 'ORGANIZE_DOMAIN_CLUSTER' }
  | { type: 'ORGANIZE_SEMANTIC_CLUSTER'; bookmarkIds: readonly string[] }
  | { type: 'ORGANIZE_CONNECTIVITY_CHECK'; bookmarkIds: readonly string[] }
  | { type: 'ORGANIZE_AI_CLASSIFY_START'; bookmarkIds: readonly string[]; scope: 'global' | 'folder'; folderId?: string; categories?: readonly string[]; mode?: import('./types').OrganizeMode }
  | { type: 'ORGANIZE_AI_CLASSIFY_POLL'; taskId: string }
  | { type: 'ORGANIZE_EXECUTE'; directoryTree: Record<string, readonly string[]>; rootId: string }
  | { type: 'ORGANIZE_RECLASSIFY'; sourceFolders: readonly string[]; targetCategory: string }
  | { type: 'GET_FOLDER_STRUCTURE' }
  | { type: 'GET_SETTINGS' }
  | { type: 'UPDATE_SETTINGS'; settings: Partial<import('./types').AppSettings> }
  | { type: 'TEST_AI_CONNECTION' }
  | { type: 'REBUILD_INDEX' }
  | { type: 'GET_INDEX_STATS' }
  | { type: 'PING' };

export type MessageResponse =
  | { success: true; data: unknown }
  | { success: false; error: string };

export interface AsyncTaskProgress {
  current: number;
  total: number;
  message: string;
}

export interface AsyncTask {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress?: AsyncTaskProgress;
  result?: unknown;
  error?: string;
}

export type ProgressMessage =
  | { type: 'REBUILD_INDEX_PROGRESS'; current: number; total: number; message: string }
  | { type: 'DEDUP_SCAN_PROGRESS'; current: number; total: number; message: string }
  | { type: 'CONNECTIVITY_CHECK_PROGRESS'; current: number; total: number; message: string }
  | { type: 'FINE_DEDUP_PROGRESS'; step: 'fetching' | 'analyzing'; current: number; total: number; message: string };
