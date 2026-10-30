import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { _electron } from 'playwright';
import electron from 'electron';
import sharp from 'sharp';
import { closeDesktopSession } from '../scripts/desktop-session.mjs';

const out = path.resolve('docs/acceptance');
const root = await fs.mkdtemp(path.resolve('tests/.runtime/scan-video-'));
const profile = path.join(root, 'profile'), media = path.join(root, 'Pictures');
await fs.mkdir(profile, { recursive: true });
const production = path.join(process.env.APPDATA, '拾光');
const original = new DatabaseSync(path.join(production, 'library.sqlite'), { readOnly: true });
let rows;
try { await backup(original, path.join(profile, 'library.sqlite')); rows = original.prepare('SELECT id,mtime_ms FROM media WHERE excluded=0 AND trashed_at IS NULL').all(); }
finally { original.close(); }
await fs.mkdir(path.join(profile, 'MediaCache'), { recursive: true });
for (const row of rows) {
  const file = `${row.id}-${Math.round(row.mtime_ms)}-thumbnail.webp`;
  try { await fs.writeFile(path.join(profile, 'MediaCache', file), await fs.readFile(path.join(production, 'MediaCache', file))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
for (const name of ['Camera/原片.png', 'Screenshots/游戏截图.png', 'code/src/软件示意.png']) {
  const file = path.join(media, name); await fs.mkdir(path.dirname(file), { recursive: true });
  await sharp({ create: { width: 180, height: 120, channels: 3, background: '#909090' } }).png().toFile(file);
}
const report = { startedAt: new Date().toISOString(), checks: [], errors: [], visibleWindowsStarted: false, productionProfileReadOnly: true, packaged: !!process.env.SHIGUANG_EXECUTABLE };
const check = message => { report.checks.push(message); console.log('PASS', message); };
const until = async (predicate, label, timeout = 30000) => { const end = Date.now() + timeout; while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 75)); } throw Error('Timed out: ' + label); };
let app, child, page;
try {
  const env = { ...process.env, SHIGUANG_DATA_DIR: profile, SHIGUANG_TEST_MODE: '1', SHIGUANG_HIDDEN_TEST: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  app = await _electron.launch({ executablePath: process.env.SHIGUANG_EXECUTABLE || electron, args: process.env.SHIGUANG_EXECUTABLE ? [] : [process.cwd()], env, timeout: 45000 });
  child = app.process(); page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByTestId('home-albums').waitFor();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible())), false);
  let snapshot = await until(async () => { const value = await page.evaluate(() => window.album.getSnapshot()); return value.media.length >= rows.length && !value.jobs.some(job => job.status === 'running') ? value : null; }, 'cloned real library startup', 90000);
  const images = await page.evaluate(async media => {
    const failed = [], queue = [...media]; let decoded = 0;
    await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) { const item = queue.shift(); try { const response = await fetch(item.thumbnailUrl); if (!response.ok) throw Error('HTTP ' + response.status); const bitmap = await createImageBitmap(await response.blob()); if (!bitmap.width) throw Error('empty bitmap'); bitmap.close(); decoded++; } catch { failed.push(item.id); } } }));
    return { decoded, failed };
  }, snapshot.media.filter(item => !item.missing));
  report.nativeThumbnails = images; assert.equal(images.failed.length, 0);
  await until(() => page.locator('.album-overview-cover img').evaluateAll(images => images.length > 0 && images.filter(img => { const rect = img.getBoundingClientRect(); return rect.top > 150 && rect.bottom < innerHeight - 90; }).every(img => img.complete && img.naturalWidth > 0)), 'actual album covers displayed');
  check(`${images.decoded} real library thumbnails decode through the native media protocol; album covers display.`);

  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.getByTestId('gallery-viewport').waitFor();
  await page.getByTestId('home-albums').waitFor({ state: 'detached' });
  await page.getByTestId('more-toggle').click();
  await page.getByRole('combobox', { name: '素材类型' }).selectOption('video');
  await page.getByRole('button', { name: '关闭选项', exact: true }).click();
  await page.getByTestId('options-panel').waitFor({ state: 'detached' });
  const clicked = await until(() => page.locator('[data-testid="media-tile"]').evaluateAll(tiles => {
    const rect = document.querySelector('[data-testid="gallery-viewport"]').getBoundingClientRect();
    return tiles.map(tile => ({ tile, box: tile.getBoundingClientRect() })).filter(({ box }) => box.width > 50 && box.height > 50 && box.x > rect.x + 25 && box.y > rect.y + 75 && box.right < rect.right - 25 && box.bottom < rect.bottom - 110).map(({ tile, box }) => ({ id: tile.dataset.mediaId, instance: tile.dataset.instanceId, x: box.x + box.width / 2, y: box.y + box.height / 2 }))[0];
  }), 'visible real video');
  const expected = snapshot.media.find(item => item.id === clicked.id); assert.equal(expected.kind, 'video');
  report.videoHit = await page.evaluate(({ x, y }) => { const element = document.elementFromPoint(x, y); return { tag: element?.tagName, class: element?.className, mediaId: element?.closest('[data-media-id]')?.getAttribute('data-media-id') }; }, clicked);
  assert.equal(report.videoHit.mediaId, clicked.id, 'The click point must hit the intended video.');
  const cameraBefore = await page.getByTestId('gallery-world').evaluate(element => getComputedStyle(element).transform);
  await page.locator(`[data-instance-id="${clicked.instance}"]`).click({ position: { x: 20, y: 30 } });
  await page.getByTestId('viewer').waitFor();
  assert.equal(await page.locator('.viewer-title strong').textContent(), expected.fileName);
  assert.equal(await page.getByTestId('gallery-world').evaluate(element => getComputedStyle(element).transform), cameraBefore);
  assert.equal(await page.locator('.media-tile.focused').count(), 0);
  await until(() => page.locator('.viewer-video').evaluate(video => video.readyState >= 2), 'real video is playable', 45000);
  await page.keyboard.press('Escape'); await page.getByTestId('viewer').waitFor({ state: 'detached' });
  check('A single click opens the exact clicked video and plays it without moving the wall or selecting its neighbor.');
  await page.getByTestId('back-albums').click();
  await page.getByTestId('home-albums').waitFor();

  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, media);
  await page.getByTestId('import-folder').click(); await page.getByTestId('import-computer-scan').click();
  await until(() => page.locator('.computer-location-list label').count(), 'scope locations loaded');
  for (const checkbox of await page.locator('.computer-location-list input').all()) if (await checkbox.isChecked()) await checkbox.uncheck();
  await page.getByRole('button', { name: '选择其他文件夹', exact: true }).click();
  await page.getByTestId('start-computer-scan').click();
  await until(async () => (await page.evaluate(() => window.album.computerDiscoveryState())).status === 'complete', 'scan complete');
  await until(async () => await page.locator('.computer-folder-list label').count() === 2, 'only recommended directories initially shown');
  assert.equal(await page.locator('.computer-folder-list input:checked').count(), 0);
  assert.equal(await page.getByTestId('add-computer-results').isDisabled(), true);
  await until(() => page.locator('.computer-folder-preview').evaluateAll(images => images.length === 2 && images.every(image => image.tagName === 'IMG' && image.complete && image.naturalWidth > 0)), 'native scan previews displayed');
  await page.getByRole('button', { name: '全部候选 · 3', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索扫描结果' }).fill('code');
  assert.equal(await page.locator('.computer-folder-list label').count(), 1);
  assert.equal(await page.locator('.computer-folder-list input:checked').count(), 0);
  const after = await page.evaluate(() => window.album.getSnapshot()); assert.equal(after.media.length, snapshot.media.length);
  check('Real scan previews load before import; recommendations hide project images, all candidates remain searchable, and no folder is preselected or imported.');
  await page.screenshot({ path: path.join(out, 'scan-video-regression.png') });
  assert.deepEqual(report.errors, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = String(error); console.error(error); process.exitCode = 1; }
finally {
  if (app) { let timer; try { await Promise.race([app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Test app close timed out')), 8000); })]); } catch {} finally { clearTimeout(timer); } }
  await closeDesktopSession({ child });
  report.finishedAt = new Date().toISOString();
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'scan-video-regression-report.json'), JSON.stringify(report, null, 2));
}
