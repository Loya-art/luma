import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { DatabaseSync } from 'node:sqlite';
import type { PhoneDevice, PhoneImportJob, PhoneImportRequest, PhoneScan, PhoneScanIssue, PhoneState } from '../src/shared/phone';

type Row = Record<string, any>;
export interface AdbResult { stdout: Buffer; stderr: string }
export interface AdbTransport { run(args: string[], options?: { timeout?: number; signal?: AbortSignal; maxBytes?: number; onStdout?: (chunk: Buffer) => void }): Promise<AdbResult> }
export interface PhoneAlias { localPath: string; sourcePath: string; deviceId: string; deviceName: string }
export interface PhoneServiceOptions {
  dataDir: string; db: DatabaseSync; adbPath: string; onChange?: () => void;
  onImported?: (root: string) => Promise<void>; transport?: AdbTransport;
}
const extensions = ['jpg','jpeg','jfif','png','webp','avif','gif','tif','tiff','bmp','heic','heif','mp4','mov','m4v','mkv','avi','webm','3gp','m2ts','mts'];
const videoExtensions = new Set(['.mp4','.mov','.m4v','.mkv','.avi','.webm','.3gp','.m2ts','.mts']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const parse = <T>(value: string): T => JSON.parse(value) as T;
const disconnectError = (message: string) => /device.*(?:offline|not found)|no devices|disconnected|connection.*(?:closed|reset)|transport.*(?:closed|error)|closed|cannot connect|无法连接/i.test(message);
export const quoteRemote = (value: string) => `'${value.replace(/'/g, `'\"'\"'`)}'`;
export function safePhoneSegment(value: string): string {
  let result = Array.from(value.normalize('NFC')).slice(0, 90).join('').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '');
  if (!result || result === '.' || result === '..') result = '_';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = `_${result}`;
  if (result !== value) {
    const ext = path.extname(result); result = `${result.slice(0, result.length - ext.length)}~${hash(value).slice(0, 8)}${ext}`;
  }
  return result;
}
export function phoneRelativePath(remote: string): string {
  if (!remote.startsWith('/') || remote.includes('\0') || remote.split('/').some(part => part === '..' || part === '.')) throw new Error('手机文件路径无效');
  let parts = remote.split('/').filter(Boolean);
  if (remote.startsWith('/storage/emulated/0/')) parts = ['内部存储', ...parts.slice(3)];
  else if (remote.startsWith('/sdcard/')) parts = ['内部存储', ...parts.slice(1)];
  else if (remote.startsWith('/storage/')) parts = ['存储卡', ...parts.slice(1)];
  else throw new Error('只允许导入手机共享存储中的文件');
  return path.join(...parts.map(safePhoneSegment));
}
export function phoneFolderRecommendation(folder: string): { recommended: boolean; exclusionReason?: string } {
  if (/(?:^|\/)(?:cache|caches|\.cache|\.watermark|lensEffectRes|widgets?)(?:\/|$)/i.test(folder) || /\/shopSdk\/(?:image|images)(?:\/|$)/i.test(folder)) return { recommended: false, exclusionReason: '应用缓存或界面素材，默认不勾选；需要时可手动选择' };
  if (/(?:^|\/)\.gs(?:_fs\d+)?(?:\/|$)/i.test(folder)) return { recommended: false, exclusionReason: '应用占位文件目录，默认不勾选；需要时可手动选择' };
  return { recommended: true };
}
const within = (child: string, root: string) => { const rel = path.relative(root, child); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
async function fileHash(file: string) { const sum = createHash('sha256'); for await (const block of createReadStream(file)) sum.update(block); return sum.digest('hex'); }

async function ensureDirectoryWithin(directory: string, root: string) {
  if (!within(directory, root)) throw new Error('保存路径超出选定文件夹');
  let current = root;
  for (const segment of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { await fs.mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!(await fs.stat(current)).isDirectory() || !within(await fs.realpath(current), root)) throw new Error('保存路径包含指向其他位置的目录链接');
  }
}

// NTFS publication uses an exclusive link; exFAT does not support links, so use
// .NET's same-volume, non-overwriting File.Move instead of copying into a visible
// image filename. https://learn.microsoft.com/dotnet/api/system.io.file.move
export async function publishPhoneFile(temporary: string, target: string) {
  let linked = false;
  try { await fs.link(temporary, target); linked = true; }
  catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
  if (linked) { await fs.rm(temporary, { force: true }).catch(() => {}); return; }
  const encodedPath = (value: string) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString('base64')}'))`;
  const script = `$ErrorActionPreference='Stop'; [IO.File]::Move(${encodedPath(temporary)},${encodedPath(target)})`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let detail = ''; const timeout = setTimeout(() => child.kill(), 30000);
    child.stderr.on('data', chunk => { detail = (detail + chunk.toString('utf8')).slice(-2000); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(detail.trim() || '保存原件失败，请检查目标磁盘后继续')); });
  });
}

