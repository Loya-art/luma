import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { kindOf } from './media';
import { classifyPhotoFolder, recommendPhotoFolder } from '../src/shared/photo-folders';
import type { ComputerDiscoveryState, ComputerLocation, DiscoveredFolder } from '../src/shared/discovery';

const excludedNames = new Set([
  'windows', 'program files', 'program files (x86)', 'programdata', 'appdata',
  '$recycle.bin', 'system volume information', '$windows.~bt', '$windows.~ws',
  '$winreagent', 'recovery', 'perflogs', 'msocache', 'config.msi',
  'node_modules', '.git', '.svn', '.hg', '.cache', '.npm', '.gradle', '.uv',
  '__pycache__', '.venv', 'venv', 'mediacache', '.shiguang-staging',
]);
export const isDiscoveryExcluded = (directory: string) => directory.split(/[\\/]/).some(segment => excludedNames.has(segment.toLowerCase()));
function excludedForDiscovery(directory: string) {
  const category = classifyPhotoFolder(directory).kind;
  // Known or explicitly selected capture/output folders may live underneath an
  // application installation. This does not allow traversing the program tree.
  const retainOutput = category === 'screenshot' || category === 'ai-output';
  return directory.split(/[\\/]/).some(segment => excludedNames.has(segment.toLowerCase()) && !(retainOutput && ['program files', 'program files (x86)', 'appdata', 'programdata'].includes(segment.toLowerCase())));
}
const key = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const within = (child: string, parent: string) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const fresh = (): ComputerDiscoveryState => ({ id: null, status: 'idle', roots: [], visitedDirectories: 0, skippedDirectories: 0, filteredDirectories: 0, filtered: [], count: 0, bytes: 0, folders: [], issues: [], issueCount: 0 });

async function directories(directory: string, limit: number): Promise<string[]> {
  try { return (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).slice(0, limit).map(entry => path.join(directory, entry.name)); }
  catch { return []; }
}
async function existingDirectory(directory: string) { try { const stat = await fs.lstat(directory); return stat.isDirectory() && !stat.isSymbolicLink(); } catch { return false; } }

/** Steam captures use userdata/<user>/760/remote/<app>/screenshots.
 * Inspect only those fixed-depth paths; never crawl Program Files to find them.
 * Primary filesystem research: https://dfrws.org/wp-content/uploads/2024/03/Well-Played-Suspect-Forensic-examination_2024_Forensic-Science-Internati.pdf */
