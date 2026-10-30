import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import QRCode from 'qrcode';
import { kindOf } from './media';
import { publishPhoneFile, safePhoneSegment } from './phone';
import { receivePage } from './receive-page';
import type { PhoneReceiveOptions, PhoneReceiveState, ReceivedFile } from '../src/shared/receive';

const within = (child: string, root: string) => { const relative = path.relative(root, child); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const empty = (): PhoneReceiveState => ({ active: false, addresses: [], received: 0, skipped: 0, failed: 0, bytes: 0, uploading: 0, files: [] });
const privateAddress = (input: string) => { const value = input.replace(/^::ffff:/, ''); return value === '::1' || /^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(value) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(value); };
async function digest(file: string) { const hash = createHash('sha256'); for await (const block of createReadStream(file)) hash.update(block); return hash.digest('hex'); }
async function safeDirectory(directory: string, root: string) {
  if (!within(directory, root)) throw new Error('保存路径无效');
  for (const part of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    root = path.join(root, part); await fs.mkdir(root).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(root); const normalize=(value:string)=>process.platform==='win32'?value.toLowerCase():value; if (!stat.isDirectory() || stat.isSymbolicLink() || normalize(path.resolve(await fs.realpath(root))) !== normalize(path.resolve(root))) throw new Error('保存路径包含目录链接');
  }
}

/** Explicit, temporary LAN receiver. No listener exists before start() is clicked.
 * Streaming HTTP body API: https://nodejs.org/api/http.html#class-httpincomingmessage
 */
export class PhoneReceiver {
  private server: http.Server | null = null; private token = ''; private timer: ReturnType<typeof setTimeout> | null = null;
  private state = empty(); private uploads = new Set<Promise<void>>(); private hosts = new Set<string>();
  private publication: Promise<unknown> = Promise.resolve(); private closed = false;
  private startTask:Promise<PhoneReceiveState>|null=null;private reservedBytes=0;
  constructor(private options: { db: DatabaseSync; onChange?: () => void; onImported?: (root: string) => Promise<void>; bindAddress?: string; sessionMs?: number; maxFileBytes?: number }) {
    options.db.exec('CREATE TABLE IF NOT EXISTS receive_files(sha256 TEXT NOT NULL,local_path TEXT NOT NULL,size INTEGER NOT NULL,received_at INTEGER NOT NULL,PRIMARY KEY(sha256,local_path)); CREATE TABLE IF NOT EXISTS receive_album_files(local_path TEXT NOT NULL,album_path TEXT NOT NULL,album_name TEXT NOT NULL,PRIMARY KEY(local_path,album_path))');
  }
  getAliases() { return this.options.db.prepare('SELECT local_path AS localPath,album_path AS albumPath,album_name AS albumName FROM receive_album_files').all() as Array<{localPath:string;albumPath:string;albumName:string}>; }
  getState(): PhoneReceiveState { return { ...this.state, addresses: this.state.addresses.map(item => ({ ...item })), files: this.state.files.map(item => ({ ...item })) }; }
  private notify() { this.options.onChange?.(); }
  async start(request: PhoneReceiveOptions): Promise<PhoneReceiveState> {
    if(this.startTask)throw new Error('正在开启无线接收，请稍候');
    const task=this.startSession(request);this.startTask=task;try{return await task;}finally{if(this.startTask===task)this.startTask=null;}
  }
  private async startSession(request: PhoneReceiveOptions): Promise<PhoneReceiveState> {
    if (this.closed) throw new Error('无线接收服务已关闭');
    if (!request || typeof request.destination !== 'string' || !path.isAbsolute(request.destination) || path.resolve(request.destination) === path.parse(path.resolve(request.destination)).root) throw new Error('请选择保存文件夹');
    if (typeof request.albumName !== 'string' || !request.albumName.trim() || request.albumName.length > 100) throw new Error('请输入相册名称');
    await this.stopNow(); await fs.mkdir(request.destination, { recursive: true }); const destination = await fs.realpath(request.destination);
    const albumName = safePhoneSegment(request.albumName.trim()); await safeDirectory(path.join(destination, albumName), destination);
    const staging=path.join(destination,'.shiguang-staging','wireless');await safeDirectory(staging,destination);
    // A previous process may have ended before its per-request finally block.
    // Only this receiver's regular UUID-named staging files are eligible.
    for(const name of await fs.readdir(staging)){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.partial$/i.test(name))continue;const file=path.join(staging,name);const stat=await fs.lstat(file);if(stat.isFile()&&!stat.isSymbolicLink())await fs.unlink(file);}
    const rank=(name:string)=>/vEthernet|VMware|VirtualBox|WSL|TAP|TUN|VPN|虚拟/i.test(name)?10:/Wi-Fi|WLAN|无线/i.test(name)?0:/Ethernet|以太网/i.test(name)?1:2;
    const addresses = this.options.bindAddress === '127.0.0.1' ? [{ name: '本机测试', address: '127.0.0.1' }] : Object.entries(os.networkInterfaces()).flatMap(([name, values]) => (values ?? []).filter(item => item.family === 'IPv4' && !item.internal && privateAddress(item.address)).map(item => ({ name, address: item.address }))).sort((a,b)=>rank(a.name)-rank(b.name));
    if (!addresses.length) throw new Error('没有找到局域网地址，请连接 Wi-Fi 或手机热点后重试');
    this.token = randomBytes(24).toString('hex'); this.state = { ...empty(), destination, albumName, active: true, expiresAt: Date.now() + (this.options.sessionMs ?? 2 * 60 * 60_000) };
    const server = this.server = http.createServer((req, res) => { const task = this.handle(req, res).catch(error => { if (!res.headersSent && !res.destroyed) this.reply(res, 400, { error: errorText(error) }); else res.destroy(); }).finally(() => this.uploads.delete(task)); this.uploads.add(task); });
    server.requestTimeout = 0; server.headersTimeout = 15000; server.maxConnections = 8;
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, this.options.bindAddress ?? '0.0.0.0', () => { server.removeListener('error', reject); resolve(); }); });
      server.on('error',error=>{this.state.lastError=errorText(error);this.stop().catch(()=>{});});
      const port = (server.address() as import('node:net').AddressInfo).port;
      this.hosts = new Set(addresses.map(item => `${item.address}:${port}`));
      this.state.addresses = await Promise.all(addresses.map(async item => { const url = `http://${item.address}:${port}/#${this.token}`; return { name: item.name, url, qrCode: await QRCode.toDataURL(url, { margin: 3, width: 240, errorCorrectionLevel: 'M' }) }; }));
      this.timer = setTimeout(() => { this.stop().catch(() => {}); }, this.state.expiresAt! - Date.now()); this.timer.unref(); this.notify(); return this.getState();
    } catch (error) { await this.stopNow(); throw error; }
  }
  private reply(res: ServerResponse, status: number, body: object) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); }
  private authorized(req: IncomingMessage) { const supplied = req.headers['x-receive-token']; return typeof supplied === 'string' && Buffer.byteLength(supplied) === Buffer.byteLength(this.token) && this.token.length > 0 && timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token)); }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    if (!this.state.active || Date.now() >= this.state.expiresAt! || !privateAddress(req.socket.remoteAddress ?? '') || !this.hosts.has(req.headers.host ?? '')) { this.reply(res, 403, { error: '接收已关闭或连接地址无效' }); return; }
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && pathname === '/') {
      const nonce = randomBytes(18).toString('base64'); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; base-uri 'none'; frame-ancestors 'none'` }); res.end(receivePage(nonce)); return;
    }
    if (!this.authorized(req)) { this.reply(res, 403, { error: '二维码已失效，请重新扫描' }); return; }
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { this.reply(res, 403, { error: '请求来源不正确' }); return; }
    if (req.method === 'GET' && pathname === '/status') { this.reply(res, 200, { active: this.state.active, albumName: this.state.albumName }); return; }
    if (req.method !== 'POST' || pathname !== '/upload') { this.reply(res, 404, { error: '未知请求' }); return; }
    if (this.state.uploading >= 2) { this.reply(res, 429, { error: '有文件正在传输，请稍后重试' }); return; }
    const declared = Number(req.headers['content-length']); if (!Number.isSafeInteger(declared) || declared < 1 || declared > (this.options.maxFileBytes ?? 8 * 1024 ** 3)) { this.reply(res, 413, { error: '文件为空或超过单文件 8 GB 上限' }); return; }
    const encoded = req.headers['x-file-name']; if (typeof encoded !== 'string' || encoded.length > 6000) throw new Error('文件名无效');
    const remote = decodeURIComponent(encoded); const parts = remote.replace(/\\/g, '/').split('/');
    if (remote.includes('\0') || path.isAbsolute(remote) || parts.some(part => !part || part === '.' || part === '..') || parts.length > 12) throw new Error('文件名包含无效路径');
    if (!kindOf(parts.at(-1)!)) throw new Error('请选择支持的照片或视频文件');
    const relative = path.join(...parts.map(safePhoneSegment)); const root = this.state.destination!, album = path.join(root, this.state.albumName!), staging = path.join(root, '.shiguang-staging', 'wireless');
    const temporary = path.join(staging, `${randomUUID()}.partial`); const hash = createHash('sha256'); let bytes = 0; let success = false,reserved=false;
    this.state.uploading++; this.notify(); req.setTimeout(60000, () => req.destroy(new Error('传输长时间无响应')));
    try {
      await safeDirectory(path.dirname(path.join(album, relative)), root); await safeDirectory(staging, root);
      const space = await fs.statfs(root); if (Number(space.bavail) * Number(space.bsize) < declared + this.reservedBytes + 64 * 1024 ** 2) throw new Error('保存磁盘空间不足，请腾出空间后重试');
      this.reservedBytes+=declared;reserved=true;
      const handle = await fs.open(temporary, 'wx');
      try { for await (const block of req) { bytes += block.length; if (bytes > declared) throw new Error('文件长度不符'); hash.update(block); await handle.writeFile(block); } }
      finally { await handle.close(); }
      if (bytes !== declared || !this.state.active) throw new Error('传输未完成，请重试');
      const checksum = hash.digest('hex');
      const finish = this.publication.then(async () => {
        let duplicate = false, target = path.join(album, relative);
        const known = this.options.db.prepare('SELECT local_path,size FROM receive_files WHERE sha256=?').all(checksum) as Array<{ local_path: string; size: number }>;
        if (this.options.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='phone_manifest'").get()) known.push(...this.options.db.prepare('SELECT local_path,size FROM phone_manifest WHERE sha256=?').all(checksum) as typeof known);
        for (const item of known) { try { const stat = await fs.lstat(item.local_path); if (within(item.local_path, root) && within(await fs.realpath(item.local_path),root) && stat.isFile() && !stat.isSymbolicLink() && stat.size === bytes && await digest(item.local_path) === checksum) { target = item.local_path; duplicate = true; break; } } catch { /* Missing copies are imported again. */ } }
        if (!duplicate) {
          const base = target, ext = path.extname(base); let suffix = 0;
          while (await fs.lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
            const stat = await fs.lstat(target); if (stat.isFile() && !stat.isSymbolicLink() && stat.size === bytes && await digest(target) === checksum) { duplicate = true; break; }
            target = `${base.slice(0, base.length - ext.length)}~${checksum.slice(0, 10)}${suffix++ ? '-' + suffix : ''}${ext}`;
          }
        }
        if (!duplicate) { await safeDirectory(path.dirname(target), root); await publishPhoneFile(temporary, target); const modified = Number(req.headers['x-file-modified']); if (Number.isFinite(modified) && modified > 0 && modified < Date.now() + 86400000) await fs.utimes(target, new Date(modified), new Date(modified)); }
        this.options.db.prepare('INSERT OR REPLACE INTO receive_files(sha256,local_path,size,received_at) VALUES(?,?,?,?)').run(checksum, target, bytes, Date.now());
        this.options.db.prepare('INSERT OR REPLACE INTO receive_album_files(local_path,album_path,album_name) VALUES(?,?,?)').run(target,album,this.state.albumName!);
        if (duplicate) this.state.skipped++; else { this.state.received++; this.state.bytes += bytes; }
        this.record({ name: parts.at(-1)!, bytes, status: duplicate ? 'duplicate' : 'received' });
        await this.options.onImported?.(root); return { duplicate };
      });
      this.publication = finish.catch(() => {}); const result = await finish; success = true; this.reply(res, 200, result);
    } catch (error) { const failure=(error as NodeJS.ErrnoException).code==='ENOSPC'?new Error('保存磁盘空间不足，请腾出空间后重试'):error;this.state.failed++; this.state.lastError = errorText(failure); this.record({ name: parts.at(-1)!, bytes, status: 'failed', message: errorText(failure) }); throw failure; }
    finally { if(reserved)this.reservedBytes-=declared;await fs.rm(temporary, { force: true }).catch(() => {}); this.state.uploading--; this.notify(); if (!success && !req.complete) req.destroy(); }
  }
  private record(file: ReceivedFile) { this.state.files = [file, ...this.state.files].slice(0, 20); this.notify(); }
  async stop():Promise<PhoneReceiveState>{await this.startTask?.catch(()=>{});return this.stopNow();}
  private async stopNow(): Promise<PhoneReceiveState> {
    this.state.active = false; this.token = ''; if (this.timer) clearTimeout(this.timer); this.timer = null;
    const server = this.server; this.server = null;
    if (server) { const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await closed; }
    await Promise.allSettled([...this.uploads]); this.state.addresses = []; this.notify(); return this.getState();
  }
  async close() { this.closed = true; await this.stop(); }
}
