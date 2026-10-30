import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { _electron } from 'playwright';
import electronPath from 'electron';
import sharp from 'sharp';

const root = path.resolve(`tests/.runtime/computer-ui-${Date.now()}`), profile = path.join(root, 'profile'), media = path.join(root, '测试图集');
const out = path.resolve('docs/acceptance');
await fs.mkdir(profile, { recursive: true }); await fs.mkdir(out, { recursive: true });
for (const [file, color] of [['01.png', '#b6b6b6'], ['02.png', '#777777'], ['不选择子相簿/child.png', '#999999'], ['node_modules/cache.png', '#555555']]) { const target = path.join(media, file); await fs.mkdir(path.dirname(target), { recursive: true }); await sharp({ create: { width: 480, height: 320, channels: 3, background: color } }).png().toFile(target); }
const originalHash = createHash('sha256').update(await fs.readFile(path.join(media, '01.png'))).digest('hex');
const app = await _electron.launch({ executablePath: process.env.SHIGUANG_EXECUTABLE || electronPath, args: process.env.SHIGUANG_EXECUTABLE ? [] : [process.cwd()], env: { ...process.env, SHIGUANG_DATA_DIR: profile, SHIGUANG_TEST_MODE: '1', SHIGUANG_HIDDEN_TEST: '1' }, timeout: 60000 });
const errors = [];
const report = { startedAt: new Date().toISOString(), profile, checks: [], errors, packaged: Boolean(process.env.SHIGUANG_EXECUTABLE) };
async function until(predicate, label, timeout = 30000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Timed out: ' + label); }
let page;
try {
  page = await app.firstWindow(); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.setViewportSize({ width: 1440, height: 960 }); page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('home-albums').waitFor();
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, media);
  await page.getByTestId('import-folder').click(); await page.getByTestId('import-computer-scan').click();
  await page.getByRole('dialog', { name: '扫描电脑照片' }).waitFor();
  await until(async () => (await page.locator('.computer-location-list label').count()) > 0, 'locations loaded');
  for (const box of await page.locator('.computer-location-list input').all()) if (await box.isChecked()) await box.uncheck();
  await page.getByRole('button', { name: '选择其他文件夹', exact: true }).click();
  await until(async () => (await page.locator('.computer-location-list input:checked').count()) === 1, 'only fixture selected');
  await page.getByTestId('start-computer-scan').click();
  await until(async () => (await page.evaluate(() => window.album.computerDiscoveryState())).status === 'complete', 'read-only discovery');
  await page.getByRole('button', { name: /^全部候选/ }).click();
  await until(async () => (await page.locator('.computer-folder-list label').count()) === 2, 'visible folder results');
  const state = await page.evaluate(() => window.album.computerDiscoveryState()); assert.equal(state.count, 3); assert.equal(state.skippedDirectories, 1);
  assert.equal((await page.evaluate(() => window.album.getSnapshot())).media.length, 0, 'Discovery alone must not add media.');
  assert.equal(await page.locator('.computer-folder-list input:checked').count(), 0);
  await page.getByRole('checkbox', { name: `选择 ${media}`, exact: true }).check();
  await page.screenshot({ path: path.join(out, '1.2-computer-discovery.png') });
  await page.getByTestId('add-computer-results').click();
  const snapshot = await until(async () => { const snapshot = await page.evaluate(() => window.album.getSnapshot()); return snapshot.media.length === 2 && !snapshot.jobs.some(job => job.status === 'running') ? snapshot : null; }, 'selected folder indexed');
  assert.equal(snapshot.sources.length, 1); assert.equal(snapshot.media.every(item => ['01.png', '02.png'].includes(item.fileName)), true); assert.equal(snapshot.errors.length, 0);
  assert.equal(createHash('sha256').update(await fs.readFile(path.join(media, '01.png'))).digest('hex'), originalHash);
  await page.getByRole('button', { name: '关闭电脑扫描', exact: true }).click(); await page.getByTestId('album-card').first().click();
  assert.equal((await page.evaluate(() => window.album.getSnapshot())).media.length, 2);
  assert.deepEqual(errors, []);
  report.checks.push('Plus menu opens computer discovery and offers actual local disk/common-folder locations', 'Only explicitly selected fixture root is scanned; excluded cache is skipped', 'Discovery remains read-only until Add is clicked', 'Unchecking a child folder excludes its original from indexing', 'Selected folder creates an album without moving or changing any original', 'No renderer exceptions');
  report.status = 'passed'; console.log(JSON.stringify(report));
} catch (error) { report.status = 'failed'; report.failure = String(error); if (page) await page.screenshot({ path: path.join(out, '1.2-computer-discovery-failure.png') }); throw error; }
finally { await app.close(); report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(out, '1.2-computer-discovery-report.json'), JSON.stringify(report, null, 2)); }