// ADB pairing/pull/shell are documented at https://developer.android.com/tools/adb.
// Never invoke a local shell, and keep this app's ADB server separate from emulator tools.
export class ProcessAdbTransport implements AdbTransport {
  constructor(private executable: string) {}
  run(args: string[], options: { timeout?: number; signal?: AbortSignal; maxBytes?: number; onStdout?: (chunk: Buffer) => void } = {}): Promise<AdbResult> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) { reject(new Error('已暂停')); return; }
      const environment: NodeJS.ProcessEnv = { ...process.env, ADB_SERVER_PORT: '5038' };
      delete environment.ADB_SERVER_SOCKET;
      delete environment.ANDROID_ADB_SERVER_PORT;
      const child = spawn(this.executable, ['-H', '127.0.0.1', '-P', '5038', ...args], { windowsHide: true, stdio: ['ignore','pipe','pipe'], env: environment });
      const chunks: Buffer[] = []; let stderr = '', bytes = 0, failure: Error | undefined;
      const abort = () => { failure = new Error('已暂停'); child.kill(); };
      const timer = setTimeout(() => { failure = new Error('手机操作超时，请检查连接后重试'); child.kill(); }, options.timeout ?? 30000);
      options.signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > (options.maxBytes ?? 64 * 1024 * 1024)) { failure = new Error('扫描结果过大，请分批选择手机文件夹'); child.kill(); } else { chunks.push(chunk); try { options.onStdout?.(chunk); } catch(error) { failure = error instanceof Error ? error : new Error(String(error)); child.kill(); } } });
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-32768); });
      child.on('error', error => { failure = error; });
      child.on('close', code => {
        clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
        if (failure) reject(failure); else if (code !== 0) reject(new Error(stderr.trim() || Buffer.concat(chunks).toString('utf8').trim() || `ADB 操作失败 (${code})`));
        else resolve({ stdout: Buffer.concat(chunks), stderr });
      });
    });
  }
}

