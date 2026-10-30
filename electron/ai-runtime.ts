import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import path from 'node:path';

export const ANALYSIS_VERSION = 'ppocr5-mobile-chineseclip-b16-20261028-v1';
export interface LocalAnalysis { text: string; tags: string[]; vector: number[]; version: string }
export interface LocalEngine {
  setup(directory: string, progress: (message: string) => void, signal: AbortSignal): Promise<void>;
  ready(directory: string): Promise<boolean>;
  analyze(directory: string, file: string, fileName: string): Promise<LocalAnalysis>;
  embed(directory: string, query: string): Promise<number[]>;
  close(): Promise<void>;
}

/** Python is app-managed; no global Python installation or shell commands are used.
 * https://docs.astral.sh/uv/guides/install-python/ and /pip/environments/
 */
export class ManagedLocalEngine implements LocalEngine {
  private child: ChildProcessWithoutNullStreams | null = null;
  private directory = '';
  private startTask: Promise<void> | null = null;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private resourceDir: string) {}
  private python(directory: string) { return path.join(directory, 'runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'); }
  private uv() { return path.join(path.dirname(this.resourceDir), 'binaries', process.platform === 'win32' ? 'uv.exe' : 'uv'); }
  async ready(directory: string) {
    try {
      const marker = JSON.parse(await fs.readFile(path.join(directory, 'models', 'ready.json'), 'utf8'));
      if (marker.version !== ANALYSIS_VERSION || !existsSync(this.python(directory)) || !marker.files || typeof marker.files !== 'object') return false;
      for (const file of Object.keys(marker.files)) { const target = path.resolve(directory, 'models', file); if (!target.startsWith(path.resolve(directory, 'models') + path.sep) || !(await fs.stat(target)).isFile()) return false; }
      return Object.keys(marker.files).length >= 7;
    } catch { return false; }
  }
  private env(directory: string) { return { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', UV_PYTHON_INSTALL_DIR: path.join(directory, 'python'), UV_PYTHON_NO_REGISTRY: '1', UV_CACHE_DIR: path.join(directory, 'download-cache'), UV_HTTP_TIMEOUT: '300', UV_HTTP_RETRIES: '3', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false', OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2' }; }
  private run(executable: string, args: string[], directory: string, progress: (message: string) => void, signal: AbortSignal, json = false): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('已暂停模型安装')); return; }
      const log = createWriteStream(path.join(directory, 'setup.log'), { flags: 'a' });
      log.on('error', () => { /* Installation errors remain available through the UI. */ });
      log.write(`\n[${new Date().toISOString()}] ${path.basename(executable)} ${args.join(' ')}\n`);
      const child = spawn(executable, args, { windowsHide: true, env: this.env(directory), stdio: ['ignore', 'pipe', 'pipe'] });
      let errorText = '', stdout = '', failure: Error | undefined, lastProgress = 0;
      const abort = () => { failure = new Error('已暂停模型安装'); child.kill(); };
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { failure = new Error('模型安装超时，请检查网络后重试'); child.kill(); }, 45 * 60_000);
      child.stdout.on('data', (data: Buffer) => {
        log.write(data);
        stdout += data.toString('utf8');
        if (stdout.length > 1_000_000) stdout = stdout.slice(-100_000);
        if (json) { let end: number; while ((end = stdout.indexOf('\n')) >= 0) { const line = stdout.slice(0, end); stdout = stdout.slice(end + 1); try { const message = JSON.parse(line); if (typeof message.progress === 'string') progress(message.progress); } catch { /* Dependency output is not an RPC response. */ } } }
      });
      child.stderr.on('data', (data: Buffer) => { log.write(data); const text = data.toString('utf8'); errorText = (errorText + text).slice(-5000); if (!json && Date.now() - lastProgress > 3000 && /Downloading|Downloaded|Installed|Prepared|Resolved|Extracting/i.test(text)) { lastProgress = Date.now(); const size = text.match(/\([\d.]+\s*(?:MiB|GiB|MB|GB)\)/)?.[0]; progress(`正在准备本地识别组件${size ? ' · ' + size : ''}`); } });
      child.on('error', error => { failure = error; });
      child.on('close', code => { log.end(); clearTimeout(timer); signal.removeEventListener('abort', abort); failure ? reject(failure) : code !== 0 ? reject(new Error(errorText.trim() || stdout.trim() || `模型安装退出 (${code})`)) : resolve(); });
    });
  }
  async setup(directory: string, progress: (message: string) => void, signal: AbortSignal) {
    await this.close();
    if (!existsSync(this.uv())) throw new Error('安装包缺少本地模型运行组件，请重新安装 Luma');
    await fs.mkdir(directory, { recursive: true });
    const ownerFile = path.join(directory, 'shiguang-model-directory.json');
    if (!existsSync(ownerFile)) {
      if (existsSync(path.join(directory, 'runtime')) && !existsSync(path.join(directory, 'models', 'ready.json'))) throw new Error('这个文件夹已有其他运行环境，请选择专门用于 Luma 模型的文件夹');
      await fs.writeFile(ownerFile, JSON.stringify({ app: 'local.shiguang.album', version: 1 }), { flag: 'wx' });
    } else { const owner = JSON.parse(await fs.readFile(ownerFile, 'utf8')); if (owner.app !== 'local.shiguang.album') throw new Error('模型文件夹不属于 Luma，请选择其他位置'); }
    try { if ((await fs.stat(path.join(directory, 'setup.log'))).size > 1_000_000) await fs.rename(path.join(directory, 'setup.log'), path.join(directory, 'setup.previous.log')); } catch { /* First setup has no log. */ }
    const volume = await fs.statfs(directory);
    if (Number(volume.bavail) * Number(volume.bsize) < 3 * 1024 ** 3 && !(await this.ready(directory))) throw new Error('本地模型需要约 3 GB 安装空间，请选择空间充足的磁盘');
    progress('准备独立的本地识别运行环境');
    if (!existsSync(this.python(directory))) await this.run(this.uv(), ['venv', '--managed-python', '--python', '3.11', path.join(directory, 'runtime')], directory, progress, signal);
    progress('安装 CPU 图片识别组件（首次使用需要下载）');
    if (process.platform === 'win32') {
      const wheel = path.join(directory, 'downloads', 'torch-2.6.0+cpu-cp311-cp311-win_amd64.whl');
      await this.run(this.python(directory), ['-u', path.join(this.resourceDir, 'bootstrap.py'), path.dirname(wheel)], directory, progress, signal, true);
      await this.run(this.uv(), ['pip', 'install', '--python', this.python(directory), '--index-url', 'https://pypi.org/simple', wheel], directory, progress, signal);
    } else {
      await this.run(this.uv(), ['pip', 'install', '--python', this.python(directory), '--index-url', 'https://download.pytorch.org/whl/cpu', 'torch==2.6.0+cpu'], directory, progress, signal);
    }
    if (process.platform === 'win32') await this.run(this.python(directory), ['-u', path.join(this.resourceDir, 'bootstrap.py'), path.join(directory, 'downloads'), 'deps'], directory, progress, signal, true);
    await this.run(this.uv(), ['pip', 'install', '--python', this.python(directory), '--index-url', 'https://pypi.org/simple', '--find-links', path.join(directory, 'downloads'), '-r', path.join(this.resourceDir, 'requirements.txt')], directory, progress, signal);
    progress('下载中文识字和内容检索模型');
    await this.run(this.python(directory), ['-u', path.join(this.resourceDir, 'worker.py'), 'setup', path.join(directory, 'models')], directory, progress, signal, true);
    if (!(await this.ready(directory))) throw new Error('模型校验没有完成，请重试安装');
  }
  private async start(directory: string) {
    if (this.child && this.directory === directory && !this.child.killed) return;
    if (this.startTask) { await this.startTask; if (this.child && this.directory === directory) return; }
    this.startTask = this.launch(directory);
    try { await this.startTask; } finally { this.startTask = null; }
  }
  private async launch(directory: string): Promise<void> {
    await this.close();
    if (!(await this.ready(directory))) throw new Error('请先安装本地识别模型');
    this.directory = directory;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.python(directory), ['-u', path.join(this.resourceDir, 'worker.py'), 'serve', path.join(directory, 'models')], { windowsHide: true, env: this.env(directory), stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      let buffer = '', errors = '', ready = false;
      const timer = setTimeout(() => { child.kill(); reject(new Error('本地模型启动超时')); }, 180_000);
      child.stderr.on('data', (data: Buffer) => { errors = (errors + data.toString('utf8')).slice(-5000); });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (data: string) => {
        buffer += data;
        if (buffer.length > 3_000_000) { child.kill(); return; }
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const message = JSON.parse(line);
            if (message.ready && !ready) { ready = true; clearTimeout(timer); resolve(); }
            else if (typeof message.id === 'number') { const request = this.pending.get(message.id); if (request) { this.pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(new Error(String(message.error))) : request.resolve(message.value); } }
          } catch { /* Non-JSON library logs must not become RPC messages. */ }
        }
      });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', () => { clearTimeout(timer); if (this.child === child) this.child = null; const error = new Error(errors.trim() || '本地识别进程已关闭'); if (!ready) reject(error); for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); } this.pending.clear(); });
    });
  }
  private async request<T>(directory: string, request: Record<string, unknown>): Promise<T> {
    await this.start(directory);
    const child = this.child!;
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('本地识别超时，可暂停后重试')); }, 180_000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ ...request, id }) + '\n', 'utf8', error => { if (error) { this.pending.delete(id); clearTimeout(timer); reject(error); } });
    });
  }
  analyze(directory: string, file: string, fileName: string) { return this.request<LocalAnalysis>(directory, { method: 'analyze', path: file, fileName }); }
  embed(directory: string, query: string) { return this.request<number[]>(directory, { method: 'text', query }); }
  async close() { const child = this.child; if (!child) return; this.child = null; await new Promise<void>(resolve => { const timer = setTimeout(resolve, 5000); child.once('close', () => { clearTimeout(timer); resolve(); }); child.kill(); }); }
}