async function knownGameScreenshotLocations(): Promise<ComputerLocation[]> {
  if (process.platform !== 'win32') return [];
  const steamRoots = new Set<string>();
  for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) if (base) steamRoots.add(path.join(base, 'Steam', 'userdata'));
  try {
    const script = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $steam=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Valve\\Steam' -ErrorAction SilentlyContinue; if($steam.SteamPath){$steam.SteamPath | ConvertTo-Json -Compress}";
    const text = await new Promise<string>((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    const installed = text.trim() ? JSON.parse(text.replace(/^\uFEFF/, '')) : null;
    if (typeof installed === 'string') steamRoots.add(path.join(installed, 'userdata'));
  } catch { /* Steam is optional. */ }
  const result: ComputerLocation[] = [];
  let remaining = 2048;
  for (const steamRoot of steamRoots) for (const user of await directories(steamRoot, 32)) {
    for (const app of await directories(path.join(user, '760', 'remote'), Math.max(0, remaining))) {
      if (remaining-- <= 0) break;
      const screenshots = path.join(app, 'screenshots');
      if (await existingDirectory(screenshots)) result.push({ path: screenshots, name: `游戏截图 · ${path.basename(app)}`, kind: 'folder' });
    }
  }
  // Unreal games commonly save captures here. Test only the exact Saved path
  // beneath each top-level app; do not enumerate its caches or other contents.
  if (process.env.LOCALAPPDATA) for (const app of await directories(process.env.LOCALAPPDATA, 512)) {
    const screenshots = path.join(app, 'Saved', 'Screenshots');
    if (await existingDirectory(screenshots)) result.push({ path: screenshots, name: `游戏截图 · ${path.basename(app)}`, kind: 'folder' });
  }
  return result.filter((item, index, list) => list.findIndex(other => key(other.path) === key(item.path)) === index);
}

async function localDisks(): Promise<ComputerLocation[]> {
  if (process.platform !== 'win32') return [{ path: '/', name: '本机磁盘', kind: 'disk' }];
  // Win32_LogicalDisk excludes network mappings (DriveType=4). No user path is
  // interpolated into PowerShell. https://learn.microsoft.com/windows/win32/cimwin32prov/win32-logicaldisk
  const script = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2 OR DriveType=3' | Where-Object {$_.Size -gt 0} | Select-Object DeviceID,VolumeName,Size,FreeSpace) | ConvertTo-Json -Compress";
  const output = await new Promise<string>((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 65536 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const parsed = JSON.parse(output.replace(/^\uFEFF/, '') || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]).map(row => ({ path: `${row.DeviceID}\\`, name: `${row.VolumeName || '本地磁盘'} (${row.DeviceID})`, kind: 'disk' as const, totalBytes: Number(row.Size), freeBytes: Number(row.FreeSpace) }));
}

/** A cancellable, read-only discovery pass. It never decodes, copies or deletes originals. */
export class ComputerDiscovery {
  private state = fresh();
  private task: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private folders = new Map<string, DiscoveredFolder>();
  private covers = new Map<string, { path: string; kind: 'image' | 'video' }>();
  private lastNotification = 0;
  private screenshotLocations: ComputerLocation[] | null = null;
  constructor(private options: { commonLocations?: ComputerLocation[]; excludedPaths?: string[]; knownScreenshotLocations?: ComputerLocation[]; onChange?: () => void } = {}) {}
  getState(): ComputerDiscoveryState { return { ...this.state, roots: [...this.state.roots], folders: [...this.folders.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path, 'zh-CN')), filtered: this.state.filtered.map(item => ({ ...item })), issues: this.state.issues.map(issue => ({ ...issue })) }; }
  getPreview(scanId: string, folderId: string) {
    if (scanId !== this.state.id) throw new Error('扫描结果已变化，请重新扫描');
    const cover = this.covers.get(folderId);
    if (!cover) throw new Error('这个扫描目录没有可预览的文件');
    return { ...cover };
  }
  private async gameScreenshots() { return this.screenshotLocations ??= this.options.knownScreenshotLocations ?? await knownGameScreenshotLocations(); }
  async locations(): Promise<ComputerLocation[]> {
    const common = this.options.commonLocations ?? [{ path: path.join(os.homedir(), 'Pictures'), name: '图片', kind: 'folder' as const }, { path: path.join(os.homedir(), 'Desktop'), name: '桌面', kind: 'folder' as const }, { path: path.join(os.homedir(), 'Downloads'), name: '下载', kind: 'folder' as const }];
    const existing: ComputerLocation[] = [];
    for (const location of common) { try { if ((await fs.stat(location.path)).isDirectory()) existing.push(location); } catch { /* Removed user folders are not offered. */ } }
    existing.push(...await this.gameScreenshots());
    try { existing.push(...await localDisks()); } catch { /* Custom folder selection remains available if disk discovery is unavailable. */ }
    return existing.filter((item, index, list) => list.findIndex(other => key(other.path) === key(item.path)) === index);
  }
  private notify(force = false) { if (force || Date.now() - this.lastNotification >= 250) { this.lastNotification = Date.now(); this.options.onChange?.(); } }
  private issue(file: string, error: unknown) { this.state.issueCount++; if (this.state.issues.length < 100) this.state.issues.push({ path: file, message: error instanceof Error ? error.message : String(error) }); }
  async start(input: string[]): Promise<ComputerDiscoveryState> {
    if (this.task) throw new Error('电脑照片扫描正在进行，请先停止或等待完成');
    if (!Array.isArray(input) || !input.length || input.length > 64 || input.some(value => typeof value !== 'string' || !path.isAbsolute(value))) throw new Error('请选择有效磁盘或文件夹');
    const roots: string[] = [];
    for (const value of input) {
      const absolute = path.resolve(value);
      if (!roots.some(root => within(key(absolute), key(root)))) { for (let index = roots.length - 1; index >= 0; index--) if (within(key(roots[index]), key(absolute))) roots.splice(index, 1); roots.push(absolute); }
    }
    this.folders.clear(); this.covers.clear(); this.state = { ...fresh(), id: randomUUID(), roots, status: 'running', startedAt: Date.now() };
    const controller = this.controller = new AbortController();
    this.task = this.perform(roots, controller.signal).finally(() => { this.task = null; this.controller = null; });
    this.notify(true); return this.getState();
  }
  cancel() { this.controller?.abort(); }
  async waitForIdle() { await this.task; }
  async close() { this.cancel(); await this.task; }
  private async perform(roots: string[], signal: AbortSignal) {
    const excluded = (this.options.excludedPaths ?? []).map(key);
    const seen = new Set<string>();
    const visit = async (directory: string): Promise<void> => {
      if (signal.aborted) return;
      const canonical = key(directory);
      if (seen.has(canonical)) return;
      seen.add(canonical);
      if (excluded.some(root => within(canonical, root))) { this.state.skippedDirectories++; this.notify(); return; }
      const category = path.basename(directory).toLowerCase() === '.runtime' ? { kind: 'utility', reason: '开发测试的临时运行目录' } : classifyPhotoFolder(directory);
      if (category.kind === 'utility') {
        this.state.skippedDirectories++; this.state.filteredDirectories++;
        if (this.state.filtered.length < 200) this.state.filtered.push({ path: directory, reason: category.reason! });
        this.notify(); return;
      }
      if (excludedForDiscovery(directory)) { this.state.skippedDirectories++; this.notify(); return; }
      try {
        const stat = await fs.lstat(directory);
        if (stat.isSymbolicLink()) { this.state.skippedDirectories++; return; }
        if (!stat.isDirectory()) throw new Error('这个位置不是文件夹');
        this.state.currentDirectory = directory; this.state.visitedDirectories++; this.notify();
        const handle = await fs.opendir(directory);
        for await (const entry of handle) {
          if (signal.aborted) break;
          const file = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) { this.state.skippedDirectories++; continue; }
          if (entry.isDirectory()) await visit(file);
          else if (entry.isFile()) {
            const kind = kindOf(file); if (!kind) continue;
            try {
              const fileStat = await fs.lstat(file);
              if (!fileStat.isFile() || fileStat.isSymbolicLink()) continue;
              let folder = this.folders.get(canonical);
              if (!folder) { folder = { path: directory, name: path.basename(directory) || directory, count: 0, photos: 0, videos: 0, bytes: 0, ...recommendPhotoFolder(directory) }; this.folders.set(canonical, folder); }
              const folderId = createHash('sha256').update(canonical).digest('hex').slice(0, 24), cover = this.covers.get(folderId);
              if (!cover || cover.kind === 'video' && kind === 'image') {
                this.covers.set(folderId, { path: file, kind });
                folder.previewUrl = `app-media://discovery/${this.state.id}/${folderId}/thumbnail?v=${createHash('sha256').update(file).digest('hex').slice(0, 12)}`;
              }
              folder.count++; folder[kind === 'image' ? 'photos' : 'videos']++; folder.bytes += fileStat.size;
              this.state.count++; this.state.bytes += fileStat.size; this.notify();
            } catch (error) { this.issue(file, error); }
          }
        }
      } catch (error) { if (!signal.aborted) this.issue(directory, error); }
      await yieldTurn();
    };
    try {
      for (const root of roots) { if (signal.aborted) break; await visit(root); }
      // When a disk is selected, add only known capture directories within it
      // that were otherwise shielded by Program Files/AppData pruning.
      const targeted = this.options.knownScreenshotLocations || roots.some(root => root === path.parse(root).root) ? await this.gameScreenshots() : this.screenshotLocations ?? [];
      for (const location of targeted) if (!signal.aborted && roots.some(root => within(key(location.path), key(root)))) await visit(location.path);
      this.state.status = signal.aborted ? 'cancelled' : 'complete';
    }
    catch (error) { this.state.status = 'error'; this.issue(this.state.currentDirectory || roots[0], error); }
    finally { this.state.currentDirectory = undefined; this.state.finishedAt = Date.now(); this.notify(true); }
  }
}
