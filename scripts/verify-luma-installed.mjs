import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as asar from '@electron/asar';
import sharp from 'sharp';
import { closeDesktopSession } from './desktop-session.mjs';

// No BrowserWindow is created: compare the production database read-only, then
// exercise the installed backend with the installed Electron/Sharp runtime and
// a separate scratch library. The user can open the new shortcut themselves.
const out = path.resolve('docs/acceptance');
const receipt = JSON.parse((await fs.readFile(path.join(out, 'installation.json'), 'utf8')).replace(/^\uFEFF/, ''));
const expected = JSON.parse(await fs.readFile('package.json', 'utf8'));
assert.equal(receipt.productName, 'Luma');
assert.equal(receipt.productVersion, expected.version + '.0');
const archive = path.join(path.dirname(receipt.executable), 'resources/app.asar');
const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
assert.equal(packaged.name, expected.name);
assert.equal(packaged.version, expected.version);
const sha = value => createHash('sha256').update(value).digest('hex');
const report = { checkedAt: new Date().toISOString(), visibleWindowsStarted: false, productionProfileReadOnly: true, version: expected.version, checks: [] };
const before = new DatabaseSync(receipt.userDataBackup.path, { readOnly: true });
const after = new DatabaseSync(path.join(receipt.userDataDirectory, 'library.sqlite'), { readOnly: true });
let originals;
try {
  assert.equal(after.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  const tables = before.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
  assert.deepEqual(after.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name), tables);
  report.preservedTables = {};
  for (const table of tables) {
    const quoted = '"' + table.replaceAll('"', '""') + '"';
    const previous = before.prepare(`SELECT * FROM ${quoted}`).all().map(row => JSON.stringify(row)).sort();
    const current = after.prepare(`SELECT * FROM ${quoted}`).all().map(row => JSON.stringify(row)).sort();
    assert.deepEqual(current, previous, `Upgrade changed stored ${table} rows`);
    report.preservedTables[table] = current.length;
  }
  originals = after.prepare('SELECT local_path,sha256 FROM phone_manifest LIMIT 8').all();
} finally { before.close(); after.close(); }
report.checks.push('All production database tables match the pre-upgrade backup, including classifications, phone progress and AI indexes/configuration.');
for (const row of originals) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(row.local_path)) hash.update(chunk);
  assert.equal(hash.digest('hex'), row.sha256);
}
report.originalHashesVerified = originals.length;
for (const file of ['index.html', ...(await fs.readdir('dist/assets')).map(name => 'assets/' + name)]) {
  assert.equal(sha(asar.extractFile(archive, path.normalize('dist/' + file))), sha(await fs.readFile(path.join('dist', file))), file);
}
for (const name of ['main', 'worker', 'preload']) {
  const relative = `dist-electron/${name}.cjs`;
  assert.equal(sha(asar.extractFile(archive, path.normalize(relative))), sha(await fs.readFile(relative)), relative);
}
report.checks.push('Installed frontend/backend assets exactly match the verified build.');
await assert.rejects(fs.access(path.join(path.dirname(receipt.executable), 'Shiguang.exe')), { code: 'ENOENT' });
for (const link of receipt.shortcuts) {
  for (const oldName of ['拾光相册.lnk', '时光相册.lnk']) await assert.rejects(fs.access(path.join(path.dirname(link.path), oldName)), { code: 'ENOENT' });
}

const scratch = await fs.mkdtemp(path.join(path.resolve('tests/.runtime'), 'luma-installed-'));
const input = path.join(scratch, 'images');
const keep = ['Games/Example/Screenshots/游戏截图.png', 'ComfyUI/output/中文创作.png'];
const drop = ['Games/Example/textures/贴图.png', 'WeChat Files/account/Image/聊天.png', 'ComfyUI/custom_nodes/Example/preview.png'];
for (const name of [...keep, ...drop]) {
  const file = path.join(input, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await sharp({ create: { width: 120, height: 80, channels: 3, background: '#929292' } }).png().toFile(file);
}
const probe = path.join(scratch, 'probe.cjs');
await fs.writeFile(probe, `
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const {Worker} = require('node:worker_threads');
const [installation,scratch] = process.argv.slice(2);
const resources=path.join(installation,'resources');
const worker = new Worker(path.join(resources,'app.asar','dist-electron','worker.cjs'), {workerData:{
  dataDir:path.join(scratch,'profile'),watch:false,receiverBindAddress:'127.0.0.1',commonLocations:[],
  aiResourceDir:path.join(resources,'ai'),adbPath:path.join(resources,'binaries','adb.exe'),
  binaries:{ffmpeg:path.join(resources,'binaries','ffmpeg.exe'),ffprobe:path.join(resources,'binaries','ffprobe.exe')}
}});
let sequence=0;const pending=new Map();
worker.on('message', message=>{if(message.fatal) throw Error(message.fatal);const waiting=pending.get(message.id);if(waiting){pending.delete(message.id);clearTimeout(waiting.timer);message.error?waiting.reject(Error(message.error)):waiting.resolve(message.value);}});
const rpc=(method,...args)=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>reject(Error('RPC timed out: '+method)),15000);pending.set(id,{resolve,reject,timer});worker.postMessage({id,method,args});});
const delay=()=>new Promise(resolve=>setTimeout(resolve,50));
(async()=>{try {
  await rpc('getSnapshot');
  const input=path.join(scratch,'images');
  const scan=await rpc('discoverComputer',[input]);
  let state;do{await delay();state=await rpc('computerDiscoveryState');}while(state.status==='running');
  assert.equal(state.status,'complete');assert.equal(state.count,2);assert.equal(state.filteredDirectories,3);
  await rpc('addDiscoveredFolders',scan.id,state.folders.map(folder=>folder.path));
  let snapshot;do{await delay();snapshot=await rpc('getSnapshot');}while(snapshot.jobs.some(job=>job.status==='running'));
  assert.equal(snapshot.media.length,2);assert.equal(snapshot.errors.length,0);
  const previews=[];
  for(const item of snapshot.media){const resolved=await rpc('resolveMedia',item.id,'thumbnail');const stat=await fs.stat(resolved.path);assert.ok(stat.size>0);previews.push(resolved.path);}
  assert.equal((await rpc('phoneReceiveState')).active,false);
  const ai=await rpc('intelligenceState');assert.equal(ai.enabled,false);
  console.log(JSON.stringify({electron:process.versions.electron,imported:snapshot.media.length,filteredDirectories:state.filteredDirectories,previews,lanListenerActive:false}));
}finally{await rpc('close');await worker.terminate();}})().catch(error=>{console.error(error);process.exitCode=1;worker.terminate();});
`, 'utf8');
let child;
try {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  for (const key of ['SHIGUANG_DATA_DIR', 'SHIGUANG_TEST_MODE', 'ELECTRON_RENDERER_URL']) delete env[key];
  const stdout = await new Promise((resolve, reject) => {
    child = execFile(receipt.executable, [probe, path.dirname(receipt.executable), scratch], { env, windowsHide: true, timeout: 45000 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout));
  });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.electron, expected.devDependencies.electron);
  for (const file of result.previews) { const metadata = await sharp(file).metadata(); assert.ok(metadata.width > 0 && metadata.height > 0); }
  report.installedRuntime = { ...result, previews: result.previews.length };
  report.checks.push('Installed Electron/backend imports Chinese-named captures and ComfyUI output, excludes assets/chat, and generates decodable previews in an isolated library.');
} finally { await closeDesktopSession({ child }); }
report.status = 'passed';
await fs.writeFile(path.join(out, 'luma-installed-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
