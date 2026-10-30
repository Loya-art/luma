import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, shell, safeStorage } from 'electron';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { LibraryChange, TrashResult } from '../src/shared/types';
import { parseRange } from './range';
import { configureApplicationIdentity, PRODUCT_NAME } from './branding';

// Product branding is independent of its durable data directory. Renaming the
// app must not create an empty library or orphan import/model progress.
configureApplicationIdentity(app, process.env.SHIGUANG_DATA_DIR);
nativeTheme.themeSource = 'dark';
// Privileges must be registered before app.ready. Streaming keeps native video seeking available.
// https://www.electronjs.org/docs/latest/api/protocol
protocol.registerSchemesAsPrivileged([{ scheme: 'app-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

let window: BrowserWindow | null = null;
let worker: Worker | null = null;
let shuttingDown = false;
let sequence = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>();
let ready: Promise<void>;
const rpc = async <T = any>(method: string, ...args: unknown[]): Promise<T> => {
  await ready;
  if (!worker) throw new Error('图库服务尚未就绪');
  const id = ++sequence;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker!.postMessage({ id, method, args }); });
};
function binary(name: string) {
  const file = name + (process.platform === 'win32' ? '.exe' : '');
  const paths = [path.join(process.resourcesPath, 'binaries', file), path.join(app.getAppPath(), 'resources', 'binaries', file)];
  return paths.find(existsSync) ?? name;
}
function startWorker() {
  ready = new Promise<void>((resolve, reject) => {
    const aiResourceDir=[path.join(process.resourcesPath,'ai'),path.join(app.getAppPath(),'resources','ai')].find(existsSync)!;
    worker = new Worker(path.join(__dirname, 'worker.cjs'), { workerData: { dataDir: app.getPath('userData'), receiverBindAddress:process.env.SHIGUANG_TEST_MODE?'127.0.0.1':undefined,commonLocations: [{path:app.getPath('pictures'),name:'图片',kind:'folder'},{path:app.getPath('desktop'),name:'桌面',kind:'folder'},{path:app.getPath('documents'),name:'文档',kind:'folder'},{path:app.getPath('downloads'),name:'下载',kind:'folder'}], adbPath:binary('adb'),aiResourceDir,binaries: { ffmpeg: binary('ffmpeg'), ffprobe: binary('ffprobe') } } });
    worker.on('message', message => {
      if (message.ready) resolve();
      else if (message.event) { if (window && !window.isDestroyed()) window.webContents.send('album:change', message.event as LibraryChange); }
      else if (message.fatal) { console.error(message.fatal); }
      else if (typeof message.id === 'number') { const request = pending.get(message.id); if (request) { pending.delete(message.id); message.error ? request.reject(new Error(message.error)) : request.resolve(message.value); } }
    });
    worker.on('error', error => { reject(error); for (const request of pending.values()) request.reject(error); pending.clear(); console.error('图库服务错误', error); });
    worker.on('exit', code => { if (!shuttingDown && code !== 0) { const error = new Error(`图库服务退出 (${code})`); reject(error); for (const request of pending.values()) request.reject(error); pending.clear(); } });
  });
}
async function mediaResponse(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const discovery = url.hostname === 'discovery' && parts.length === 3 && /^[a-zA-Z0-9-]+$/.test(parts[0]) && /^[a-f0-9]{24}$/.test(parts[1]) && parts[2] === 'thumbnail';
    const asset = url.hostname === 'asset' && parts.length === 2 && /^[a-zA-Z0-9-]+$/.test(parts[0]) && ['original', 'thumbnail', 'preview', 'playable'].includes(parts[1]);
    if (!asset && !discovery) return new Response('Unknown asset', { status: 404 });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    const media = discovery ? await rpc<{ path: string; mime: string }>('resolveDiscoveryPreview', parts[0], parts[1]) : await rpc<{ path: string; mime: string }>('resolveMedia', parts[0], parts[1]);
    const stat = await fs.stat(media.path);
    if (!stat.isFile()) return new Response(null, { status: 404 });
    const range = parseRange(request.headers.get('range'), stat.size);
    const headers = new Headers({ 'Content-Type': media.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': parts[1] === 'original' ? 'no-cache' : 'private, max-age=86400', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' });
    if (range === 'invalid') { headers.set('Content-Range', `bytes */${stat.size}`); return new Response(null, { status: 416, headers }); }
    const start = range?.start ?? 0, end = range?.end ?? stat.size - 1;
    headers.set('Content-Length', String(Math.max(0, end - start + 1)));
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    if (request.method === 'HEAD' || stat.size === 0) return new Response(null, { status: range ? 206 : 200, headers });
    const stream = createReadStream(media.path, { start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
  } catch (error) { console.warn('媒体读取失败', request.url, error instanceof Error ? error.message : error); return new Response(null, { status: 404 }); }
}
function registerIPC() {
  const direct = ['getSnapshot', 'addSources', 'computerLocations', 'computerDiscoveryState', 'discoverComputer', 'cancelComputerDiscovery', 'addDiscoveredFolders', 'rescan', 'cancelScan', 'updateMedia', 'createAlbum', 'renameAlbum', 'deleteAlbum', 'removeSource', 'removeMedia', 'setSettings', 'prepareVideo', 'cancelVideo', 'recordOpen','phoneState','phoneReceiveState','startPhoneReceive','stopPhoneReceive','phoneDevices','pairPhone','connectPhone','scanPhone','importPhone','pausePhoneImport','resumePhoneImport','intelligenceState','setupModels','analyzeMedia','pauseAnalysis','searchMedia','analysisDetail','setAITag'];
  for (const method of direct) ipcMain.handle(`album:${method}`, (_event, ...args) => rpc(method, ...args));
  const keyFile=path.join(app.getPath('userData'),'cloud-key.encrypted');
  const readKey=async()=>{if(!safeStorage.isEncryptionAvailable())throw new Error('系统密钥保护暂不可用');try{return safeStorage.decryptString(await fs.readFile(keyFile));}catch{throw new Error('请先在智能整理中保存 DeepSeek API 密钥');}};
  ipcMain.handle('album:cloudKeyStatus',async()=>existsSync(keyFile)&&safeStorage.isEncryptionAvailable());
  ipcMain.handle('album:setCloudKey',async(_event,key:unknown)=>{if(typeof key!=='string'||key.length>1024)throw new Error('密钥格式不正确');if(!key.trim()){await fs.rm(keyFile,{force:true});return;}if(!safeStorage.isEncryptionAvailable())throw new Error('系统密钥保护暂不可用');await fs.mkdir(path.dirname(keyFile),{recursive:true});await fs.writeFile(keyFile,safeStorage.encryptString(key.trim()));});
  ipcMain.handle('album:startCloudAnalysis',async(_event,request:{ids:string[];instruction?:string})=>{if(!request||!Array.isArray(request.ids)||!request.ids.length)throw new Error('请先选择要分析的照片');return rpc('startCloudAnalysis',request.ids,request.instruction??'',await readKey());});
  ipcMain.handle('album:resumeAnalysis',async(_event,id:string)=>{const state=await rpc('intelligenceState');const job=state.jobs.find((item:any)=>item.id===id);return rpc('resumeAnalysis',id,job?.kind==='cloud'?await readKey():undefined);});
  const chooseDirectory=async(title:string,defaultPath:string)=>{const options:Electron.OpenDialogOptions={title,defaultPath,properties:['openDirectory','createDirectory']};const result=window?await dialog.showOpenDialog(window,options):await dialog.showOpenDialog(options);return result.canceled?null:result.filePaths[0]??null;};
  ipcMain.handle('album:chooseImportDestination',()=>chooseDirectory('选择手机照片保存位置',existsSync('E:\\')?'E:\\手机照片':app.getPath('pictures')));
  ipcMain.handle('album:chooseModelDirectory',()=>chooseDirectory('选择本地识别模型保存位置',existsSync('E:\\')?'E:\\拾光模型':path.join(app.getPath('userData'),'Models')));
  ipcMain.handle('album:trashMedia',async(_event,ids:string[]):Promise<TrashResult>=>{
    if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))throw new Error('请选择有效素材');
    const rows=await rpc<Array<{id:string;path:string;fileName:string}>>('beginTrash',ids);const result:TrashResult={removed:[],failed:[]};
    try{for(const row of rows){try{const file=path.resolve(row.path);const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('当前项目不是可删除的原始文件');
      // Never fall back to permanent deletion when the operating system rejects trash.
      // https://www.electronjs.org/docs/latest/api/shell#shelltrashitempath
      await shell.trashItem(file);result.removed.push(row.id);
    }catch(error){result.failed.push({id:row.id,fileName:row.fileName,message:error instanceof Error?error.message:String(error)});}}}
    finally{await rpc('finishTrash',result.removed);}return result;
  });
  ipcMain.handle('album:chooseFolders', async () => {
    const options: Electron.OpenDialogOptions = { title: '添加图片与视频文件夹', properties: ['openDirectory', 'multiSelections'] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('album:relinkSource', async (_event, id: string) => {
    const options: Electron.OpenDialogOptions = { title: '重新定位素材文件夹', properties: ['openDirectory'] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (!result.canceled && result.filePaths[0]) await rpc('relinkSource', id, result.filePaths[0]);
  });
  ipcMain.handle('album:reveal', async (_event, id: string) => shell.showItemInFolder(await rpc<string>('getPath', id)));
  ipcMain.handle('album:openExternal', async (_event, id: string) => { const error = await shell.openPath(await rpc<string>('getPath', id)); if (error) throw new Error(error); });
}
async function openWindow() {
  const hiddenTest = process.env.SHIGUANG_TEST_MODE === '1' && process.env.SHIGUANG_HIDDEN_TEST === '1' && !!process.env.SHIGUANG_DATA_DIR;
  window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 880, minHeight: 600,
    title: PRODUCT_NAME, backgroundColor: '#151515', show: false, autoHideMenuBar: true,
    // Electron's TitleBarOverlay keeps native Windows controls over renderer content.
    // The renderer supplies a draggable glass strip without a visible title or app icon.
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: { color: '#00000000', symbolColor: '#e6e6e6', height: 36 },
    } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !hiddenTest },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== window?.webContents.getURL()) event.preventDefault(); });
  // Acceptance tests use a separate library and an invisible renderer, so a
  // failed test cannot leave another blank window on the user's desktop.
  window.once('ready-to-show', () => { if (!hiddenTest) window?.show(); });
  window.on('closed', () => { window = null; });
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}
app.whenReady().then(async () => {
  startWorker(); registerIPC(); protocol.handle('app-media', mediaResponse);
  await openWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) openWindow().catch(console.error); });
}).catch(error => { console.error(error); if (!process.env.SHIGUANG_TEST_MODE) dialog.showErrorBox('Luma 启动失败', String(error)); app.quit(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (shuttingDown) return;
  event.preventDefault(); shuttingDown = true;
  const timeout = new Promise(resolve => setTimeout(resolve, 4000));
  Promise.race([rpc('close').catch(console.error), timeout]).finally(async () => { await worker?.terminate(); worker = null; app.quit(); });
});
