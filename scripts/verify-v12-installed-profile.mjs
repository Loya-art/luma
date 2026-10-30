import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { assertDebuggingPortAvailable, closeDesktopSession } from './desktop-session.mjs';

const out = path.resolve('docs/acceptance');
const receipt = JSON.parse((await fs.readFile(path.join(out, 'installation.json'), 'utf8')).replace(/^\uFEFF/, ''));
const packageInfo = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8'));
assert.equal(receipt.productVersion, packageInfo.version + '.0');
const saved = new DatabaseSync(receipt.userDataBackup.path, { readOnly: true });
const fields = 'id,favorite,excluded,tags,albums,open_count,last_opened_at';
const classifications = saved.prepare(`SELECT ${fields} FROM media ORDER BY id`).all();
const visibleCount = saved.prepare('SELECT COUNT(*) count FROM media WHERE excluded=0 AND trashed_at IS NULL').get().count;
const sources = saved.prepare('SELECT id,path FROM sources ORDER BY id').all();
const albums = saved.prepare('SELECT * FROM albums ORDER BY id').all();
const copiedFiles = saved.prepare('SELECT local_path,sha256 FROM phone_manifest LIMIT 8').all();
saved.close();
const env = { ...process.env };
for (const key of ['SHIGUANG_DATA_DIR', 'SHIGUANG_TEST_MODE', 'ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE']) delete env[key];
const leaveOpen = process.argv.includes('--leave-open');
await assertDebuggingPortAvailable(9238);
const child = spawn(receipt.executable, ['--remote-debugging-port=9238', '--remote-debugging-address=127.0.0.1'], { detached: leaveOpen, stdio: 'ignore', windowsHide: !leaveOpen, env });
if (leaveOpen) child.unref();
let launchError; child.once('error', error => { launchError = error; });
let browser;
try {
for (let attempt = 0; attempt < 60; attempt++) {
  if (launchError) throw launchError;
  if (child.exitCode !== null) throw new Error('安装版测试进程在连接前已退出');
  try { browser = await chromium.connectOverCDP('http://127.0.0.1:9238'); break; }
  catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
}
assert.ok(browser, 'Installed app must start.');
let page;
for (let attempt = 0; !page && attempt < 60; attempt++) {
  page = browser.contexts()[0].pages().find(item => item.url().startsWith('file:'));
  if (!page) await new Promise(resolve => setTimeout(resolve, 500));
}
assert.ok(page);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.getByTestId('home-albums').waitFor({ timeout: 60000 });
let snapshot;
for (let attempt = 0; attempt < 180; attempt++) {
  snapshot = await page.evaluate(() => window.album.getSnapshot());
  if (snapshot.media.length >= visibleCount && !snapshot.jobs.some(item => item.status === 'running')) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.ok(snapshot.media.length >= visibleCount, 'Upgrade must preserve existing media.');
const current = new DatabaseSync(path.join(process.env.APPDATA, '拾光', 'library.sqlite'), { readOnly: true });
assert.deepEqual(current.prepare('SELECT id,path FROM sources ORDER BY id').all(), sources);
assert.deepEqual(current.prepare('SELECT * FROM albums ORDER BY id').all(), albums);
for (const row of classifications) assert.deepEqual(current.prepare(`SELECT ${fields} FROM media WHERE id=?`).get(row.id), row);
const phoneJobs = current.prepare('SELECT data FROM phone_jobs').all().map(row => JSON.parse(row.data));
current.close();
for (const row of copiedFiles) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(row.local_path)) hash.update(chunk);
  assert.equal(hash.digest('hex'), row.sha256);
}
const thumbs = snapshot.media.filter(item => !item.missing && item.path.startsWith('E:\\手机照片\\')).slice(0, 8);
assert.ok(thumbs.length);
const decoded = await page.evaluate(async items => Promise.all(items.map(async item => {
  try { const response = await fetch(item.thumbnailUrl); const bitmap = await createImageBitmap(await response.blob()); const valid = response.ok && bitmap.width > 0; bitmap.close(); return valid; }
  catch { return false; }
})), thumbs);
assert.ok(decoded.every(Boolean));
assert.equal((await page.evaluate(() => window.album.phoneReceiveState())).active, false);
await page.getByTestId('import-folder').click();
await page.getByTestId('import-phone-receive').click();
const dialog = page.getByRole('dialog', { name: '手机无线传入' });
await dialog.waitFor();
const palette = await dialog.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color }));
for (const value of Object.values(palette)) { const channels = value.match(/[\d.]+/g).map(Number); assert.equal(channels[0], channels[1]); assert.equal(channels[1], channels[2]); }
await page.screenshot({ path: path.join(out, '1.2-installed-wireless-entry.png') });
await page.getByRole('button', { name: '关闭无线传入面板' }).click();
await page.getByTestId('import-folder').click();
await page.getByTestId('import-computer-scan').click();
await page.getByRole('dialog', { name: '扫描电脑照片' }).waitFor();
await page.getByRole('button', { name: '全部磁盘', exact: true }).waitFor();
await page.screenshot({ path: path.join(out, '1.2-installed-computer-entry.png') });
await page.getByRole('button', { name: '关闭电脑扫描' }).click();
await page.screenshot({ path: path.join(out, '1.2-installed-default-home.png') });
assert.deepEqual(errors, []);
const report = { status: 'passed', checkedAt: new Date().toISOString(), installedVersion: receipt.productVersion, executable: receipt.executable, defaultProfile: true, pid: child.pid, media: snapshot.media.length, sources: snapshot.sources.length, existingClassificationsPreserved: classifications.length, originalHashesVerified: copiedFiles.length, decodedThumbnails: decoded.length, phoneJobs, palette, errors, libraryReadIssues: snapshot.errors.length, checks: ['Existing default-profile sources, albums and classifications survive the installer upgrade.', 'Original phone backup bytes match SHA-256; imported previews decode.', 'Neutral glass and both new entry points exist in the installed default profile.', 'No LAN listener starts without the explicit receive action.'] };
await fs.writeFile(path.join(out, '1.2-installed-default-profile-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
} finally {
  await closeDesktopSession({ browser, child, leaveOpen });
}
