import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import chokidar, { type FSWatcher } from 'chokidar';
import { DEFAULT_SETTINGS, type Album, type ImportError, type JobState, type LibraryChange, type LibrarySnapshot, type MediaItem, type MediaPatch, type Settings, type Source } from '../src/shared/types';
import { cleanOrphanMediaTemps, kindOf, makeThumbnail, makeVideoProxy, mimeFor, probeMedia, makeAnalysisImage, isHeif, type Binaries } from './media';
import { PhoneService } from './phone';
import { PhoneReceiver } from './receive';
import type { PhoneReceiveOptions } from '../src/shared/receive';
import { IntelligenceService } from './intelligence';
import { ComputerDiscovery } from './discovery';
import type { ComputerLocation } from '../src/shared/discovery';
import type { PhoneImportRequest } from '../src/shared/phone';
import type { ModelSetupOptions, SearchRequest } from '../src/shared/intelligence';

type Row=Record<string,any>;
export const pathKey=(file:string)=>{const resolved=path.resolve(file);const root=path.parse(resolved).root;const absolute=resolved.length>root.length?resolved.replace(/[\\/]+$/,''):root;return process.platform==='win32'?absolute.toLowerCase():absolute;};
const within=(child:string,parent:string)=>{const relative=path.relative(parent,child);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
const list=(value:string):string[]=>{try{return JSON.parse(value);}catch{return [];}};
// Selection batches can include the entire library; never silently truncate IDs.
const values=(input:unknown):string[]=>Array.isArray(input)?[...new Set(input.filter((v):v is string=>typeof v==='string').map(v=>v.trim()).filter(Boolean))]:[];
export interface LibraryOptions { dataDir:string;binaries:Binaries;adbPath?:string;aiResourceDir?:string;commonLocations?:ComputerLocation[];receiverBindAddress?:string;watch?:boolean;cacheBudget?:number;onChange?:(event:LibraryChange)=>void }

/** SQLite stays on the backend worker. API: https://nodejs.org/docs/latest-v24.x/api/sqlite.html */
export class Library {
  private db:DatabaseSync;
  private options:LibraryOptions;
  private settings:Settings;
  private jobs:JobState[]=[];
  private errors:ImportError[]=[];
  private queue=new Set<string>();
  private scanTask:Promise<void>|null=null;
  private scanAbort:AbortController|null=null;
  private watchers=new Map<string,FSWatcher>();
  private watchTimers=new Map<string,ReturnType<typeof setTimeout>>();
  private changedTimer:ReturnType<typeof setTimeout>|null=null;
  private previews=new Map<string,Promise<string>>();
  private videoJobs=new Map<string,{abort:AbortController;promise:Promise<string>}>();
  private processing=0;
  private mediaWaiters:Array<()=>void>=[];
  private protectedCache=new Map<string,number>();
  private closed=false;
  private cacheDir:string;
  private phone:PhoneService;
  private receiver:PhoneReceiver;
  private intelligence:IntelligenceService;
  private discovery:ComputerDiscovery;
  private trashing=new Set<string>();
  constructor(options:LibraryOptions) {
    this.options=options;mkdirSync(options.dataDir,{recursive:true});
    // Keep derived media separate from Chromium's case-insensitive Windows "Cache" directory.
    this.cacheDir=path.join(options.dataDir,'MediaCache');mkdirSync(this.cacheDir,{recursive:true});
    this.db=new DatabaseSync(path.join(options.dataDir,'library.sqlite'));
    const version=Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if(version>0&&version<3){const backups=path.join(options.dataDir,'Backups');mkdirSync(backups,{recursive:true});this.db.prepare('VACUUM INTO ?').run(path.join(backups,`library-before-1.1.0-${Date.now()}.sqlite`));}
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,path TEXT NOT NULL,path_key TEXT UNIQUE NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'online');
      CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,path TEXT NOT NULL,path_key TEXT UNIQUE NOT NULL,file_name TEXT NOT NULL,kind TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,duration REAL,size INTEGER NOT NULL,mtime_ms REAL NOT NULL,added_at REAL NOT NULL,favorite INTEGER NOT NULL DEFAULT 0,missing INTEGER NOT NULL DEFAULT 0,excluded INTEGER NOT NULL DEFAULT 0,tags TEXT NOT NULL DEFAULT '[]',albums TEXT NOT NULL DEFAULT '[]');
      CREATE INDEX IF NOT EXISTS media_source ON media(source_id);CREATE INDEX IF NOT EXISTS media_active ON media(excluded,missing);
      CREATE TABLE IF NOT EXISTS albums(id TEXT PRIMARY KEY,name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    const columns=new Set((this.db.prepare('PRAGMA table_info(media)').all() as Row[]).map(column=>column.name));
    for(const [name,definition]of [['open_count','INTEGER NOT NULL DEFAULT 0'],['last_opened_at','REAL'],['taken_at','REAL'],['date_checked','INTEGER NOT NULL DEFAULT 0'],['trashed_at','REAL']])if(!columns.has(name))this.db.exec(`ALTER TABLE media ADD COLUMN ${name} ${definition}`);
    if(version<3)this.db.exec('PRAGMA user_version=3');
    const saved=this.db.prepare("SELECT value FROM settings WHERE key='preferences'").get() as Row|undefined;
    let parsed:Partial<Settings>={};try{if(saved)parsed=JSON.parse(saved.value);}catch{}
    this.settings={...DEFAULT_SETTINGS,...parsed,camera:{...DEFAULT_SETTINGS.camera,...parsed.camera}};
    this.db.exec("UPDATE sources SET status='online' WHERE status='scanning'");
    this.phone=new PhoneService({dataDir:options.dataDir,db:this.db,adbPath:options.adbPath??path.resolve('resources/binaries/adb.exe'),onChange:()=>this.emit('progress'),onImported:async root=>{await this.addSources([root]);}});
    this.receiver=new PhoneReceiver({db:this.db,bindAddress:options.receiverBindAddress,onChange:()=>this.emit('progress'),onImported:async root=>{await this.addSources([root]);}});
    this.intelligence=new IntelligenceService({dataDir:options.dataDir,db:this.db,resourceDir:options.aiResourceDir??path.resolve('resources/ai'),onChange:()=>this.emit('library'),getMedia:ids=>this.analysisRows(ids),getAnalysisImage:id=>this.analysisImage(id)});
    this.discovery=new ComputerDiscovery({commonLocations:options.commonLocations,excludedPaths:[options.dataDir],onChange:()=>this.emit('progress')});
  }
  private emit(type:LibraryChange['type'],immediate=false) {
    if(this.closed)return;
    if(type!=='library'||immediate){this.options.onChange?.({type});return;}
    if(!this.changedTimer)this.changedTimer=setTimeout(()=>{this.changedTimer=null;if(!this.closed)this.options.onChange?.({type:'library'});},350);
  }
  private sourceRows():Row[]{return this.db.prepare('SELECT * FROM sources ORDER BY rowid').all() as Row[];}
  private mediaRow(id:string):Row {const row=this.db.prepare('SELECT * FROM media WHERE id=? AND excluded=0 AND trashed_at IS NULL').get(id) as Row|undefined;if(!row)throw new Error('素材不存在');return row;}
  private url(row:Row,variant:string){return `app-media://asset/${row.id}/${variant}?v=${Math.round(row.mtime_ms)}`;}
  getSnapshot():LibrarySnapshot {
    const rows=this.db.prepare('SELECT * FROM media WHERE excluded=0 AND trashed_at IS NULL ORDER BY added_at,id').all() as Row[];
    const summaries=this.intelligence.summaries();
    const aliasFolders=new Map<string,Array<{id:string;name:string;path:string}>>();
    for(const alias of this.phone.getAliases()){const remote=alias.sourcePath.replace(/\\/g,'/');const folder=remote.slice(0,remote.lastIndexOf('/'));const id=`phone:${alias.deviceId}:${folder}`;const key=pathKey(alias.localPath);const folders=aliasFolders.get(key)??[];if(!folders.some(f=>f.id===id))folders.push({id,name:folder.split('/').pop()||alias.deviceName,path:`${alias.deviceName} · ${folder}`});aliasFolders.set(key,folders);}
    for(const alias of this.receiver.getAliases()){const key=pathKey(alias.localPath),id=`phone:wireless:${pathKey(alias.albumPath)}`;const folders=aliasFolders.get(key)??[];if(!folders.some(folder=>folder.id===id))folders.push({id,name:alias.albumName,path:alias.albumPath});aliasFolders.set(key,folders);}
    const tagSet=new Set<string>();
    const media:MediaItem[]=rows.map(row=>{const tags=list(row.tags);tags.forEach(tag=>tagSet.add(tag));return {id:row.id,sourceId:row.source_id,path:row.path,fileName:row.file_name,kind:row.kind,width:row.width,height:row.height,duration:row.duration,size:row.size,mtimeMs:row.mtime_ms,addedAt:row.added_at,openCount:row.open_count,lastOpenedAt:row.last_opened_at,takenAt:row.taken_at,favorite:!!row.favorite,missing:!!row.missing,tags,aiTags:summaries.get(row.id)?.tags??[],phoneFolders:aliasFolders.get(row.path_key),albumIds:list(row.albums),thumbnailUrl:this.url(row,'thumbnail'),previewUrl:this.url(row,'preview'),originalUrl:this.url(row,'original')};});
    const counts=new Map<string,number>();for(const item of media)counts.set(item.sourceId,(counts.get(item.sourceId)??0)+1);
    const sources:Source[]=this.sourceRows().map(row=>({id:row.id,path:row.path,name:row.name,status:row.status,count:counts.get(row.id)??0}));
    return {media,sources,albums:this.db.prepare('SELECT * FROM albums ORDER BY rowid').all() as unknown as Album[],tags:[...tagSet].sort((a,b)=>a.localeCompare(b,'zh-CN')),settings:{...this.settings,camera:{...this.settings.camera}},jobs:this.jobs.map(j=>({...j})),errors:[...this.errors]};
  }
  async initialize(){await cleanOrphanMediaTemps(this.cacheDir);await this.phone.initialize();await this.intelligence.initialize();for(const source of this.sourceRows())await this.watch(source);this.rescan();}
  async addSources(paths:string[]) {await this.addSourcePaths(paths);}
  private directSource(id:string){return Boolean(this.db.prepare('SELECT 1 FROM settings WHERE key=?').get(`source-direct:${id}`));}
  private async addSourcePaths(paths:string[],directOnly=false) {
    for(const input of values(paths)) {
      const actual=await fs.realpath(path.resolve(input));const stat=await fs.stat(actual);
      if(!stat.isDirectory())throw new Error('请选择或拖入文件夹');
      const key=pathKey(actual);let row=this.db.prepare('SELECT * FROM sources WHERE path_key=?').get(key) as Row|undefined;
      if(!row){const id=randomUUID();this.db.prepare('INSERT INTO sources(id,path,path_key,name,status) VALUES(?,?,?,?,?)').run(id,actual,key,path.basename(actual)||actual,'online');row={id,path:actual,path_key:key};if(directOnly)this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(`source-direct:${id}`,'true');}
      if(!directOnly&&this.directSource(row.id)){this.db.prepare('DELETE FROM settings WHERE key=?').run(`source-direct:${row.id}`);await this.watchers.get(row.id)?.close();this.watchers.delete(row.id);}
      await this.watch(row);this.queue.add(row.id);
    }
    this.emit('library',true);this.startQueue();
  }
  computerLocations(){return this.discovery.locations();}
  computerDiscoveryState(){return this.discovery.getState();}
  discoverComputer(paths:string[]){return this.discovery.start(paths);}
  async resolveDiscoveryPreview(scanId:string,folderId:string):Promise<{path:string;mime:string}>{
    const cover=this.discovery.getPreview(scanId,folderId),stat=await fs.lstat(cover.path);
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error('预览文件暂时无法读取');
    const fingerprint=createHash('sha256').update(cover.path).update(String(stat.mtimeMs)).digest('hex').slice(0,24);
    const file=path.join(this.cacheDir,`discovery-${scanId}-${fingerprint}.webp`);
    if(!existsSync(file)){
      let task=this.previews.get(file);
      if(!task){task=this.runMedia(()=>makeThumbnail(cover.path,cover.kind,file,256,this.options.binaries,null)).then(()=>file).finally(()=>this.previews.delete(file));this.previews.set(file,task);}
      await task;
    }
    return {path:file,mime:'image/webp'};
  }
  cancelComputerDiscovery(){this.discovery.cancel();}
  async addDiscoveredFolders(scanId:string,paths:string[]){
    const state=this.discovery.getState();if(state.id!==scanId)throw new Error('扫描结果已变化，请重新选择文件夹');
    const allowed=new Set(state.folders.map(folder=>pathKey(folder.path)));const selected=values(paths);
    if(!selected.length||selected.some(folder=>!allowed.has(pathKey(folder))))throw new Error('请选择本次扫描找到的照片文件夹');
    // Each checkbox names an exact discovered directory. Do not recurse into
    // excluded application caches or child folders the user did not select.
    await this.addSourcePaths(selected,true);
  }
  rescan(sourceId?:string){if(sourceId){if(!this.sourceRows().some(row=>row.id===sourceId))throw new Error('文件夹不存在');this.queue.add(sourceId);}else this.sourceRows().forEach(row=>this.queue.add(row.id));this.startQueue();}
  cancelScan(){this.queue.clear();this.scanAbort?.abort();}
  async waitForIdle(){while(this.scanTask)await this.scanTask;}
  private startQueue(){if(this.scanTask||this.closed||this.trashing.size)return;this.scanTask=this.processQueue().finally(()=>{this.scanTask=null;if(this.queue.size&&!this.closed)this.startQueue();});}
  private async processQueue(){while(this.queue.size&&!this.closed&&!this.trashing.size){const id=this.queue.values().next().value as string;this.queue.delete(id);const source=this.db.prepare('SELECT * FROM sources WHERE id=?').get(id) as Row|undefined;if(source)await this.scan(source);}await this.pruneCache();if(!this.closed)await this.intelligence.enqueue();}
  private addError(file:string,error:unknown){this.errors.push({path:file,message:error instanceof Error?error.message:String(error)});if(this.errors.length>100)this.errors.shift();}
  private job(job:JobState){this.jobs=[...this.jobs.filter(j=>j.status==='running'),job].slice(-12);this.emit('progress');return job;}
  private async scan(source:Row){
    const abort=new AbortController();this.scanAbort=abort;
    const job=this.job({id:randomUUID(),type:'scan',status:'running',label:`扫描 ${source.name}`,done:0,total:0});
    const files:string[]=[];let enumerationFailed=false,failed=0;
    try {
      const rootStat=await fs.stat(source.path);if(!rootStat.isDirectory())throw new Error('文件夹不可用');
      this.db.prepare("UPDATE sources SET status='scanning' WHERE id=?").run(source.id);this.emit('library',true);
      const directOnly=this.directSource(source.id);
      const visit=async(directory:string)=>{if(abort.signal.aborted)return;try{const dir=await fs.opendir(directory);for await(const entry of dir){if(abort.signal.aborted)break;const file=path.join(directory,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory()){if(directOnly||pathKey(file)===pathKey(this.options.dataDir))continue;await visit(file);}else if(entry.isFile()&&kindOf(file))files.push(file);}}catch(error){enumerationFailed=true;this.addError(directory,error);}};
      await visit(source.path);job.total=files.length;job.label=`读取 ${source.name}`;this.emit('progress');
      const seen=new Set<string>();
      let cursor=0;
      const consume=async()=>{while(cursor<files.length&&!abort.signal.aborted){const file=files[cursor++];seen.add(pathKey(file));try{await this.indexFile(source,file,abort.signal);}catch(error){if(!abort.signal.aborted){failed++;this.addError(file,error);}}job.done++;if(job.done%8===0||job.done===job.total){this.emit('progress');this.emit('library');await yieldTurn();}}};
      await Promise.all([consume(),consume()]);
      if(!abort.signal.aborted&&!enumerationFailed){const known=this.db.prepare('SELECT id,path_key FROM media WHERE source_id=?').all(source.id) as Row[];const mark=this.db.prepare('UPDATE media SET missing=1 WHERE id=?');this.db.exec('BEGIN');try{for(const row of known)if(!seen.has(row.path_key))mark.run(row.id);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}
      this.db.prepare("UPDATE sources SET status='online' WHERE id=?").run(source.id);
      job.status=abort.signal.aborted?'cancelled':failed>0&&failed===files.length?'error':'complete';
      if(failed)job.error=`${failed} 项素材无法读取，请查看读取详情后重试`;
      else if(enumerationFailed)job.error='部分子文件夹无法访问，请检查权限后重试';
      job.label=abort.signal.aborted?'扫描已暂停':job.status==='error'?`${source.name} 读取失败`:`${source.name} 已更新`;
    }catch(error){this.db.prepare("UPDATE sources SET status='offline' WHERE id=?").run(source.id);this.db.prepare('UPDATE media SET missing=1 WHERE source_id=?').run(source.id);job.status='error';job.error='文件夹离线或无权访问';this.addError(source.path,error);}
    finally{this.scanAbort=null;this.emit('progress');this.emit('library',true);}
  }
  private cachePath(row:Row,variant:'thumbnail'|'preview'|'playable'){return path.join(this.cacheDir,`${row.id}-${Math.round(row.mtime_ms)}-${variant}.${variant==='playable'?'mp4':'webp'}`);}
  private async runMedia<T>(operation:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
    if(this.processing>=3)await new Promise<void>(resolve=>this.mediaWaiters.push(resolve));else this.processing++;
    try{if(this.closed||signal?.aborted)throw new Error('任务已取消');return await operation();}
    finally{const next=this.mediaWaiters.shift();if(next)next();else this.processing--;}
  }
  private ensureThumbnail(row:Row,variant:'thumbnail'|'preview',signal?:AbortSignal):Promise<string>{
    const file=this.cachePath(row,variant);
    let task=this.previews.get(file);
    if(!task){task=this.runMedia(()=>makeThumbnail(row.path,row.kind,file,variant==='thumbnail'?384:1280,this.options.binaries,row.duration,signal),signal).then(()=>file).finally(()=>this.previews.delete(file));this.previews.set(file,task);}
    return task;
  }
  private async indexFile(source:Row,file:string,signal:AbortSignal){
    const kind=kindOf(file);if(!kind||signal.aborted)return;
    const stat=await fs.stat(file);const key=pathKey(file);
    const old=this.db.prepare('SELECT * FROM media WHERE path_key=?').get(key) as Row|undefined;
    if(old?.excluded||this.trashing.has(old?.id))return;
    if(old?.trashed_at)this.db.prepare('UPDATE media SET trashed_at=NULL WHERE id=?').run(old.id);
    if(old&&old.mtime_ms===stat.mtimeMs&&old.size===stat.size){this.db.prepare('UPDATE media SET missing=0 WHERE id=?').run(old.id);if(!old.date_checked){const meta=await probeMedia(file,kind,this.options.binaries,signal);this.db.prepare('UPDATE media SET taken_at=?,date_checked=1 WHERE id=?').run(meta.takenAt,old.id);}if(!existsSync(this.cachePath(old,'thumbnail')))await this.ensureThumbnail(old,'thumbnail',signal);return;}
    const meta=await probeMedia(file,kind,this.options.binaries,signal);if(signal.aborted)return;
    const row={id:old?.id??randomUUID(),mtime_ms:stat.mtimeMs,path:file,kind,duration:meta.duration};
    await this.ensureThumbnail(row,'thumbnail',signal);
    if(signal.aborted)return;
    if(old)this.db.prepare('UPDATE media SET path=?,file_name=?,kind=?,width=?,height=?,duration=?,size=?,mtime_ms=?,taken_at=?,date_checked=1,missing=0 WHERE id=?').run(file,path.basename(file),kind,meta.width,meta.height,meta.duration,stat.size,stat.mtimeMs,meta.takenAt,old.id);
    else this.db.prepare('INSERT INTO media(id,source_id,path,path_key,file_name,kind,width,height,duration,size,mtime_ms,added_at,taken_at,date_checked) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)').run(row.id,source.id,file,key,path.basename(file),kind,meta.width,meta.height,meta.duration,stat.size,stat.mtimeMs,Date.now(),meta.takenAt);
  }
  private async watch(source:Row){
    if(this.options.watch===false||this.watchers.has(source.id)||this.closed)return;
    const watcher=chokidar.watch(source.path,{ignoreInitial:true,...(this.directSource(source.id)?{depth:0}:{}),awaitWriteFinish:{stabilityThreshold:900,pollInterval:200},ignored:(file,stats)=>stats?.isDirectory()?pathKey(file)===pathKey(this.options.dataDir):false,followSymlinks:false});
    watcher.on('all',()=>{const old=this.watchTimers.get(source.id);if(old)clearTimeout(old);this.watchTimers.set(source.id,setTimeout(()=>{this.watchTimers.delete(source.id);if(!this.closed)this.rescan(source.id);},1400));});
    watcher.on('error',error=>{this.addError(source.path,error);this.emit('library');});this.watchers.set(source.id,watcher);
  }
  updateMedia(ids:string[],patch:MediaPatch){
    const keys=values(ids),addTags=values(patch.addTags).map(tag=>tag.slice(0,100)),removeTags=new Set(values(patch.removeTags));
    const knownAlbums=new Set((this.db.prepare('SELECT id FROM albums').all() as Row[]).map(r=>r.id));
    const addAlbums=values(patch.addAlbumIds).filter(id=>knownAlbums.has(id)),removeAlbums=new Set(values(patch.removeAlbumIds));
    this.db.exec('BEGIN');try{for(const id of keys){const row=this.db.prepare('SELECT * FROM media WHERE id=? AND excluded=0').get(id) as Row|undefined;if(!row)continue;const tags=[...new Set([...list(row.tags),...addTags])].filter(t=>!removeTags.has(t));const albums=[...new Set([...list(row.albums),...addAlbums])].filter(a=>!removeAlbums.has(a));this.db.prepare('UPDATE media SET favorite=?,tags=?,albums=? WHERE id=?').run(typeof patch.favorite==='boolean'?Number(patch.favorite):row.favorite,JSON.stringify(tags),JSON.stringify(albums),id);}this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}this.emit('library',true);
  }
  createAlbum(name:string):Album{const cleaned=name.trim().slice(0,100);if(!cleaned)throw new Error('请输入相册名称');const album={id:randomUUID(),name:cleaned};this.db.prepare('INSERT INTO albums(id,name) VALUES(?,?)').run(album.id,album.name);this.emit('library',true);return album;}
  renameAlbum(id:string,name:string){const cleaned=name.trim().slice(0,100);if(!cleaned)throw new Error('请输入相册名称');this.db.prepare('UPDATE albums SET name=? WHERE id=?').run(cleaned,id);this.emit('library',true);}
  deleteAlbum(id:string){this.db.exec('BEGIN');try{this.db.prepare('DELETE FROM albums WHERE id=?').run(id);for(const row of this.db.prepare("SELECT id,albums FROM media WHERE albums<>'[]'").all() as Row[]){const albums=list(row.albums);if(albums.includes(id))this.db.prepare('UPDATE media SET albums=? WHERE id=?').run(JSON.stringify(albums.filter(a=>a!==id)),row.id);}this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}this.emit('library',true);}
  private assertSourceCanChange(...paths:string[]){
    const roots=paths.map(pathKey);
    const receiving=this.receiver.getState();if(receiving.active&&receiving.destination){const destination=pathKey(receiving.destination);if(roots.some(root=>within(destination,root)||within(root,destination)))throw new Error('这个文件夹正在无线接收照片，请先停止接收，再移除或重新定位文件夹。');}
    // Inspect every durable job; the phone progress UI intentionally shows only recent jobs.
    const jobs=this.db.prepare("SELECT json_extract(data,'$.destination') AS destination FROM phone_jobs WHERE json_extract(data,'$.status') IN ('queued','running')").all() as Row[];
    for(const job of jobs){if(typeof job.destination!=='string')continue;const destination=pathKey(job.destination);if(roots.some(root=>within(destination,root)||within(root,destination)))throw new Error('这个文件夹正在接收手机照片，请先暂停手机导入，再移除或重新定位文件夹。');}
  }
  async removeSource(id:string){
    const source=this.sourceRows().find(row=>row.id===id);if(source)this.assertSourceCanChange(source.path);
    this.cancelScan();await this.waitForIdle();await this.watchers.get(id)?.close();this.watchers.delete(id);const timer=this.watchTimers.get(id);if(timer)clearTimeout(timer);this.watchTimers.delete(id);
    try{if(source)this.assertSourceCanChange(source.path);}catch(error){if(source)await this.watch(source);this.rescan();throw error;}
    const alternatives=this.sourceRows().filter(source=>source.id!==id).sort((a,b)=>b.path_key.length-a.path_key.length);
    this.db.exec('BEGIN');try{
      for(const row of this.db.prepare('SELECT id,path_key FROM media WHERE source_id=?').all(id) as Row[]){const owner=alternatives.find(source=>within(row.path_key,source.path_key)&&(!this.directSource(source.id)||pathKey(path.dirname(row.path_key))===source.path_key));if(owner)this.db.prepare('UPDATE media SET source_id=? WHERE id=?').run(owner.id,row.id);}
      this.db.prepare('DELETE FROM sources WHERE id=?').run(id);this.db.prepare('DELETE FROM settings WHERE key=?').run(`source-direct:${id}`);this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    this.emit('library',true);this.rescan();
  }
  removeMedia(ids:string[]){const statement=this.db.prepare('UPDATE media SET excluded=1 WHERE id=?');this.db.exec('BEGIN');try{for(const id of values(ids))statement.run(id);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}this.emit('library',true);}
  async beginTrash(ids:string[]){
    if(this.trashing.size)throw new Error('上一批删除仍在处理中');const rows=values(ids).map(id=>this.mediaRow(id));
    try{for(const row of rows)this.trashing.add(row.id);this.cancelScan();await this.waitForIdle();
      for(const row of rows)this.cancelVideo(row.id);await Promise.allSettled([...this.videoJobs.values()].map(job=>job.promise));await Promise.allSettled([...this.previews.values()]);
      return rows.map(row=>({id:row.id,path:path.resolve(row.path),fileName:row.file_name}));
    }catch(error){this.trashing.clear();this.rescan();throw error;}
  }
  finishTrash(removed:string[]){
    try{for(const id of values(removed))if(this.trashing.has(id))this.db.prepare('UPDATE media SET missing=1,trashed_at=? WHERE id=?').run(Date.now(),id);}
    finally{this.trashing.clear();this.emit('library',true);this.rescan();}
  }
  phoneState(){return this.phone.getState();}
  phoneReceiveState(){return this.receiver.getState();}
  startPhoneReceive(options:PhoneReceiveOptions){return this.receiver.start(options);}
  stopPhoneReceive(){return this.receiver.stop();}
  phoneDevices(){return this.phone.listDevices();}
  pairPhone(address:string,code:string){return this.phone.pair(address,code);}
  connectPhone(address:string){return this.phone.connect(address);}
  scanPhone(deviceId:string){return this.phone.scan(deviceId);}
  importPhone(request:PhoneImportRequest){return this.phone.startImport(request);}
  pausePhoneImport(jobId:string){return this.phone.pause(jobId);}
  resumePhoneImport(jobId:string){return this.phone.resume(jobId);}
  intelligenceState(){return this.intelligence.getState();}
  setupModels(options?:ModelSetupOptions){return this.intelligence.setupModels(options);}
  analyzeMedia(ids?:string[]){return this.intelligence.enqueue(ids);}
  pauseAnalysis(jobId:string){return this.intelligence.pause(jobId);}
  resumeAnalysis(jobId:string,key?:string){return this.intelligence.resume(jobId,key);}
  searchMedia(request:SearchRequest){return this.intelligence.search(request);}
  analysisDetail(id:string){this.mediaRow(id);return this.intelligence.detail(id);}
  setAITag(id:string,tag:string,present:boolean){this.mediaRow(id);return this.intelligence.setTagOverride(id,tag,present);}
  startCloudAnalysis(ids:string[],instruction:string,key:string){return this.intelligence.startCloud(ids,instruction,key);}
  private analysisRows(ids?:string[]){const selected=ids?new Set(ids):null;return (this.db.prepare('SELECT * FROM media WHERE excluded=0 AND trashed_at IS NULL').all() as Row[]).filter(row=>!selected||selected.has(row.id)).map(row=>({id:row.id,path:row.path,fileName:row.file_name,kind:row.kind,mtimeMs:row.mtime_ms,size:row.size,missing:!!row.missing,tags:list(row.tags)}));}
  private async analysisImage(id:string,fullResolution=false){const row=this.mediaRow(id);if(row.kind!=='image')throw new Error('当前仅支持静态照片识别');const target=path.join(this.cacheDir,`${row.id}-${Math.round(row.mtime_ms)}-${fullResolution?'display-original':'analysis'}.webp`);let task=this.previews.get(target);if(!task&&!existsSync(target)){task=this.runMedia(()=>makeAnalysisImage(row.path,target,fullResolution?0:2400)).finally(()=>this.previews.delete(target));this.previews.set(target,task);}if(task)await task;this.protectedCache.set(target,Date.now()+600000);return target;}
  async relinkSource(id:string,newPath:string){
    const old=this.db.prepare('SELECT * FROM sources WHERE id=?').get(id) as Row|undefined;if(!old)throw new Error('文件夹不存在');this.assertSourceCanChange(old.path,newPath);
    const actual=await fs.realpath(newPath);if(!(await fs.stat(actual)).isDirectory())throw new Error('请选择文件夹');
    this.assertSourceCanChange(old.path,actual);this.cancelScan();await this.waitForIdle();this.assertSourceCanChange(old.path,actual);
    const duplicate=this.db.prepare('SELECT id FROM sources WHERE path_key=? AND id<>?').get(pathKey(actual),id);if(duplicate)throw new Error('该文件夹已在图库中');
    this.db.exec('BEGIN');try{const rows=this.db.prepare('SELECT id,path FROM media WHERE source_id=?').all(id) as Row[];for(const row of rows){const relative=path.relative(old.path,row.path);if(relative.startsWith('..'))continue;const file=path.join(actual,relative);this.db.prepare('UPDATE media SET path=?,path_key=?,missing=1 WHERE id=?').run(file,pathKey(file),row.id);}this.db.prepare("UPDATE sources SET path=?,path_key=?,name=?,status='online' WHERE id=?").run(actual,pathKey(actual),path.basename(actual)||actual,id);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
    await this.watchers.get(id)?.close();this.watchers.delete(id);await this.watch({id,path:actual});this.emit('library',true);this.rescan(id);
  }
  setSettings(partial:Partial<Settings>){
    const next={...this.settings};
    if(partial.view==='wall'||partial.view==='grid')next.view=partial.view;
    if(partial.fit==='contain'||partial.fit==='cover')next.fit=partial.fit;
    if(partial.sizingMode==='balanced'||partial.sizingMode==='views'||partial.sizingMode==='recent'||partial.sizingMode==='bytes')next.sizingMode=partial.sizingMode;
    if(typeof partial.focusTint==='boolean')next.focusTint=partial.focusTint;
    if(partial.lighting==='light'||partial.lighting==='dim')next.lighting=partial.lighting;
    if(typeof partial.sidebarOpen==='boolean')next.sidebarOpen=partial.sidebarOpen;
    for(const [key,min,max] of [['seed',0,2147483647],['gap',0,40],['thumbSize',80,600]] as const){const value=partial[key];if(typeof value==='number'&&Number.isFinite(value))next[key]=Math.max(min,Math.min(max,value));}
    if(partial.lastSelectedId===null||typeof partial.lastSelectedId==='string')next.lastSelectedId=partial.lastSelectedId;
    if(partial.camera&&[partial.camera.x,partial.camera.y,partial.camera.scale].every(n=>typeof n==='number'&&Number.isFinite(n)))next.camera={x:partial.camera.x,y:partial.camera.y,scale:Math.max(.1,Math.min(5,partial.camera.scale))};
    this.settings=next;this.db.prepare("INSERT INTO settings(key,value) VALUES('preferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next));this.emit('settings');
  }
  getPath(id:string){return this.mediaRow(id).path as string;}
  recordOpen(id:string){this.mediaRow(id);this.db.prepare('UPDATE media SET open_count=open_count+1,last_opened_at=? WHERE id=?').run(Date.now(),id);this.emit('library',true);}
  async resolveMedia(id:string,variant:string):Promise<{path:string;mime:string}>{
    if(!['original','thumbnail','preview','playable'].includes(variant))throw new Error('未知媒体类型');const row=this.mediaRow(id);
    if(variant==='original')return row.kind==='image'&&await isHeif(row.path)?{path:await this.analysisImage(id,true),mime:'image/webp'}:{path:row.path,mime:mimeFor(row.path)};
    const file=this.cachePath(row,variant as 'thumbnail'|'preview'|'playable');
    // A redirected-volume copy is published only after its writer has fully completed.
    if(variant==='playable')await this.videoJobs.get(id)?.promise;
    else await this.previews.get(file);
    if(!existsSync(file)){
      if(variant==='playable')throw new Error('播放副本未生成');
      if(row.missing)throw new Error('原文件暂时不可用');
      await this.ensureThumbnail(row,variant as 'thumbnail'|'preview');
    }
    this.protectedCache.set(file,Date.now()+120000);fs.utimes(file,new Date(),new Date()).catch(()=>{});return {path:file,mime:mimeFor(file)};
  }
  async prepareVideo(id:string):Promise<string>{
    const row=this.mediaRow(id);if(row.kind!=='video')return this.url(row,'original');if(row.missing)throw new Error('原视频暂时不可用');
    const target=this.cachePath(row,'playable');const existing=this.videoJobs.get(id);if(existing)return existing.promise;
    if(existsSync(target))return this.url(row,'playable');
    const abort=new AbortController();const job=this.job({id,type:'video',status:'running',label:`准备播放：${row.file_name}`,done:0,total:row.duration??0});let lastUpdate=0;
    const promise=this.runMedia(()=>makeVideoProxy(row.path,target,this.options.binaries,row.duration,abort.signal,seconds=>{job.done=seconds;if(Date.now()-lastUpdate>400){this.emit('progress');lastUpdate=Date.now();}}),abort.signal).then(async()=>{job.status='complete';job.done=job.total;this.emit('progress');this.protectedCache.set(target,Date.now()+120000);await this.pruneCache(target);return this.url(row,'playable');}).catch(error=>{job.status=abort.signal.aborted?'cancelled':'error';job.error=error.message;this.emit('progress');throw error;}).finally(()=>this.videoJobs.delete(id));
    this.videoJobs.set(id,{abort,promise});return promise;
  }
  cancelVideo(id:string){this.videoJobs.get(id)?.abort.abort();}
  private async pruneCache(protect?:string){
    await cleanOrphanMediaTemps(this.cacheDir);
    const entries=await fs.readdir(this.cacheDir,{withFileTypes:true});const files=[] as {path:string;size:number;time:number}[];let total=0;
    for(const entry of entries){if(!entry.isFile()||entry.name.includes('.partial.')||entry.name.includes('.tmp.'))continue;const file=path.join(this.cacheDir,entry.name);try{const stat=await fs.stat(file);total+=stat.size;files.push({path:file,size:stat.size,time:stat.mtimeMs});}catch{}}
    const limit=this.options.cacheBudget??5*1024**3;
    const now=Date.now();for(const [file,until]of this.protectedCache)if(until<now)this.protectedCache.delete(file);
    for(const item of files.sort((a,b)=>a.time-b.time)){if(total<=limit)break;if(item.path===protect||this.previews.has(item.path)||this.protectedCache.has(item.path))continue;try{await fs.unlink(item.path);total-=item.size;}catch{}}
  }
  async close(){if(this.closed)return;this.closed=true;this.cancelScan();for(const job of this.videoJobs.values())job.abort.abort();if(this.changedTimer)clearTimeout(this.changedTimer);for(const timer of this.watchTimers.values())clearTimeout(timer);await this.receiver.close();await this.discovery.close();await this.phone.close();await this.intelligence.close();await Promise.all([...this.watchers.values()].map(watcher=>watcher.close()));await this.waitForIdle();await Promise.allSettled([...this.videoJobs.values()].map(job=>job.promise));await Promise.allSettled([...this.previews.values()]);this.db.close();}
}
