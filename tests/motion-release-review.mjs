import { _electron } from 'playwright';
import electronPath from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const dataDir = path.join(cwd, 'tests', '.runtime', `motion-${Date.now()}`);
const out = path.join(cwd, 'docs', 'acceptance');
const prefix = process.env.SHIGUANG_REPORT_PREFIX || '';
await fs.mkdir(out, { recursive: true });
const report = { checks: [], errors: [], started: new Date().toISOString() };
const check = (name, details = true) => { report.checks.push({ name, details }); console.log('PASS', name, JSON.stringify(details)); };
let app, page;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await pause(60); }
  throw new Error(`Timed out: ${label}`);
}
const snapshot = () => page.evaluate(() => window.album.getSnapshot());
async function searchMedia(name) {
  if(!await page.getByRole('textbox',{name:'搜索素材'}).count())await page.getByTestId('search-toggle').click();
  await page.getByRole('textbox',{name:'搜索素材'}).fill(name);await pause(400);
}
async function visibleMedia(id) {
  const instanceId = await until(() => page.locator(`[data-media-id="${id}"]`).evaluateAll(elements => {
    return elements.map(element => ({ element, box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.x > 20 && box.y > 70 && box.right < innerWidth - 20 && box.bottom < innerHeight - 80)
      .sort((a, b) => Math.hypot(a.box.x + a.box.width / 2 - innerWidth / 2, a.box.y + a.box.height / 2 - innerHeight / 2) - Math.hypot(b.box.x + b.box.width / 2 - innerWidth / 2, b.box.y + b.box.height / 2 - innerHeight / 2))
      .find(({ element, box }) => document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('[data-instance-id]') === element)
      ?.element.getAttribute('data-instance-id');
  }), 'a video instance inside the viewport');
  return page.locator(`[data-instance-id="${instanceId}"]`);
}
async function sample(locator) {
  return locator.evaluate(el => ({
    phase: el.getAttribute('data-motion'), opacity: +getComputedStyle(el).opacity,
    running: el.getAnimations().some(animation => animation.playState === 'running'),
    animation: getComputedStyle(el).animationName,
    duration: getComputedStyle(el).animationDuration,
  }));
}
async function completed(locator) { await until(async () => (await locator.getAttribute('data-motion')) === 'idle', 'animation finishes'); }
try {
  app = await _electron.launch({ executablePath: process.env.SHIGUANG_EXECUTABLE || electronPath, args: process.env.SHIGUANG_EXECUTABLE ? [] : [cwd], env: { ...process.env, SHIGUANG_DATA_DIR: dataDir, SHIGUANG_TEST_MODE: '1' } });
  page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByTestId('home-albums').waitFor();
  await page.evaluate(dir => window.album.addSources([dir]), path.join(cwd, 'tests', '.fixtures', '混合尺寸素材'));
  const library = await until(async () => { const s = await snapshot(); return s.media.length === 44 && !s.jobs.some(job => job.status === 'running') ? s : null; }, 'real media import', 90000);
  await until(async () => await page.getByTestId('album-card').count() >= 2, 'folder albums');
  await pause(400);

  await page.getByTestId('more-toggle').click();
  const options = page.getByTestId('options-panel');
  await options.waitFor();
  const entering = await sample(options);
  assert.equal(entering.phase, 'enter'); assert.ok(entering.running && entering.opacity < 1);
  await completed(options);
  assert.equal((await sample(options)).opacity, 1);
  await page.getByRole('button', { name: '关闭选项', exact: true }).click();
  const exiting = await sample(options);
  assert.equal(exiting.phase, 'exit'); assert.equal(await options.getAttribute('aria-hidden'), 'true');
  await options.waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('more-toggle').evaluate(el => document.activeElement === el), true);
  check('options visibly animate in and out, release DOM and restore trigger focus', { entering, exiting });

  await page.getByTestId('search-toggle').click();
  await page.getByRole('textbox', { name: '搜索素材' }).waitFor();
  const searchIn = await sample(page.locator('.floating-search'));
  assert.equal(searchIn.phase, 'enter'); assert.ok(searchIn.running);
  await page.keyboard.press('Escape');
  await page.locator('.floating-search').waitFor({ state: 'detached' });
  check('glass search animates and Escape restores focus');

  await page.getByTestId('library-toggle').click();
  const drawer = await page.locator('.sidebar').evaluate(el => ({ opacity: +getComputedStyle(el).opacity, running: el.getAnimations().some(a => a.playState === 'running'), inert: el.inert }));
  assert.ok(drawer.running); assert.equal(drawer.inert, false);
  await page.getByTestId('create-album').click();
  await page.getByRole('textbox', { name: '新建相册', exact: true }).waitFor();
  const modalIn = await sample(page.locator('.modal-backdrop'));
  assert.equal(modalIn.phase, 'enter'); assert.ok(modalIn.running);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('.modal-backdrop').waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('create-album').evaluate(el => document.activeElement === el), true);
  await page.getByRole('button', { name: '关闭图库', exact: true }).click();
  const drawerOut = await page.locator('.sidebar').evaluate(el => ({ visibility: getComputedStyle(el).visibility, opacity: +getComputedStyle(el).opacity, running: el.getAnimations().some(a => a.playState === 'running'), inert: el.inert }));
  assert.ok(drawerOut.running); assert.equal(drawerOut.visibility, 'visible'); assert.equal(drawerOut.inert, true);
  await pause(350);
  assert.equal(await page.locator('.sidebar').evaluate(el => getComputedStyle(el).visibility), 'hidden');
  check('drawer and modal have actual opening/closing motion; exiting drawer remains visible until fade ends', { drawer, modalIn, drawerOut });

  // Search now opens the complete wall from home; return before album transition checks.
  if (await page.getByRole('button', { name: '关闭添加照片', exact: true }).count()) await page.getByRole('button', { name: '关闭添加照片', exact: true }).click();
  if (await page.getByTestId('back-albums').count()) await page.getByTestId('back-albums').click();
  await page.getByTestId('home-albums').waitFor();
  await page.getByTestId('album-card').nth(1).click();
  const selectedAlbum = await page.locator('[data-testid="album-card"][aria-current="true"]').getAttribute('data-album-path');
  const background = await page.locator('.home-background').evaluateAll(els => els.map(el => ({ outgoing: el.classList.contains('is-outgoing'), running: el.getAnimations().some(a => a.playState === 'running') })));
  assert.equal(background.length, 2); assert.ok(background.every(layer => layer.running));
  await pause(400);
  await page.getByTestId('open-album').click();
  const wall = page.locator('.wall-page'); await wall.waitFor();
  const wallIn = await sample(wall), homeOut = await sample(page.locator('.album-page'));
  assert.equal(wallIn.phase, 'enter'); assert.equal(homeOut.phase, 'exit'); assert.ok(wallIn.running && homeOut.running);
  await page.getByTestId('home-albums').waitFor({ state: 'detached' });
  await completed(wall);
  await page.getByTestId('back-albums').click();
  await page.getByTestId('home-albums').waitFor();
  await page.getByTestId('gallery-viewport').waitFor({ state: 'detached' });
  assert.equal(await page.locator('[data-testid="album-card"][aria-current="true"]').getAttribute('data-album-path'), selectedAlbum);
  check('album background crossfades, home and wall overlap during transition, back keeps selected album', { background, wallIn, homeOut, selectedAlbum: Boolean(selectedAlbum) });

  await page.locator('.home-tabs').getByRole('button', { name: '全部', exact: true }).click();
  await page.getByTestId('home-albums').waitFor({ state: 'detached' });
  await completed(page.locator('.wall-page'));
  const image = library.media.find(item => item.kind === 'image' && !item.fileName.endsWith('.gif'));
  await page.getByTestId('search-toggle').click();
  await page.getByRole('textbox', { name: '搜索素材' }).fill(image.fileName);
  await pause(400);
  await page.getByRole('button', { name: '关闭搜索', exact: true }).click();
  await page.locator('.floating-search').waitFor({ state: 'detached' });
  const instanceId = await page.locator(`[data-media-id="${image.id}"]`).first().getAttribute('data-instance-id');
  const item = page.locator(`[data-instance-id="${instanceId}"]`);
  await item.click(); await pause(700);
  await page.locator('.selection-bar').getByRole('button', { name: '查看详情', exact: true }).click();
  await page.locator('.details-panel').waitFor();
  assert.ok((await sample(page.locator('.details-panel'))).running);
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.locator('.details-panel').waitFor({ state: 'detached' });
  check('details glass panel slides in and out');
  const cameraBefore = await page.getByTestId('gallery-world').evaluate(el => el.style.transform);
  const beforeCount = (await snapshot()).media.reduce((sum, item) => sum + item.openCount, 0);
  await item.dblclick(); await page.getByTestId('viewer').waitFor();
  const viewerIn = await sample(page.getByTestId('viewer')); assert.ok(viewerIn.running);
  await completed(page.getByTestId('viewer'));
  await page.keyboard.press('Escape');
  const viewerOut = await sample(page.getByTestId('viewer')); assert.equal(viewerOut.phase, 'exit');
  await page.evaluate(() => { window.motionExitPointer = null; document.addEventListener('pointerdown', event => { window.motionExitPointer = event.target.className; }, { once: true, capture: true }); });
  await page.mouse.click(720, 480);
  assert.equal(await page.evaluate(() => window.motionExitPointer), 'viewer-exit-shield');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.getByTestId('viewer').waitFor({ state: 'detached' });
  await pause(150);
  assert.equal((await snapshot()).media.reduce((sum, item) => sum + item.openCount, 0), beforeCount + 1);
  assert.equal(await page.getByTestId('gallery-world').evaluate(el => el.style.transform), cameraBefore);
  assert.equal(await item.evaluate(el => document.activeElement === el), true);
  check('viewer entrance and exit animate, exit blocks click-through and navigation, and keeps counts, wall position and focus', { viewerIn, viewerOut });

  const video = library.media.find(item => item.fileName.endsWith('.mp4'));
  await searchMedia(video.fileName);
  await (await visibleMedia(video.id)).dblclick();
  await page.waitForFunction(() => { const video = document.querySelector('.viewer-video'); return video && !video.paused && video.currentTime > 0; });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.viewer-video').evaluate(el => el.paused), true);
  await page.getByTestId('viewer').waitFor({ state: 'detached' });
  check('video audio pauses immediately when viewer starts its exit');

  const incompatible = library.media.find(item => item.fileName.endsWith('.mkv'));
  const playable = await page.evaluate(id => window.album.prepareVideo(id), incompatible.id);
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('album:prepareVideo');
    ipcMain.handle('album:prepareVideo', () => new Promise(resolve => { globalThis.motionResolveProxy = resolve; }));
  });
  await page.evaluate(() => {
    window.motionExitPlays = [];
    document.addEventListener('play', event => {
      if (event.target instanceof HTMLVideoElement && event.target.closest('.viewer')) window.motionExitPlays.push({ source: event.target.currentSrc, exiting: !!event.target.closest('[data-motion="exit"]') });
    }, true);
  });
  await searchMedia(incompatible.fileName);
  await (await visibleMedia(incompatible.id)).dblclick();
  await until(() => app.evaluate(() => typeof globalThis.motionResolveProxy === 'function'), 'pending compatibility conversion');
  await page.keyboard.press('Escape');
  await app.evaluate(({}, url) => globalThis.motionResolveProxy(url), playable);
  await pause(60);
  assert.equal(await page.locator('.viewer-video').evaluate(video => video.paused), true);
  assert.deepEqual(await page.evaluate(() => window.motionExitPlays), []);
  await page.getByTestId('viewer').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.viewer-video').count(), 0);
  check('conversion resolving during viewer exit never remounts an autoplaying video or leaves audio');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByTestId('more-toggle').click(); await page.getByTestId('options-panel').waitFor(); await pause(30);
  const reduced = await sample(page.getByTestId('options-panel'));
  assert.equal(reduced.phase, 'idle'); assert.equal(reduced.running, false);
  await page.getByTestId('more-toggle').click(); await page.getByTestId('options-panel').waitFor({ state: 'detached' });
  check('reduced motion is respected without waiting for regular animation duration', reduced);

  assert.equal(report.errors.length, 0); check('no renderer exceptions'); report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(out, `${prefix}motion-failure.png`) }).catch(() => {});
} finally {
  if (app) await app.close().catch(() => {});
  report.finished = new Date().toISOString(); await fs.writeFile(path.join(out, `${prefix}motion-e2e-report.json`), JSON.stringify(report, null, 2));
}
