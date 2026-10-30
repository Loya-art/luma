import type { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { SMART_CATEGORIES, type AnalysisDetail, type AnalysisJob, type IntelligenceState, type ModelSetupOptions, type SearchHit, type SearchRequest, type SearchResponse } from '../src/shared/intelligence';
import { ANALYSIS_VERSION, ManagedLocalEngine, type LocalAnalysis, type LocalEngine } from './ai-runtime';

type Row = Record<string, any>;
export interface AnalysisMedia { id: string; path: string; fileName: string; kind: string; mtimeMs: number; size: number; missing: boolean; tags: string[] }
export interface IntelligenceOptions {
  dataDir: string; db: DatabaseSync; resourceDir?: string; onChange?: () => void;
  getMedia: (ids?: string[]) => AnalysisMedia[]; getAnalysisImage: (id: string) => Promise<string>;
  /** Dependency injection is limited to tests; production uses real offline inference. */
  engine?: LocalEngine; cloudFetch?: typeof fetch;
}
interface StoredJob extends AnalysisJob { instruction?: string }
const textError = (error: unknown) => error instanceof Error ? error.message : String(error);
const parse = <T>(value: string | null | undefined, fallback: T): T => { try { return JSON.parse(value || ''); } catch { return fallback; } };
const unique = (ids: unknown): string[] => Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length < 500))] : [];
export const normalizeSearch = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, '');
const fingerprint = (media: AnalysisMedia) => `${media.mtimeMs}:${media.size}:${ANALYSIS_VERSION}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function textIndex(value: string): string {
  const normalized = normalizeSearch(value);
  const tokens = new Set<string>();
  const chars = Array.from(normalized);
  for (let i = 0; i + 1 < chars.length; i++) if (/^[\p{L}\p{N}]{2}$/u.test(chars[i] + chars[i + 1])) tokens.add(chars[i] + chars[i + 1]);
  return [...tokens].join(' ');
}
const finiteVector = (value: unknown): value is number[] => Array.isArray(value) && value.length === 512 && value.every(n => typeof n === 'number' && Number.isFinite(n));
const toBlob = (values: number[]) => Buffer.from(Float32Array.from(values).buffer);
function fromBlob(value: Uint8Array): Float32Array { const copy = Uint8Array.from(value); return new Float32Array(copy.buffer); }
function similarity(a: readonly number[], b: Float32Array) { if (a.length !== b.length) return -1; let score = 0; for (let i = 0; i < a.length; i++) score += a[i] * b[i]; return score; }

/** Durable image analysis, source-versioned results and search stay in the library worker.
 * SQLite FTS5 docs: https://www.sqlite.org/fts5.html
 */
export class IntelligenceService {
  private db: DatabaseSync;
  private engine: LocalEngine;
  private directory: string;
  private enabled = false;
  private models: IntelligenceState['models'];
  private closed = false;
  private setupTask: Promise<void> | null = null;
  private setupAbort: AbortController | null = null;
  private active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private vectors = new Map<string, { fingerprint: string; value: Float32Array }>();
  private queryVectors = new Map<string, number[]>();
  constructor(private options: IntelligenceOptions) {
    this.db = options.db;
    this.engine = options.engine ?? new ManagedLocalEngine(options.resourceDir ?? path.resolve('resources/ai'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_results(media_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,text TEXT NOT NULL DEFAULT '',text_norm TEXT NOT NULL DEFAULT '',tags TEXT NOT NULL DEFAULT '[]',vector BLOB,model_version TEXT NOT NULL,updated_at INTEGER NOT NULL,cloud_description TEXT NOT NULL DEFAULT '',cloud_tags TEXT NOT NULL DEFAULT '[]',cloud_key TEXT NOT NULL DEFAULT '',cloud_at INTEGER);
      CREATE TABLE IF NOT EXISTS ai_overrides(media_id TEXT NOT NULL,tag TEXT NOT NULL,present INTEGER NOT NULL,PRIMARY KEY(media_id,tag));
      CREATE TABLE IF NOT EXISTS ai_jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_job_items(job_id TEXT NOT NULL,media_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',error TEXT,PRIMARY KEY(job_id,media_id));
      CREATE VIRTUAL TABLE IF NOT EXISTS ai_fts USING fts5(media_id UNINDEXED,text_index,tokenize='unicode61');
    `);
    const stored = this.db.prepare('SELECT value FROM ai_config WHERE key=?').get('directory') as Row | undefined;
    this.directory = stored?.value || (process.platform === 'win32' && existsSync('E:\\') ? path.join('E:\\', '拾光模型') : path.join(options.dataDir, 'Models'));
    this.enabled = (this.db.prepare('SELECT value FROM ai_config WHERE key=?').get('enabled') as Row | undefined)?.value === '1';
    this.models = { status: 'missing', directory: this.directory, message: '启用后在电脑上识别文字和图片内容' };
  }
  private emit() { if (!this.closed) this.options.onChange?.(); }
  private config(key: string, value: string) { this.db.prepare('INSERT INTO ai_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  private jobs(): StoredJob[] { return (this.db.prepare('SELECT data FROM ai_jobs ORDER BY rowid DESC').all() as Row[]).map(row => parse<StoredJob>(row.data, null as any)).filter(Boolean); }
  private job(id: string) { const row = this.db.prepare('SELECT data FROM ai_jobs WHERE id=?').get(id) as Row | undefined; if (!row) throw new Error('识别任务不存在'); return parse<StoredJob>(row.data, null as any); }
  private save(job: StoredJob) { this.db.prepare('INSERT INTO ai_jobs(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.id, JSON.stringify(job)); this.emit(); }
  private result(id: string) { return this.db.prepare('SELECT * FROM ai_results WHERE media_id=?').get(id) as Row | undefined; }
  private currentRows(ids?: string[]) { return this.options.getMedia(ids); }
  async initialize() {
    if (await this.engine.ready(this.directory)) this.models = { status: 'ready', directory: this.directory, message: '本地模型已就绪，识别和搜索无需联网' };
    for (const job of this.jobs()) {
      if (job.status === 'running' || job.status === 'queued') { job.status = 'paused'; job.label = job.kind === 'cloud' ? '云端任务已暂停，点击继续后才会上传图片' : '上次识别已暂停，可继续处理剩余图片'; this.save(job); }
    }
    this.db.prepare("UPDATE ai_job_items SET status='pending' WHERE status='working'").run();
    for (const row of this.db.prepare('SELECT media_id,fingerprint,vector FROM ai_results WHERE vector IS NOT NULL').all() as Row[]) if (row.vector?.byteLength === 512 * 4) this.vectors.set(row.media_id, { fingerprint: row.fingerprint, value: fromBlob(row.vector) });
  }
  getState(): IntelligenceState {
    const media = this.currentRows().filter(item => item.kind === 'image' && !item.missing);
    const summaries = this.summaries();
    let indexed = 0;
    for (const item of media) if (this.vectors.get(item.id)?.fingerprint === fingerprint(item)) indexed++;
    return { models: { ...this.models }, enabled: this.enabled, jobs: this.jobs().slice(0, 25).map(({ instruction: _instruction, ...job }) => job), indexed, pending: media.length - indexed, categories: SMART_CATEGORIES.map(name => ({ name, count: media.filter(item => summaries.get(item.id)?.tags.includes(name)).length })) };
  }
  summaries(): Map<string, { tags: string[]; status: 'ready' | 'stale' }> {
    const media = new Map(this.currentRows().map(item => [item.id, item]));
    const overrides = new Map<string, Array<{ tag: string; present: boolean }>>();
    for (const row of this.db.prepare('SELECT * FROM ai_overrides').all() as Row[]) { const list = overrides.get(row.media_id) || []; list.push({ tag: row.tag, present: !!row.present }); overrides.set(row.media_id, list); }
    const result = new Map<string, { tags: string[]; status: 'ready' | 'stale' }>();
    for (const row of this.db.prepare('SELECT media_id,fingerprint,tags,cloud_tags FROM ai_results').all() as Row[]) {
      const item = media.get(row.media_id); if (!item) continue;
      const fresh = row.fingerprint === fingerprint(item);
      const tags = new Set<string>(fresh ? [...parse<string[]>(row.tags, []), ...parse<string[]>(row.cloud_tags, [])] : []);
      for (const correction of overrides.get(row.media_id) || []) correction.present ? tags.add(correction.tag) : tags.delete(correction.tag);
      result.set(row.media_id, { tags: [...tags], status: fresh ? 'ready' : 'stale' });
    }
    for (const [id, corrections] of overrides) if (media.has(id) && !result.has(id)) result.set(id, { tags: corrections.filter(item => item.present).map(item => item.tag), status: 'stale' });
    return result;
  }
  async setupModels(options: ModelSetupOptions = {}): Promise<IntelligenceState> {
    if (this.closed) throw new Error('识别服务已关闭');
    if (this.setupTask) return this.getState();
    if (this.active.size) throw new Error('请先暂停正在运行的识别任务');
    if (options.directory) {
      if (typeof options.directory !== 'string' || !path.isAbsolute(options.directory) || options.directory.includes('\0')) throw new Error('请选择有效的模型保存文件夹');
      this.directory = path.resolve(options.directory);
    }
    this.config('directory', this.directory);
    if (this.models.status !== 'error' && await this.engine.ready(this.directory)) { this.models = { status: 'ready', directory: this.directory, message: '本地模型已就绪' }; this.enabled = true; this.config('enabled', '1'); await this.enqueue(); this.emit(); return this.getState(); }
    this.models = { status: 'installing', directory: this.directory, message: '准备本地模型' };
    this.setupAbort = new AbortController();
    this.setupTask = this.engine.setup(this.directory, message => { this.models.message = message.slice(0, 300); this.emit(); }, this.setupAbort.signal).then(async () => {
      this.models = { status: 'ready', directory: this.directory, message: '本地模型已就绪' }; this.enabled = true; this.config('enabled', '1'); this.queryVectors.clear(); this.emit(); await this.enqueue();
    }).catch(error => { this.models = { status: 'error', directory: this.directory, message: '模型安装没有完成，可重试', error: textError(error).slice(-1500) }; this.emit(); }).finally(() => { this.setupTask = null; this.setupAbort = null; });
    this.emit(); return this.getState();
  }
  async enqueue(ids?: string[]): Promise<string | null> {
    if (this.closed || !this.enabled || this.models.status !== 'ready') return null;
    const activeIds = new Set<string>();
    for (const row of this.db.prepare("SELECT media_id FROM ai_job_items i JOIN ai_jobs j ON i.job_id=j.id WHERE i.status IN ('pending','working')").all() as Row[]) activeIds.add(row.media_id);
    const media = this.currentRows(ids ? unique(ids) : undefined).filter(item => { const result = this.result(item.id); return item.kind === 'image' && !item.missing && !(result?.fingerprint === fingerprint(item) && result.vector) && !activeIds.has(item.id); });
    if (!media.length) return null;
    const job: StoredJob = { id: randomUUID(), kind: 'local', status: 'queued', done: 0, total: media.length, errors: 0, label: '准备本地文字和内容识别', createdAt: Date.now() };
    this.db.exec('BEGIN');
    try { this.save(job); const insert = this.db.prepare('INSERT INTO ai_job_items(job_id,media_id) VALUES(?,?)'); for (const item of media) insert.run(job.id, item.id); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.launch(job.id); return job.id;
  }
  pause(id: string) { const job = this.job(id); if (job.status === 'complete') return; job.status = 'paused'; job.label = '已暂停，可以继续'; this.save(job); this.active.get(id)?.controller.abort(); }
  async resume(id: string, apiKey?: string) {
    const task = this.active.get(id)?.task; if (task) await task;
    const job = this.job(id); if (job.status === 'complete') return;
    if (job.kind === 'cloud' && !apiKey?.trim()) throw new Error('请先在设置中保存 DeepSeek API 密钥');
    if (job.kind === 'local' && this.models.status !== 'ready') throw new Error('请先完成本地模型安装');
    this.db.prepare("UPDATE ai_job_items SET status='pending',error=NULL WHERE job_id=? AND status IN ('error','working')").run(id);
    job.errors = 0; job.error = undefined; job.status = 'queued'; this.save(job); this.launch(id, apiKey);
  }
  private launch(id: string, apiKey?: string) {
    if (this.closed || this.active.has(id)) return;
    const controller = new AbortController();
    const earlier = [...this.active.values()].map(value => value.task);
    const task = this.perform(id, controller.signal, apiKey, earlier).finally(() => { this.active.delete(id); });
    this.active.set(id, { controller, task });
  }
  private async perform(id: string, signal: AbortSignal, apiKey?: string, earlier: Promise<void>[] = []) {
    // Multiple queued jobs may exist, but only one image inference runs at a time.
    for (const task of earlier) { if (signal.aborted) break; await task; }
    const job = this.job(id); if (this.closed || signal.aborted) return;
    job.status = 'running'; this.save(job);
    const rows = this.db.prepare("SELECT media_id FROM ai_job_items WHERE job_id=? AND status='pending' ORDER BY rowid").all(id) as Row[];
    for (const row of rows) {
      if (signal.aborted || this.closed) break;
      const item = this.currentRows([row.media_id])[0];
      if (!item || item.missing || item.kind !== 'image') { this.db.prepare("UPDATE ai_job_items SET status='done' WHERE job_id=? AND media_id=?").run(id, row.media_id); continue; }
      const before = fingerprint(item);
      this.db.prepare("UPDATE ai_job_items SET status='working' WHERE job_id=? AND media_id=?").run(id, item.id);
      job.label = `${job.kind === 'local' ? '本地识别' : '云端分析'} · ${item.fileName}`; this.save(job);
      try {
        const image = await this.options.getAnalysisImage(item.id);
        if (signal.aborted || this.closed) { this.db.prepare("UPDATE ai_job_items SET status='pending' WHERE job_id=? AND media_id=?").run(id, item.id); break; }
        if (job.kind === 'local') {
          const output = await this.engine.analyze(this.directory, image, item.fileName);
          if (signal.aborted || this.closed) { this.db.prepare("UPDATE ai_job_items SET status='pending' WHERE job_id=? AND media_id=?").run(id, item.id); break; }
          const now = this.currentRows([item.id])[0];
          if (!now || fingerprint(now) !== before) throw new Error('识别过程中原图发生变化，请重新识别');
          this.storeLocal(item, output);
        } else {
          if (!apiKey) throw new Error('云端任务需要重新确认 API 密钥');
          await this.cloud(item, image, job.instruction || '', apiKey, signal);
        }
        this.db.prepare("UPDATE ai_job_items SET status='done',error=NULL WHERE job_id=? AND media_id=?").run(id, item.id);
      } catch (error) {
        if (signal.aborted || this.closed) { this.db.prepare("UPDATE ai_job_items SET status='pending' WHERE job_id=? AND media_id=?").run(id, item.id); break; }
        this.db.prepare("UPDATE ai_job_items SET status='error',error=? WHERE job_id=? AND media_id=?").run(textError(error).slice(0, 1000), id, item.id); job.error = textError(error).slice(0, 1000);
      }
      this.updateCounts(job); this.save(job);
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    this.updateCounts(job);
    job.status = signal.aborted || this.closed ? 'paused' : job.errors ? 'error' : 'complete';
    job.label = job.status === 'paused' ? '已暂停，可以继续' : job.errors ? `部分图片识别失败（${job.errors} 项），可重试` : '识别完成'; this.save(job);
  }
  private updateCounts(job: StoredJob) { const rows = this.db.prepare('SELECT status,count(*) AS count FROM ai_job_items WHERE job_id=? GROUP BY status').all(job.id) as Row[]; job.done = rows.filter(row => row.status === 'done').reduce((n, row) => n + Number(row.count), 0); job.errors = rows.filter(row => row.status === 'error').reduce((n, row) => n + Number(row.count), 0); }
  private storeLocal(item: AnalysisMedia, output: LocalAnalysis) {
    if (!finiteVector(output.vector) || typeof output.text !== 'string' || !Array.isArray(output.tags)) throw new Error('本地模型返回了无效识别结果');
    const text = output.text.slice(0, 200_000), tags = unique(output.tags).slice(0, 50);
    const previous = this.result(item.id), same = previous?.fingerprint === fingerprint(item);
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO ai_results(media_id,fingerprint,text,text_norm,tags,vector,model_version,updated_at,cloud_description,cloud_tags,cloud_key,cloud_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET fingerprint=excluded.fingerprint,text=excluded.text,text_norm=excluded.text_norm,tags=excluded.tags,vector=excluded.vector,model_version=excluded.model_version,updated_at=excluded.updated_at,cloud_description=excluded.cloud_description,cloud_tags=excluded.cloud_tags,cloud_key=excluded.cloud_key,cloud_at=excluded.cloud_at`).run(item.id, fingerprint(item), text, normalizeSearch(text), JSON.stringify(tags), toBlob(output.vector), output.version || ANALYSIS_VERSION, Date.now(), same ? previous.cloud_description : '', same ? previous.cloud_tags : '[]', same ? previous.cloud_key : '', same ? previous.cloud_at : null);
      this.db.prepare('DELETE FROM ai_fts WHERE media_id=?').run(item.id); this.db.prepare('INSERT INTO ai_fts(media_id,text_index) VALUES(?,?)').run(item.id, textIndex(text)); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.vectors.set(item.id, { fingerprint: fingerprint(item), value: Float32Array.from(output.vector) });
  }
  detail(id: string): AnalysisDetail {
    const item = this.currentRows([id])[0]; if (!item) throw new Error('素材不存在');
    const row = this.result(id), summary = this.summaries().get(id);
    const suppressed = (this.db.prepare('SELECT tag FROM ai_overrides WHERE media_id=? AND present=0').all(id) as Row[]).map(row => row.tag);
    const fresh = row?.fingerprint === fingerprint(item);
    return { id, status: row ? fresh ? 'ready' : 'stale' : 'missing', text: fresh ? row.text : '', tags: summary?.tags || [], suppressedTags: suppressed, description: fresh ? row.cloud_description : '', cloudTags: fresh ? parse(row.cloud_tags, []) : [], updatedAt: row?.updated_at ?? null, modelVersion: row?.model_version || ANALYSIS_VERSION };
  }
  setTagOverride(id: string, tag: string, present: boolean) { if (!this.currentRows([id]).length) throw new Error('素材不存在'); if (typeof tag !== 'string' || !tag.trim() || tag.length > 100 || typeof present !== 'boolean') throw new Error('请输入有效标签'); this.db.prepare('INSERT INTO ai_overrides(media_id,tag,present) VALUES(?,?,?) ON CONFLICT(media_id,tag) DO UPDATE SET present=excluded.present').run(id, tag.trim(), +present); this.emit(); }
  async search(request: SearchRequest): Promise<SearchResponse> {
    const query = typeof request.query === 'string' ? request.query.trim().slice(0, 500) : '';
    const words = query.split(/\s+/u).filter(Boolean).map(normalizeSearch);
    const mode = ['all', 'text', 'content'].includes(request.mode || '') ? request.mode! : 'all';
    const offset = Math.max(0, Math.floor(Number(request.offset) || 0)), limit = Math.min(300, Math.max(1, Math.floor(Number(request.limit) || 100)));
    const rows = this.currentRows(request.ids ? unique(request.ids) : undefined), summaries = this.summaries();
    const eligible = rows.filter(item => !request.category || summaries.get(item.id)?.tags.includes(request.category) || item.tags.includes(request.category));
    let queryVector: number[] | undefined, warning: string | undefined;
    if (query && mode !== 'text' && this.models.status === 'ready') {
      try { queryVector = this.queryVectors.get(query); if (!queryVector) { queryVector = await this.engine.embed(this.directory, query); if (!finiteVector(queryVector)) throw new Error('内容检索模型返回无效向量'); if (this.queryVectors.size > 100) this.queryVectors.clear(); this.queryVectors.set(query, queryVector); } } catch (error) { warning = `内容检索暂不可用：${textError(error).slice(0, 200)}`; }
    }
    const matches: SearchHit[] = [];
    // FTS preselects text candidates; final substring check keeps OCR phrase matching exact.
    const textCandidates = new Set<string>();
    if (words.length && mode !== 'content') {
      const terms = [...new Set(words.flatMap(word => textIndex(word).split(' ').filter(Boolean)))];
      if (terms.length) {
        const expression = terms.slice(0, 200).map(term => `"${term.replace(/"/g, '""')}"`).join(' AND ');
        for (const row of this.db.prepare('SELECT media_id FROM ai_fts WHERE ai_fts MATCH ?').all(expression) as Row[]) textCandidates.add(row.media_id);
      } else for (const row of this.db.prepare('SELECT media_id FROM ai_results WHERE instr(text_norm,?)>0').all(words[0]) as Row[]) textCandidates.add(row.media_id);
    }
    const resultRows = new Map((this.db.prepare('SELECT media_id,fingerprint,cloud_description FROM ai_results').all() as Row[]).map(row => [row.media_id, row]));
    const readText = this.db.prepare('SELECT text,text_norm FROM ai_results WHERE media_id=?');
    for (const item of eligible) {
      const row = resultRows.get(item.id), fresh = row?.fingerprint === fingerprint(item), tags = summaries.get(item.id)?.tags || [];
      let score = -1, reason = '', snippet = '', matchedBy: SearchHit['matchedBy'] = 'category';
      const every = (value: string) => words.every(word => normalizeSearch(value).includes(word));
      if (!query) { score = 0; reason = request.category ? `智能分类 · ${request.category}` : '图库素材'; }
      else {
        if (mode === 'all' && every(item.fileName)) { score = 200; reason = '文件名匹配'; snippet = item.fileName; matchedBy = 'filename'; }
        if (mode !== 'text' && every(item.tags.join(' ')) && score < 190) { score = 190; reason = '你添加的标签'; snippet = item.tags.join('、'); matchedBy = 'tag'; }
        if (mode !== 'content' && fresh && textCandidates.has(item.id) && score < 180) { const ocr = readText.get(item.id) as Row; if (every(ocr.text_norm)) { score = 180; reason = '图片中的文字'; const index = ocr.text_norm.indexOf(words[0]); snippet = ocr.text.slice(Math.max(0, index - 30), index + 100).replace(/\n/g, ' '); matchedBy = 'text'; } }
        if (mode !== 'text' && every(tags.join(' ')) && score < 160) { score = 160; reason = '内容分类标签'; snippet = tags.join('、'); matchedBy = 'tag'; }
        if (mode !== 'text' && fresh && row.cloud_description && every(row.cloud_description) && score < 150) { score = 150; reason = '图片内容描述'; snippet = row.cloud_description.slice(0, 120); matchedBy = 'content'; }
        const vector = this.vectors.get(item.id);
        if (mode !== 'text' && queryVector && vector?.fingerprint === fingerprint(item)) { const sim = similarity(queryVector, vector.value); if (sim >= 0.22 && sim * 100 > score) { score = sim * 100; reason = '画面内容相近'; snippet = `内容相关度 ${Math.round(sim * 100)}%`; matchedBy = 'content'; } }
      }
      if (score >= 0) matches.push({ id: item.id, score, reason, snippet, matchedBy });
    }
    matches.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return { hits: matches.slice(offset, offset + limit), total: matches.length, offset, limit, semanticReady: this.models.status === 'ready' && !warning, ...(warning ? { warning } : {}) };
  }
  async startCloud(ids: string[], instruction: string, apiKey: string): Promise<string> {
    if (this.closed) throw new Error('识别服务已关闭');
    if (!apiKey?.trim()) throw new Error('请先保存 DeepSeek API 密钥');
    const media = this.currentRows(unique(ids)).filter(item => item.kind === 'image' && !item.missing);
    if (!media.length) throw new Error('请选择可以读取的静态照片');
    const job: StoredJob = { id: randomUUID(), kind: 'cloud', status: 'queued', done: 0, total: media.length, errors: 0, label: '准备分析所选照片', instruction: String(instruction || '').slice(0, 2000), createdAt: Date.now() };
    this.db.exec('BEGIN'); try { this.save(job); const insert = this.db.prepare('INSERT INTO ai_job_items(job_id,media_id) VALUES(?,?)'); for (const item of media) insert.run(job.id, item.id); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.launch(job.id, apiKey); return job.id;
  }
  private async cloud(item: AnalysisMedia, image: string, instruction: string, apiKey: string, signal: AbortSignal) {
    const cacheKey = hash(`${fingerprint(item)}:deepseek-flash:cloud-v1:${instruction}`), previous = this.result(item.id);
    if (previous?.cloud_key === cacheKey && previous.fingerprint === fingerprint(item)) return;
    // Re-encode an analysis copy without metadata; originals never leave this process.
    const bytes = await sharp(image, { limitInputPixels: 100_000_000 }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
    // Official image-input schema: https://api-docs.deepseek.com/guides/vision/
    const response = await (this.options.cloudFetch ?? fetch)('https://api.deepseek.com/chat/completions', { method: 'POST', signal: requestSignal, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-flash', temperature: 0, max_tokens: 600, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: [{ type: 'text', text: `请用中文描述这张图片并生成客观内容标签。只返回 JSON：{"description":"最多150字","tags":["最多15个简短标签"]}。不要推测人物身份或虚构看不到的信息。${instruction ? `用户分类要求：${instruction}` : ''}` }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` } }] }] }) });
    if (!response.ok) throw new Error(`DeepSeek 请求失败（HTTP ${response.status}），请检查密钥或额度`);
    const raw = await response.text(); if (raw.length > 1_000_000) throw new Error('云端返回过大');
    const body = JSON.parse(raw), content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('云端没有返回有效内容');
    const parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (typeof parsed.description !== 'string' || !Array.isArray(parsed.tags) || parsed.tags.some((tag: unknown) => typeof tag !== 'string' || tag.length > 100)) throw new Error('云端返回格式不正确，可重试');
    const now = this.currentRows([item.id])[0]; if (!now || fingerprint(now) !== fingerprint(item)) throw new Error('云端分析期间原图发生变化，结果没有应用');
    const tags = unique(parsed.tags).slice(0, 15), description = parsed.description.slice(0, 1000);
    if (previous && previous.fingerprint !== fingerprint(item)) { this.db.prepare("UPDATE ai_results SET fingerprint=?,text='',text_norm='',tags='[]',vector=NULL WHERE media_id=?").run(fingerprint(item), item.id); this.db.prepare('DELETE FROM ai_fts WHERE media_id=?').run(item.id); this.vectors.delete(item.id); }
    this.db.prepare(`INSERT INTO ai_results(media_id,fingerprint,model_version,updated_at,cloud_description,cloud_tags,cloud_key,cloud_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET updated_at=excluded.updated_at,cloud_description=excluded.cloud_description,cloud_tags=excluded.cloud_tags,cloud_key=excluded.cloud_key,cloud_at=excluded.cloud_at`).run(item.id, fingerprint(item), ANALYSIS_VERSION, Date.now(), description, JSON.stringify(tags), cacheKey, Date.now());
  }
  async waitForIdle() { if (this.setupTask) await this.setupTask; while (this.active.size) await Promise.all([...this.active.values()].map(value => value.task)); }
  async close() { if (this.closed) return; this.closed = true; this.setupAbort?.abort(); for (const active of this.active.values()) active.controller.abort(); await this.engine.close(); await this.waitForIdle(); }
}
