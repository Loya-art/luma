export const SMART_CATEGORIES = ['人物', '风景', '动物', '美食', '截图', '文档', '证件'] as const;
export type SmartCategory = typeof SMART_CATEGORIES[number];
export type SearchMode = 'all' | 'text' | 'content';
export interface SearchRequest { query: string; mode?: SearchMode; ids?: string[]; category?: string; offset?: number; limit?: number }
export interface SearchHit { id: string; score: number; reason: string; snippet: string; matchedBy: 'filename' | 'tag' | 'text' | 'content' | 'category' }
export interface SearchResponse { hits: SearchHit[]; total: number; offset: number; limit: number; semanticReady: boolean; warning?: string }
export interface AnalysisJob { id: string; kind: 'local' | 'cloud'; status: 'queued' | 'running' | 'paused' | 'complete' | 'error'; done: number; total: number; errors: number; label: string; error?: string; createdAt: number }
export interface IntelligenceState {
  models: { status: 'missing' | 'installing' | 'ready' | 'error'; directory: string; message: string; error?: string };
  enabled: boolean;
  jobs: AnalysisJob[];
  indexed: number;
  pending: number;
  categories: Array<{ name: string; count: number }>;
}
export interface AnalysisDetail { id: string; status: 'missing' | 'ready' | 'stale'; text: string; tags: string[]; suppressedTags: string[]; description: string; cloudTags: string[]; updatedAt: number | null; modelVersion: string }
export interface ModelSetupOptions { directory?: string }
export interface CloudAnalysisRequest { ids: string[]; instruction?: string }
