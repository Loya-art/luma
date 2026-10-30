import { _electron } from 'playwright';
import electronPath from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Actual desktop verification, isolated from the user's production library.
// Electron API pattern: https://playwright.dev/docs/api/class-electron
const cwd = process.cwd();
const artifactDir = path.join(cwd, 'docs', 'acceptance');
const dataDir = process.env.SHIGUANG_E2E_DATA_DIR || path.join(cwd, 'tests', '.runtime', `e2e-${Date.now()}`);
const fixtureDir = path.join(cwd, 'tests', '.fixtures', '混合尺寸素材');
const packaged = Boolean(process.env.SHIGUANG_EXECUTABLE);
const smoke = Boolean(process.env.SMOKE_ONLY);
const prefix = packaged ? 'packaged-' : '';
await fs.mkdir(artifactDir, { recursive: true });
await fs.mkdir(dataDir, { recursive: true });
const report = { started: new Date().toISOString(), packaged, smoke, dataDir, checks: [], errors: [], metrics: {} };
let app, page;
const check = (name, details = true) => { report.checks.push({ name, details }); console.log(`PASS ${name}`, JSON.stringify(details)); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const result = await fn(); if (result) return result; await pause(150); }
  throw new Error(`Timed out: ${label}`);
}
async function snapshot() { return page.evaluate(() => window.album.getSnapshot()); }
async function shot(name) { await page.screenshot({ path: path.join(artifactDir, `${prefix}${name}.png`) }); console.log(`SCREENSHOT ${prefix}${name}.png`); }
async function launch() {
  const started = Date.now();
  app = await _electron.launch({ executablePath: process.env.SHIGUANG_EXECUTABLE || electronPath, args: packaged ? [] : [cwd], env: { ...process.env, SHIGUANG_DATA_DIR: dataDir, SHIGUANG_TEST_MODE: '1' }, timeout: 45000 });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 960 });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.log('RENDERER_ERROR', message.text().slice(0, 240)); });
  await page.waitForFunction(() => Boolean(window.album), null, { timeout: 30000 });
  await waitFor(async () => page.evaluate(() => Boolean(document.querySelector('[data-testid="gallery-viewport"]')) && !document.querySelector('.loading-state')), 'library initialized');
  report.metrics.startupMs = Date.now() - started;
  check('real Electron launch', { startupMs: report.metrics.startupMs, title: await page.title() });
}
async function close() { if (app) { await app.close(); app = null; } }
async function hashes(dir) {
  const result = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, await hashes(name));
    else result[name] = createHash('sha256').update(await fs.readFile(name)).digest('hex');
  }
  return result;
}
async function findTile(id) {
  const tile = page.locator(`[data-media-id="${id}"]`);
  await tile.waitFor({ state: 'visible', timeout: 15000 });
  return tile;
}
async function search(value) { await page.getByRole('textbox', { name: '搜索素材' }).fill(value); await pause(250); }

