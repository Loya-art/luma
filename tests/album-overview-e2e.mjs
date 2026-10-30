import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright';

// Exercise the actual production App/AlbumHome in a truly headless browser. No
// Electron, user profile, real image directory or visible desktop window is used.
const out = path.resolve('docs/acceptance');
await fs.mkdir(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), visibleWindowsStarted: false, checks: [], errors: [] };
const folders = [
  ...Array.from({ length: 24 }, (_, i) => `E:/照片/旅行 ${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 12 }, (_, i) => `E:/Games/Game${String(i + 1).padStart(2, '0')}/Screenshots`),
  ...Array.from({ length: 6 }, (_, i) => `E:/ComfyUI/output/创作 ${String(i + 1).padStart(2, '0')}`),
  'E:/Games/Game01/textures',
  'E:/Documents/WeChat Files/account/FileStorage/Image',
];
const cover = i => 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="${['#626c75','#a7917b','#8c9b8c','#7c859c','#a9a69c'][i % 5]}"/><circle cx="${80 + i * 17 % 420}" cy="110" r="75" fill="#ffffff" opacity=".25"/><path d="M0 400L200 155L350 320L480 160L600 400" fill="#151515" opacity=".25"/></svg>`).toString('base64');
const settings = { view: 'wall', fit: 'cover', sizingMode: 'balanced', focusTint: true, lighting: 'light', seed: 17, gap: 8, thumbSize: 240, sidebarOpen: false, camera: { x: 48, y: 48, scale: .85 }, lastSelectedId: null };
const snapshot = { media: folders.map((folder, i) => ({ id: `photo-${i}`, sourceId: 'fixture', path: folder + '/照片.png', fileName: '照片.png', kind: 'image', width: 600, height: 400, duration: null, size: 150000, mtimeMs: 1, addedAt: i + 1, openCount: 0, lastOpenedAt: null, takenAt: null, favorite: false, missing: false, tags: [], aiTags: [], albumIds: [], thumbnailUrl: cover(i), previewUrl: cover(i), originalUrl: cover(i) })), sources: [{ id: 'fixture', path: 'E:/', name: '测试照片', status: 'online', count: folders.length }], albums: [], tags: [], settings, jobs: [], errors: [] };
let vite, browserServer, browser, page;
const check = value => { report.checks.push(value); console.log('PASS', value); };
try {
  vite = await preview({ root: process.cwd(), preview: { host: '127.0.0.1', port: 0, open: false } });
  browserServer = await chromium.launchServer({ channel: 'msedge', headless: true });
  browser = await chromium.connect(browserServer.wsEndpoint());
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
  await context.addInitScript(initial => {
    let data = initial, listener;
    window.__replaceAlbumSnapshot = next => { data = next; listener?.({ type: 'library' }); };
    window.album = {
      getSnapshot: async () => structuredClone(data),
      onChange: callback => { listener = callback; return () => { if (listener === callback) listener = null; }; },
      setSettings: async patch => { data.settings = { ...data.settings, ...patch }; },
      searchMedia: async () => ({ hits: [], total: 0, offset: 0, limit: 120, semanticReady: false }),
      chooseFolders: async () => [], addSources: async () => {}, rescan: async () => {},
      computerLocations: async () => [],
      computerDiscoveryState: async () => ({ id: 'large-scan', status: 'complete', roots: ['E:/'], visitedDirectories: 2200, skippedDirectories: 0, filteredDirectories: 0, filtered: [], count: 2164, bytes: 2164 * 1024, issueCount: 0, issues: [], folders: Array.from({ length: 2164 }, (_, i) => ({ path: `E:/Candidate-${i}`, name: `Candidate-${i}`, count: 1, photos: 1, videos: 0, bytes: 1024, recommended: i < 12, recommendation: i < 12 ? '照片目录' : '用途待确认', previewUrl: initial.media[0].thumbnailUrl })) }),
      addDiscoveredFolders: async (scanId, paths) => { window.__discoveryAdded = { scanId, paths }; },
    };
  }, snapshot);
  page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(vite.resolvedUrls.local[0]);
  await page.getByTestId('album-overview-wall').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="album-card"]').length === 42);
  const wall = page.getByTestId('album-overview-wall');
  assert.equal(await page.locator('.album-carousel').count(), 0);
  const simultaneous = await wall.evaluate(element => { const area = element.getBoundingClientRect(); return [...element.querySelectorAll('[data-testid="album-card"]')].filter(card => { const box = card.getBoundingClientRect(); return box.top >= area.top && box.bottom <= area.bottom && box.left >= area.left && box.right <= area.right; }).length; });
  assert.ok(simultaneous >= 12, `Expected many simultaneous covers, got ${simultaneous}`);
  report.simultaneousCovers = simultaneous;
  await page.screenshot({ path: path.join(out, 'album-overview-wall.png') });
  check('Default home displays many album covers together; game screenshots and ComfyUI outputs remain visible.');

  await page.getByRole('textbox', { name: '搜索相册', exact: true }).fill('Game09');
  assert.equal(await page.getByTestId('album-card').count(), 1);
  await page.getByTestId('album-card').click();
  await page.getByTestId('home-albums').waitFor({ state: 'detached' });
  await page.getByTestId('media-tile').first().waitFor();
  await page.getByTestId('back-albums').click();
  await page.getByTestId('album-overview-wall').waitFor();
  assert.equal(await page.getByRole('textbox', { name: '搜索相册', exact: true }).inputValue(), 'Game09');
  assert.equal(await page.getByTestId('album-card').count(), 1);
  await page.getByRole('button', { name: '清空相册搜索', exact: true }).click();
  check('Album name/path search narrows results; clicking a cover directly opens the album and Back preserves the search.');

  await wall.evaluate(element => { element.scrollTop = 500; });
  await page.waitForTimeout(100);
  const position = await wall.evaluate(element => { const area = element.getBoundingClientRect(); const cards = [...element.querySelectorAll('[data-testid="album-card"]')]; return { top: element.scrollTop, index: cards.findLastIndex(card => { const box = card.getBoundingClientRect(); return box.top >= area.top && box.bottom <= area.bottom; }) }; });
  assert.ok(position.top > 200 && position.index > 10);
  await page.getByTestId('album-card').nth(position.index).click();
  await page.getByTestId('home-albums').waitFor({ state: 'detached' });
  await page.getByTestId('back-albums').click();
  await wall.waitFor();
  assert.ok(Math.abs(await wall.evaluate(element => element.scrollTop) - position.top) < 5);
  check('Returning from an album restores the overview scroll position.');

  await page.getByTestId('album-view-focus').click();
  await page.locator('.album-carousel').waitFor();
  assert.ok(await page.getByTestId('album-card').count() <= 7);
  await page.getByTestId('open-album').click();
  await page.getByTestId('home-albums').waitFor({ state: 'detached' });
  await page.getByTestId('back-albums').click();
  await page.locator('.album-carousel').waitFor();
  assert.equal(await page.getByTestId('album-view-focus').getAttribute('aria-pressed'), 'true');
  await page.getByTestId('album-view-overview').click();
  check('Focused carousel remains optional and retains its mode when returning from a photo wall.');

  await page.getByRole('button', { name: '显示其他文件夹 · 2', exact: true }).click();
  assert.equal(await page.getByTestId('album-card').count(), 44);
  await page.getByRole('button', { name: '收起其他文件夹', exact: true }).click();
  assert.equal(await page.getByTestId('album-card').count(), 42);
  await page.getByTestId('search-toggle').click();
  assert.equal(await page.getByRole('textbox', { name: '搜索相册', exact: true }).evaluate(element => document.activeElement === element), true);
  await page.getByRole('textbox', { name: '搜索相册', exact: true }).fill('不存在的相册');
  await page.getByText('没有找到这个相簿', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('album-card').count(), 0);
  await page.getByRole('button', { name: '清空相册搜索', exact: true }).click();
  await page.evaluate(empty => window.__replaceAlbumSnapshot(empty), { ...snapshot, media: [], sources: [] });
  await page.getByRole('button', { name: '添加文件夹', exact: true }).waitFor();
  check('Utility directories are reversibly hidden; home search shortcut, no-results and empty-library states work.');
  await page.getByTestId('import-folder').click(); await page.getByTestId('import-computer-scan').click();
  await page.waitForFunction(() => document.querySelectorAll('.computer-folder-list label').length === 12);
  assert.equal(await page.locator('.computer-folder-list input:checked').count(), 0);
  assert.equal(await page.getByTestId('add-computer-results').isDisabled(), true);
  await page.waitForFunction(() => [...document.querySelectorAll('img.computer-folder-preview')].every(image => image.complete && image.naturalWidth > 0));
  await page.getByRole('button', { name: /^全部候选/ }).click();
  assert.equal(await page.locator('.computer-folder-list label').count(), 40);
  await page.getByRole('button', { name: /^选择已显示的/ }).click();
  await page.getByText('已选 40 个文件夹 · 40 项', { exact: true }).waitFor();
  await page.getByRole('button', { name: '清空选择', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索扫描结果' }).fill('Candidate-2163');
  assert.equal(await page.locator('.computer-folder-list label').count(), 1);
  await page.locator('.computer-folder-list input').check();
  await page.getByTestId('add-computer-results').click();
  assert.deepEqual(await page.evaluate(() => window.__discoveryAdded), { scanId: 'large-scan', paths: ['E:/Candidate-2163'] });
  check('A 2,164-directory scan starts with 12 recommendations and zero selections; preview rendering is paged and search adds only the explicitly chosen directory.');
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(out, 'album-overview-failure.png') }).catch(() => {});
  console.error(error);
} finally {
  await browser?.close().catch(() => {});
  if (browserServer) { let timer; try { await Promise.race([browserServer.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Headless browser close timed out')), 8000); })]); } catch { await browserServer.kill(); } finally { clearTimeout(timer); } }
  if (vite) await new Promise((resolve, reject) => vite.httpServer.close(error => error ? reject(error) : resolve()));
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(out, 'album-overview-report.json'), JSON.stringify(report, null, 2));
}