export class PhoneService {
  private db: DatabaseSync; private transport: AdbTransport;
  private devices: PhoneDevice[] = []; private scanning = false; private closed = false;
  private active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private scanController?: AbortController;
  private scanFinished?: Promise<void>;
  private scanProgress?: PhoneState['scanProgress'];
  constructor(private options: PhoneServiceOptions) {
    this.db = options.db; this.transport = options.transport ?? new ProcessAdbTransport(options.adbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS phone_scans(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS phone_scan_files(scan_id TEXT NOT NULL,path TEXT NOT NULL,size INTEGER NOT NULL,mtime INTEGER NOT NULL,folder TEXT NOT NULL,PRIMARY KEY(scan_id,path));
      CREATE TABLE IF NOT EXISTS phone_jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS phone_job_files(job_id TEXT NOT NULL,source_path TEXT NOT NULL,size INTEGER NOT NULL,mtime INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',local_path TEXT,sha256 TEXT,error TEXT,PRIMARY KEY(job_id,source_path));
      CREATE TABLE IF NOT EXISTS phone_manifest(device_id TEXT NOT NULL,source_path TEXT NOT NULL,device_name TEXT NOT NULL,size INTEGER NOT NULL,mtime INTEGER NOT NULL,local_path TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(device_id,source_path));
      CREATE INDEX IF NOT EXISTS phone_manifest_hash ON phone_manifest(sha256);
    `);
  }
  async initialize() {
    this.db.prepare("UPDATE phone_job_files SET status='pending' WHERE status='copying'").run();
    for (const job of this.jobs()) {
      this.refreshCounts(job);
      if (job.status === 'running' || job.status === 'queued') { job.status = 'paused'; job.currentFile = undefined; job.error = '上次导入已暂停，连接同一手机后可继续'; }
      this.save(job);
    }
  }
  private jobs() { return (this.db.prepare('SELECT data FROM phone_jobs ORDER BY rowid DESC').all() as Row[]).map(row => parse<PhoneImportJob>(row.data)); }
  private job(id: string) { const row = this.db.prepare('SELECT data FROM phone_jobs WHERE id=?').get(id) as Row | undefined; if (!row) throw new Error('导入任务不存在'); return parse<PhoneImportJob>(row.data); }
  private save(job: PhoneImportJob) { job.updatedAt = Date.now(); this.db.prepare('INSERT INTO phone_jobs(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.id, JSON.stringify(job)); this.options.onChange?.(); }
  private refreshCounts(job: PhoneImportJob) {
    const rows = this.db.prepare('SELECT status,COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM phone_job_files WHERE job_id=? GROUP BY status').all(job.id) as Row[];
    job.done = 0; job.imported = 0; job.skipped = 0; job.failed = 0; job.transferredBytes = 0;
    for (const row of rows) {
      if (row.status === 'done') { job.done += row.count; job.imported += row.count; job.transferredBytes += row.bytes; }
      else if (row.status === 'skipped') { job.done += row.count; job.skipped += row.count; }
      else if (row.status === 'error') job.failed += row.count;
    }
    job.issues = (this.db.prepare("SELECT source_path,error FROM phone_job_files WHERE job_id=? AND status='error' ORDER BY source_path LIMIT 1000").all(job.id) as Row[]).map(row => ({ path: row.source_path, message: row.error || '导入未完成' }));
  }
  getState(): PhoneState { return { available: !!this.options.transport || existsSync(this.options.adbPath), scanning: this.scanning, scanProgress:this.scanProgress, devices: this.devices, jobs: this.jobs().slice(0, 30) }; }
  getAliases(): PhoneAlias[] { return (this.db.prepare('SELECT local_path,source_path,device_id,device_name FROM phone_manifest').all() as Row[]).map(row => ({ localPath:row.local_path,sourcePath:row.source_path,deviceId:row.device_id,deviceName:row.device_name })); }
  private async shell(serial: string, script: string, signal?: AbortSignal, timeout?: number) { return this.transport.run(['-s',serial,'shell',script],{signal,timeout}); }
  private validateAddress(address: string) { if (!/^(?:[a-zA-Z0-9][a-zA-Z0-9.\-]*|\[[0-9a-fA-F:]+\]):\d{1,5}$/.test(address) || +address.slice(address.lastIndexOf(':')+1) > 65535 || +address.slice(address.lastIndexOf(':')+1) < 1) throw new Error('请输入手机显示的 IP 地址和端口，例如 192.168.1.8:37123'); }
  async pair(address: string, code: string) { this.validateAddress(address); if (!/^\d{6}$/.test(code)) throw new Error('请输入手机显示的 6 位配对码'); const result = await this.transport.run(['pair',address,code]); if (!/successfully paired/i.test(result.stdout.toString())) throw new Error('配对没有完成，请重新打开手机上的配对窗口'); }
  async connect(address: string) { this.validateAddress(address); const result = await this.transport.run(['connect',address]); if (!/(?:connected to|already connected to)/i.test(result.stdout.toString())) throw new Error(result.stdout.toString().trim() || '连接没有完成'); await this.listDevices(); }
  async listDevices(): Promise<PhoneDevice[]> {
    const result = await this.transport.run(['devices','-l']); const list: PhoneDevice[] = [];
    for (const line of result.stdout.toString('utf8').split(/\r?\n/)) {
      const match = /^(\S+)\s+(device|offline|unauthorized)(?:\s+(.*))?$/.exec(line); if (!match) continue;
      const [,serial,state,properties=''] = match; const name = /model:(\S+)/.exec(properties)?.[1]?.replace(/_/g,' ') || serial;
      let identity = serial, version: string | undefined, deviceName = name;
      if (state === 'device') {
        try {
          const info = (await this.shell(serial, "getprop ro.serialno; getprop ro.boot.serialno; settings get secure android_id; getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.build.version.release")).stdout.toString('utf8').replace(/\r/g,'').split('\n');
          const candidates = info.slice(0,3).map(v => v.trim()).filter(v => v && v !== 'null' && v !== 'unknown');
          identity = candidates[0] || serial; deviceName = [info[3],info[4]].filter(Boolean).join(' ').trim() || name; version = info[5]?.trim();
        } catch { /* Keep unauthorized/offline information available for the connection UI. */ }
      }
      list.push({ id: `android-${hash(identity).slice(0,24)}`, serial, name:deviceName, state:state as PhoneDevice['state'], connection: serial.includes(':') || serial.includes('_adb-tls-') ? 'wireless':'usb', androidVersion:version });
    }
    // A phone connected over USB and Wi-Fi is the same device; prefer USB for large imports.
    this.devices = [...new Map(list.sort((a,b) => Number(b.connection === 'usb') - Number(a.connection === 'usb')).reverse().map(device => [device.id,device])).values()];
    this.options.onChange?.(); return this.devices;
  }
  private async connected(id: string) { const device = (await this.listDevices()).find(item => item.id === id); if (!device || device.state !== 'device') throw new Error('无法连接到这台手机，请解锁手机并重新连接'); return device; }
  async scan(deviceId: string): Promise<PhoneScan> {
    if (this.closed) throw new Error('手机服务已关闭');
    if (this.scanning) throw new Error('正在扫描手机，请稍候');
    const controller = new AbortController(); this.scanController = controller;
    let finish!: () => void; this.scanFinished = new Promise(resolve => { finish = resolve; });
    this.scanning = true; this.scanProgress={count:0,bytes:0}; this.options.onChange?.();
    try {
      const device = await this.connected(deviceId), id = randomUUID();
      const rootsResult = await this.shell(device.serial, "printf '%s\\0' /storage/emulated/0; for d in /storage/*; do case \"$d\" in /storage/emulated|/storage/self) ;; *) [ -d \"$d\" ] && printf '%s\\0' \"$d\" ;; esac; done", controller.signal);
      const roots = [...new Set(rootsResult.stdout.toString('utf8').split('\0').filter(root => /^\/storage\/(?:emulated\/0|[A-Za-z0-9_-]+)$/.test(root)))];
      const issues: PhoneScanIssue[] = [], folders = new Map<string,{path:string;name:string;count:number;bytes:number}>(); let count=0, bytes=0;
      const insert = this.db.prepare('INSERT OR IGNORE INTO phone_scan_files(scan_id,path,size,mtime,folder) VALUES(?,?,?,?,?)');
      // Toybox supports NUL-separated native metadata, avoiding one remote stat
      // subprocess per photo. Probe rather than assume this on older Androids.
      let nativeMetadata=false;
      try{const probe=await this.shell(device.serial,"find /dev/null -maxdepth 0 -printf '%p\\0%s %T@\\0'",controller.signal);nativeMetadata=/^\/dev\/null\x00\d+\s+-?\d+(?:\.\d+)?\x00$/.test(probe.stdout.toString('utf8'));}catch(error){if(controller.signal.aborted||disconnectError(errorText(error)))throw error;}
      let lastProgress=0;
      for (const root of roots) {
        const skip = [`${root}/Android/data`,`${root}/Android/obb`];
        const exclusions = skip.map(file => `-path ${quoteRemote(file)}`).concat(["-iname '.thumbnails'","-iname '.trash*'","-iname '.recycle*'"]).join(' -o ');
        const media = extensions.map(ext => `-iname '*.${ext}'`).join(' -o ');
        const expression = `find ${quoteRemote(root)} \\( -type d \\( ${exclusions} \\) \\) -prune -o \\( -type f ! -iname '.trashed-*' ! -iname '.pending-*' \\( ${media} \\) \\)`;
        const script = nativeMetadata ? `${expression} -printf '%p\\0%s %T@\\0'` : `${expression} -print0 | while IFS= read -r -d '' f; do meta=$(stat -c '%s %Y' -- "$f") && printf '%s\\0%s\\0' "$f" "$meta"; done`;
        const decoder=new StringDecoder('utf8');let buffered='',pendingPath:string|undefined,streamed=false;
        const consume=(text:string)=>{
          buffered+=text;this.db.exec('BEGIN');
          try{
            let separator:number;
            while((separator=buffered.indexOf('\0'))>=0){
              const token=buffered.slice(0,separator);buffered=buffered.slice(separator+1);
              if(pendingPath===undefined){pendingPath=token;continue;}
              const remote=pendingPath;pendingPath=undefined;const stat=/^(\d+)\s+(-?\d+(?:\.\d+)?)$/.exec(token);
              if(!stat||!remote.startsWith(root+'/')){issues.push({path:remote||root,message:'文件信息无法读取，未计入可导入数量'});continue;}
              const size=Number(stat[1]),mtime=Math.trunc(Number(stat[2]));if(!Number.isSafeInteger(size)||!Number.isSafeInteger(mtime)||size<0)continue;
              try{phoneRelativePath(remote);}catch{issues.push({path:remote,message:'手机文件路径无效，未计入可导入数量'});continue;}
              const folder=path.posix.dirname(remote);if(!insert.run(id,remote,size,mtime,folder).changes)continue;
              const entry=folders.get(folder)??{path:folder,name:path.posix.basename(folder),count:0,bytes:0};entry.count++;entry.bytes+=size;folders.set(folder,entry);count++;bytes+=size;
              this.scanProgress={count,bytes,folder};
            }
            this.db.exec('COMMIT');
          }catch(error){this.db.exec('ROLLBACK');throw error;}
          if(Date.now()-lastProgress>200){lastProgress=Date.now();this.options.onChange?.();}
        };
        try {
          const result = await this.transport.run(['-s',device.serial,'shell',script],{signal:controller.signal,timeout:10*60*1000,onStdout:chunk=>{streamed=true;consume(decoder.write(chunk));}});
          if(!streamed)consume(decoder.write(result.stdout));consume(decoder.end());
          if (result.stderr.trim()) issues.push({ path:root, message:`部分目录无法读取：${result.stderr.trim().slice(0,2000)}` });
          if(buffered||pendingPath!==undefined)issues.push({path:root,message:'扫描输出末尾不完整，部分文件未计入数量，请重新扫描'});
        } catch(error) { if(controller.signal.aborted||disconnectError(errorText(error)))throw error;issues.push({path:root,message:errorText(error)}); }
      }
      const scan: PhoneScan = { id,device,folders:[...folders.values()].map(folder=>({...folder,...phoneFolderRecommendation(folder.path)})).sort((a,b)=>a.path.localeCompare(b.path)),count,bytes,issues,createdAt:Date.now(),notes:['只统计本机可读取的照片与视频；云相册原图需要先下载到手机。','应用私有目录、回收站和缩略图缓存未扫描；请先在对应应用中导出需要保存的原图。','应用缓存和占位目录列出但默认不勾选，可以手动选择；导入只复制文件，不同步删除原件。'] };
      this.db.prepare('INSERT INTO phone_scans(id,data) VALUES(?,?)').run(id,JSON.stringify(scan)); return scan;
    } finally {this.scanning=false;this.scanController=undefined;finish();this.options.onChange?.();}
  }
  async startImport(request: PhoneImportRequest): Promise<string> {
    if (this.closed) throw new Error('手机服务已关闭');
    const row=this.db.prepare('SELECT data FROM phone_scans WHERE id=?').get(request.scanId) as Row|undefined;if(!row)throw new Error('扫描结果不存在，请重新扫描');
    const scan=parse<PhoneScan>(row.data); const destination=path.resolve(request.destination);
    if(!path.isAbsolute(request.destination)||destination===path.parse(destination).root)throw new Error('请选择磁盘中的一个文件夹保存照片');
    const selected=request.folderPaths?new Set(request.folderPaths):null;
    if(selected && [...selected].some(folder=>!scan.folders.some(item=>item.path===folder)))throw new Error('选择的手机文件夹不在本次扫描结果中');
    const entries=(this.db.prepare('SELECT * FROM phone_scan_files WHERE scan_id=? ORDER BY path').all(scan.id) as Row[]).filter(file=>!selected||selected.has(file.folder));
    if(!entries.length)throw new Error('没有选择可导入的照片或视频');
    await fs.mkdir(destination,{recursive:true});const resolved=await fs.realpath(destination);
    const totalBytes=entries.reduce((sum,file)=>sum+file.size,0);
    let expectedBytes=0;
    for (const file of entries) {
      const previous=this.db.prepare('SELECT size,mtime,local_path,sha256 FROM phone_manifest WHERE device_id=? AND source_path=?').get(scan.device.id,file.path) as Row|undefined;
      if (!previous || !within(previous.local_path,resolved) || previous.size!==file.size || previous.mtime!==file.mtime || !await this.verifyLocal(previous.local_path,previous.sha256,file.size)) expectedBytes+=file.size;
    }
    await this.checkSpace(resolved,expectedBytes);
    const existing=this.jobs().find(job=>job.deviceId===scan.device.id && (job.status==='running'||job.status==='queued'));
    if(existing)throw new Error('这台手机已有导入任务，请等待完成或先暂停');
    const job:PhoneImportJob={id:randomUUID(),deviceId:scan.device.id,deviceName:scan.device.name,destination:resolved,status:'queued',total:entries.length,done:0,imported:0,skipped:0,failed:0,totalBytes,transferredBytes:0,issues:[],createdAt:Date.now(),updatedAt:Date.now()};
    this.db.exec('BEGIN');try{const insert=this.db.prepare('INSERT INTO phone_job_files(job_id,source_path,size,mtime,status) VALUES(?,?,?,?,?)');for(const file of entries)insert.run(job.id,file.path,file.size,file.mtime,'pending');this.db.prepare('INSERT INTO phone_jobs(id,data) VALUES(?,?)').run(job.id,JSON.stringify(job));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
    this.launch(job.id);return job.id;
  }
  pause(id:string){const job=this.job(id);if(job.status!=='running'&&job.status!=='queued')return;job.status='paused';job.currentFile=undefined;job.error=undefined;this.save(job);this.active.get(id)?.controller.abort();}
  async resume(id:string){if(this.closed)throw new Error('手机服务已关闭');await this.active.get(id)?.task;const job=this.job(id);if(job.status==='complete')return;if(this.jobs().some(other=>other.id!==id&&other.deviceId===job.deviceId&&['queued','running'].includes(other.status)))throw new Error('这台手机已有导入任务，请先暂停或等待完成');await this.connected(job.deviceId);this.db.prepare("UPDATE phone_job_files SET status='pending',error=NULL WHERE job_id=? AND status IN ('error','copying')").run(id);this.refreshCounts(job);job.status='queued';job.error=undefined;this.save(job);this.launch(id);}
  private launch(id:string){if(this.active.has(id)||this.closed)return;const controller=new AbortController();const task=this.perform(id,controller.signal).finally(()=>this.active.delete(id));this.active.set(id,{controller,task});}
  private async checkSpace(destination:string,bytes:number){if(bytes===0)return;const stats=await fs.statfs(destination);const free=Number(stats.bavail)*Number(stats.bsize);if(free<bytes+64*1024*1024)throw new Error(`保存位置空间不足：还需约 ${Math.ceil(bytes/1024/1024)} MB，请选择其他磁盘`);}
  private async remoteStat(serial:string,remote:string,signal:AbortSignal){const result=await this.shell(serial,`stat -c '%s %Y' -- ${quoteRemote(remote)}`,signal);const match=/^(\d+)\s+(-?\d+)\s*$/.exec(result.stdout.toString());if(!match)throw new Error('无法读取手机文件信息');return {size:Number(match[1]),mtime:Number(match[2])};}
  private async remoteHash(serial:string,remote:string,signal:AbortSignal){const result=await this.shell(serial,`sha256sum ${quoteRemote(remote)}`,signal,120000);const match=/^\\?([a-fA-F0-9]{64})\s/.exec(result.stdout.toString());if(!match)throw new Error('手机无法提供 SHA-256 校验结果，未将该文件标记为备份成功');return match[1].toLowerCase();}
  private async validateSnapshot(serial:string,remote:string,before:{size:number;mtime:number},checksum:string,signal:AbortSignal){const after=await this.remoteStat(serial,remote,signal);if(after.size!==before.size||after.mtime!==before.mtime||await this.remoteHash(serial,remote,signal)!==checksum)throw new Error('传输过程中手机文件发生变化，请重新扫描');}
  private async verifyLocal(file:string,sha256:string,size:number){try{const stat=await fs.lstat(file);return stat.isFile()&&!stat.isSymbolicLink()&&stat.size===size&&await fileHash(file)===sha256;}catch{return false;}}
  private async targetPath(job:PhoneImportJob,remote:string,sha:string){
    const deviceFolder=`${safePhoneSegment(job.deviceName)}-${job.deviceId.slice(-6)}`;let target=path.resolve(job.destination,deviceFolder,phoneRelativePath(remote));
    if(!within(target,job.destination))throw new Error('保存路径超出选定文件夹');
    // Protect every existing parent from following a junction out of the chosen destination.
    await ensureDirectoryWithin(path.dirname(target),job.destination);
    if(existsSync(target)){if(await this.verifyLocal(target,sha,(await fs.stat(target)).size))return target;const ext=path.extname(target),stem=target.slice(0,target.length-ext.length);target=`${stem}~${sha.slice(0,12)}${ext}`;let suffix=1;while(existsSync(target)&&!(await this.verifyLocal(target,sha,(await fs.stat(target)).size)))target=`${stem}~${sha.slice(0,12)}-${suffix++}${ext}`;}
    return target;
  }
  private async perform(id:string,signal:AbortSignal){
    let job=this.job(id),importSinceNotify=0,lastNotify=Date.now();
    const notifyRoots = new Set<string>();
    const pendingNotify=async()=>{if(importSinceNotify){for(const root of notifyRoots)await this.options.onImported?.(root);notifyRoots.clear();importSinceNotify=0;lastNotify=Date.now();}};
    try{
      const device=await this.connected(job.deviceId);this.refreshCounts(job);job.status='running';job.error=undefined;this.save(job);
      const files=(this.db.prepare("SELECT * FROM phone_job_files WHERE job_id=? AND status NOT IN ('done','skipped') ORDER BY source_path").all(id) as Row[]).sort((a,b)=>Number(videoExtensions.has(path.posix.extname(a.source_path).toLowerCase()))-Number(videoExtensions.has(path.posix.extname(b.source_path).toLowerCase())));
      const staging=path.join(job.destination,'.shiguang-staging',id);await ensureDirectoryWithin(staging,job.destination);
      for(const file of files){
        if(signal.aborted)break;job.currentFile=path.posix.basename(file.source_path);this.save(job);
        const temporary=path.join(staging,`${hash(file.source_path)}.partial`);
        try{
          this.db.prepare("UPDATE phone_job_files SET status='copying',error=NULL WHERE job_id=? AND source_path=?").run(id,file.source_path);
          const before=await this.remoteStat(device.serial,file.source_path,signal);if(before.size!==file.size||before.mtime!==file.mtime)throw new Error('手机文件在扫描后发生变化，请重新扫描后导入');
          const checksum=await this.remoteHash(device.serial,file.source_path,signal);
          let localPath:string|undefined,skipped=false,sourceValidated=false;
          const previous=this.db.prepare('SELECT local_path,sha256 FROM phone_manifest WHERE device_id=? AND source_path=?').get(job.deviceId,file.source_path) as Row|undefined;
          if(previous?.sha256===checksum && within(previous.local_path,job.destination) && await this.verifyLocal(previous.local_path,checksum,file.size)){localPath=previous.local_path;skipped=true;}
          if(!localPath){for(const same of this.db.prepare('SELECT DISTINCT local_path FROM phone_manifest WHERE sha256=?').all(checksum) as Row[]){if(within(same.local_path,job.destination)&&await this.verifyLocal(same.local_path,checksum,file.size)){localPath=same.local_path;skipped=true;break;}}}
          if(!localPath){
            await this.checkSpace(job.destination,file.size);localPath=await this.targetPath(job,file.source_path,checksum);
            if(await this.verifyLocal(localPath,checksum,file.size))skipped=true;
            else{
              await fs.rm(temporary,{force:true});
              await this.transport.run(['-s',device.serial,'pull','-a',file.source_path,temporary],{signal,timeout:Math.max(120000,Math.ceil(file.size/(256*1024))*1000),maxBytes:1024*1024});
              if(!(await this.verifyLocal(temporary,checksum,file.size)))throw new Error('传输校验失败，未保存不完整文件；可继续任务重试');
              await this.validateSnapshot(device.serial,file.source_path,before,checksum,signal);sourceValidated=true;
              if(existsSync(localPath)){if(!(await this.verifyLocal(localPath,checksum,file.size)))throw new Error('保存位置出现同名文件，未覆盖，请重新扫描后重试');await fs.rm(temporary,{force:true});skipped=true;}
              else{await publishPhoneFile(temporary,localPath);await fs.utimes(localPath,new Date(file.mtime*1000),new Date(file.mtime*1000));}
            }
          }
          if(!sourceValidated)await this.validateSnapshot(device.serial,file.source_path,before,checksum,signal);
          this.db.exec('BEGIN');try{
            this.db.prepare('INSERT INTO phone_manifest(device_id,source_path,device_name,size,mtime,local_path,sha256) VALUES(?,?,?,?,?,?,?) ON CONFLICT(device_id,source_path) DO UPDATE SET device_name=excluded.device_name,size=excluded.size,mtime=excluded.mtime,local_path=excluded.local_path,sha256=excluded.sha256').run(job.deviceId,file.source_path,job.deviceName,file.size,file.mtime,localPath,checksum);
            this.db.prepare('UPDATE phone_job_files SET status=?,local_path=?,sha256=?,error=NULL WHERE job_id=? AND source_path=?').run(skipped?'skipped':'done',localPath,checksum,id,file.source_path);this.db.exec('COMMIT');
          }catch(error){this.db.exec('ROLLBACK');throw error;}
          job.done++;if(skipped)job.skipped++;else{job.imported++;job.transferredBytes+=file.size;}importSinceNotify++;notifyRoots.add(within(localPath,job.destination)?job.destination:path.dirname(localPath));this.save(job);
          if(importSinceNotify>=25||Date.now()-lastNotify>5000)await pendingNotify();
        }catch(error){
          await fs.rm(temporary,{force:true}).catch(()=>{});const message=errorText(error);const retryable=signal.aborted||disconnectError(message)||/ENOSPC|空间不足|超时/.test(message);this.db.prepare("UPDATE phone_job_files SET status=?,error=? WHERE job_id=? AND source_path=?").run(retryable?'pending':'error',message,id,file.source_path);
          if(signal.aborted)break;
          if(disconnectError(message)||/ENOSPC|空间不足|超时/.test(message)){job.status='paused';job.error=message;this.save(job);break;}
          this.refreshCounts(job);this.save(job);
        }
        await new Promise(resolve=>setImmediate(resolve));
      }
      await pendingNotify();if(!files.length)await this.options.onImported?.(job.destination);this.refreshCounts(job);job.currentFile=undefined;
      if(signal.aborted){job.status='paused';job.error=undefined;}
      else if(job.status!=='paused'){job.status=job.failed?'error':'complete';job.error=job.failed?`${job.failed} 个文件未完成，可继续重试或重新扫描`:undefined;}
      this.save(job);await fs.rmdir(staging).catch(()=>{});
    }catch(error){job.currentFile=undefined;job.status='paused';job.error=signal.aborted?undefined:errorText(error);this.save(job);await pendingNotify().catch(()=>{});}
  }
  async waitForIdle(){await Promise.all([...this.active.values()].map(item=>item.task));}
  async close(){this.closed=true;this.scanController?.abort();for(const item of this.active.values())item.controller.abort();await Promise.all([this.waitForIdle(),this.scanFinished]);}
}