try {
  const beforeHashes = await hashes(fixtureDir);
  await launch();
  assert.equal((await snapshot()).media.length, 0);
  await shot('empty');
  check('fresh empty library');
  const importStarted = Date.now();
  await page.evaluate(dir => window.album.addSources([dir]), fixtureDir);
  const library = await waitFor(async () => {
    const data = await snapshot();
    return data.media.length === 44 && !data.jobs.some(job => job.type === 'scan' && job.status === 'running') ? data : null;
  }, '44 real media indexed', 90000);
  report.metrics.import44Ms = Date.now() - importStarted;
  assert.equal(library.errors.length, 1);
  assert.ok(library.errors[0].path.endsWith('.jpg'));
  check('mixed-format real import, corrupt file isolated', { count: library.media.length, errors: library.errors.length, importMs: report.metrics.import44Ms });
  const thumbs = await page.evaluate(async media => Promise.all(media.map(async item => {
    const response = await fetch(item.thumbnailUrl); const bitmap = await createImageBitmap(await response.blob());
    const value = { id: item.id, status: response.status, width: bitmap.width, height: bitmap.height }; bitmap.close(); return value;
  })), library.media);
  assert.ok(thumbs.every(item => item.status === 200 && item.width > 0 && item.height > 0));
  check('all 44 thumbnails decode');
  await pause(700); await shot('wall');
  const mainImage = library.media.find(item => item.kind === 'image' && !/gif|透明|长截图|旋转/i.test(item.fileName));
  const mp4 = library.media.find(item => item.fileName.endsWith('.mp4'));
  const mkv = library.media.find(item => item.fileName.endsWith('.mkv'));
  assert.ok(mainImage && mp4 && mkv);
  const protocolResults = await page.evaluate(async item => {
    const range = await fetch(item.originalUrl, { headers: { Range: 'bytes=0-31' } });
    const head = await fetch(item.originalUrl, { method: 'HEAD' });
    const invalid = await fetch(item.originalUrl, { headers: { Range: 'bytes=999999999999-' } });
    const unknown = await fetch('app-media://asset/unknown/original');
    return { range: range.status, bytes: (await range.arrayBuffer()).byteLength, contentRange: range.headers.get('content-range'), head: head.status, headBytes: (await head.arrayBuffer()).byteLength, invalid: invalid.status, unknown: unknown.status };
  }, mp4);
  assert.equal(protocolResults.range, 206); assert.equal(protocolResults.bytes, 32); assert.equal(protocolResults.head, 200); assert.equal(protocolResults.headBytes, 0); assert.equal(protocolResults.invalid, 416); assert.equal(protocolResults.unknown, 404);
  check('actual custom protocol Range / HEAD / invalid / unknown', protocolResults);
  if (!smoke) {
    await page.getByTestId('view-grid').click(); await page.getByTestId('fit-contain').click(); await pause(500);
    assert.equal(await page.getByTestId('fit-contain').getAttribute('class'), 'active');
    await shot('grid'); check('grid + complete display mode');
    await page.getByTestId('date-filters').click(); await page.getByTestId('date-from').fill('2099-01-01'); await pause(200);
    assert.equal(await page.getByTestId('media-tile').count(), 0);
    await page.getByRole('button', { name: '清除日期筛选', exact: true }).click();
    await page.getByRole('button', { name: '关闭日期筛选', exact: true }).click(); await pause(200);
    assert.ok(await page.getByTestId('media-tile').count() > 0); check('date range excludes and clear restores media');
    await page.getByTestId('fit-cover').click(); await pause(350);
    await page.getByTestId('view-wall').click(); await pause(250);
    const viewport = page.getByTestId('gallery-viewport'); const bounds = await viewport.boundingBox();
    const cameraBefore = (await snapshot()).settings.camera;
    await page.mouse.move(bounds.x + bounds.width - 100, bounds.y + bounds.height - 90); await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width - 180, bounds.y + bounds.height - 130, { steps: 8 }); await page.mouse.up(); await pause(650);
    const cameraAfter = (await snapshot()).settings.camera;
    assert.ok(cameraAfter.x !== cameraBefore.x || cameraAfter.y !== cameraBefore.y);
    await page.mouse.wheel(0, -140); await pause(650);
    assert.ok((await snapshot()).settings.camera.scale > cameraAfter.scale);
    check('wall pointer pan and mouse anchored zoom');
    await search(mainImage.fileName);
    const tile = await findTile(mainImage.id); await tile.click(); await pause(400);
    await page.locator('.selection-bar').getByRole('button', { name: '标签', exact: true }).click();
    await page.getByRole('textbox', { name: '标签名称' }).fill('验收标签，横竖混排');
    await page.getByRole('button', { name: '添加标签', exact: true }).click();
    await waitFor(async () => (await snapshot()).media.find(item => item.id === mainImage.id)?.tags.includes('验收标签'), 'tag mutation');
    await page.locator('.selection-bar').getByRole('button', { name: '收藏', exact: true }).click();
    await waitFor(async () => (await snapshot()).media.find(item => item.id === mainImage.id)?.favorite, 'favorite mutation');
    await page.getByTestId('create-album').click();
    await page.getByRole('textbox', { name: '新建相册', exact: true }).fill('验收相册');
    await page.getByRole('button', { name: '创建相册', exact: true }).click();
    const album = await waitFor(async () => (await snapshot()).albums.find(item => item.name === '验收相册'), 'create album');
    await page.locator('.nav-item').filter({ hasText: '全部素材' }).click(); await search(mainImage.fileName); await (await findTile(mainImage.id)).click(); await pause(350);
    await page.locator('.selection-bar').getByRole('button', { name: '加入相册', exact: true }).click();
    await page.locator('.album-options').getByRole('button').filter({ hasText: '验收相册' }).click();
    await waitFor(async () => (await snapshot()).media.find(item => item.id === mainImage.id)?.albumIds.includes(album.id), 'add media to album');
    check('UI tags, favorite, create album and add to album');
    await search('验收标签'); await pause(200); assert.equal(await page.getByTestId('media-tile').count(), 1); check('filename and tag search');
    await search(mainImage.fileName); await (await findTile(mainImage.id)).dblclick();
    await page.getByTestId('viewer').waitFor({ state: 'visible' });
    await page.waitForFunction(() => { const image = document.querySelector('.viewer-image'); return image?.complete && image.naturalWidth > 0; });
    await shot('viewer');
    await page.getByRole('button', { name: '1:1', exact: true }).click(); await pause(200); assert.equal(await page.locator('.zoom-tools span').textContent(), '100%');
    await page.keyboard.press('Escape'); await page.getByTestId('viewer').waitFor({ state: 'hidden' }); check('image viewer decode, 1:1 and Escape');
    await search(''); await page.getByRole('combobox', { name: '素材类型' }).selectOption('image');
    await page.getByTestId('view-grid').click(); await pause(250); await page.getByTestId('media-tile').first().dblclick();
    await page.getByTestId('viewer').waitFor({ state: 'visible' }); const firstViewerName = await page.locator('.viewer-title strong').textContent();
    await page.keyboard.press('ArrowRight'); await pause(200); assert.notEqual(await page.locator('.viewer-title strong').textContent(), firstViewerName);
    await page.keyboard.press('ArrowLeft'); await pause(200); assert.equal(await page.locator('.viewer-title strong').textContent(), firstViewerName);
    await page.keyboard.press('Escape'); await page.getByRole('combobox', { name: '素材类型' }).selectOption('all');
    check('viewer next / previous keyboard navigation');
    await search(mp4.fileName); const videoTile = await findTile(mp4.id); await videoTile.hover(); await pause(1100);
    const hoverState = await page.evaluate(() => { const videos = [...document.querySelectorAll('.tile-video')]; return { count: videos.length, muted: videos.every(video => video.muted), playing: videos.some(video => !video.paused && video.currentTime > 0) }; });
    assert.equal(hoverState.count, 1); assert.equal(hoverState.muted, true); assert.equal(hoverState.playing, true);
    await page.mouse.move(100, 30); await pause(250); assert.equal(await page.locator('.tile-video').count(), 0); check('single silent hover video starts and stops', hoverState);
    await videoTile.dblclick(); await page.getByTestId('viewer').waitFor({ state: 'visible' });
    await page.waitForFunction(() => { const video = document.querySelector('.viewer-video'); return video && video.readyState >= 2 && video.currentTime > 0; });
    const playback = await page.evaluate(async () => { const video = document.querySelector('.viewer-video'); video.currentTime = Math.min(2, video.duration / 2); await new Promise(resolve => setTimeout(resolve, 500)); return { muted: video.muted, duration: video.duration, currentTime: video.currentTime, readyState: video.readyState }; });
    assert.equal(playback.muted, false); assert.ok(playback.currentTime >= 1.5); check('real MP4 playback with audio enabled and seek', playback);
    await page.keyboard.press('Escape');
    const proxyStarted = Date.now();
    const proxy = await page.evaluate(id => window.album.prepareVideo(id), mkv.id);
    assert.ok(proxy.includes('/playable'));
    const proxyCheck = await page.evaluate(async url => { const video = document.createElement('video'); video.src = url; video.muted = true; document.body.appendChild(video); try { await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('proxy decode failed')); }); await video.play(); await new Promise(resolve => setTimeout(resolve, 350)); return { readyState: video.readyState, duration: video.duration, currentTime: video.currentTime }; } finally { video.pause(); video.remove(); } }, proxy);
    assert.ok(proxyCheck.readyState >= 2 && proxyCheck.duration > 0); check('incompatible MKV compatible cache proxy decodes', { ...proxyCheck, conversionMs: Date.now() - proxyStarted });
    assert.equal(await page.evaluate(id => window.album.prepareVideo(id), mkv.id), proxy); check('compatible playback cache reused');
    await search(''); await page.getByTestId('view-grid').click(); await page.getByTestId('fit-contain').click(); await pause(700);
    const settingsBeforeRestart = (await snapshot()).settings;
    await close(); await launch();
    const restarted = await snapshot(); const saved = restarted.media.find(item => item.id === mainImage.id);
    assert.ok(saved.favorite && saved.tags.includes('验收标签') && saved.albumIds.includes(album.id));
    assert.equal(restarted.settings.view, settingsBeforeRestart.view); assert.equal(restarted.settings.fit, settingsBeforeRestart.fit); assert.deepEqual(restarted.settings.camera, settingsBeforeRestart.camera);
    check('normal restart preserves tags, favorites, albums, view and camera');
    await page.getByTestId('view-wall').click(); await page.getByTestId('fit-cover').click(); await pause(400);
  }
  assert.deepEqual(await hashes(fixtureDir), beforeHashes); check('all original fixture files unchanged');
  assert.equal(report.errors.length, 0); check('no unhandled renderer exceptions');
  await shot('wall-final'); report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error.stack || String(error); console.error(report.failure);
  if (page) await shot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await close().catch(error => console.error(error));
  report.finished = new Date().toISOString();
  await fs.writeFile(path.join(artifactDir, `${prefix}e2e-report.json`), JSON.stringify(report, null, 2));
  console.log(`REPORT ${path.join(artifactDir, `${prefix}e2e-report.json`)}`);
}
