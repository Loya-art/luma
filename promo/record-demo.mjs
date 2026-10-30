import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { _electron } from 'playwright';
import sharp from 'sharp';
import { closeDesktopSession } from '../scripts/desktop-session.mjs';

const work = path.resolve('promo/.work'), profile = path.join(work, 'demo-profile');
await fs.mkdir(profile, { recursive: true }); await fs.mkdir('docs/media', { recursive: true });
let owned;
try { owned = JSON.parse(await fs.readFile(path.join(work, 'owned-demo.json'), 'utf8')); const marker = JSON.parse(await fs.readFile(path.join(owned.path, 'luma-demo-owned.json'), 'utf8')); if (marker.id !== owned.id) throw Error('Wrong demo ownership marker'); }
catch { const directory = await fs.mkdtemp('E:/Luma-Demo-'); owned = { id: randomUUID(), path: directory }; await fs.writeFile(path.join(directory, 'luma-demo-owned.json'), JSON.stringify(owned)); await fs.writeFile(path.join(work, 'owned-demo.json'), JSON.stringify(owned)); }
const media = path.join(owned.path, '图库'), scanRoot = path.join(owned.path, '发现', 'Pictures');
await fs.cp(path.join(work, 'media'), media, { recursive: true });
await fs.cp(path.join(work, 'scan/Pictures'), scanRoot, { recursive: true });
const report = { startedAt: new Date().toISOString(), appVersion: '1.2.3', actualInstalledApp: true, separateDemoLibrary: true, visibleWindowsStarted: false, scenes: [], errors: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, label, timeout = 45000) => { const end = Date.now() + timeout; while (Date.now() < end) { const result = await predicate(); if (result) return result; await sleep(100); } throw Error('Timed out: ' + label); };
let app, child, page, cdp, encoder, timer, latest, frames = 0, received = 0, started = 0;
const raw = path.join(work, 'luma-raw.mp4');
async function waitGone(locator) { await locator.waitFor({ state: 'detached' }); }
async function finishCapture() {
  if (!started) return;
  clearInterval(timer); await cdp.send('Page.stopScreencast').catch(() => {});
  const target = Math.round((performance.now() - started) / 1000 * 30);
  while (frames < target && latest && !encoder.stdin.destroyed) { if (!encoder.stdin.write(latest)) await new Promise(resolve => encoder.stdin.once('drain', resolve)); frames++; }
  encoder.stdin.end();
  await new Promise((resolve, reject) => encoder.exitCode !== null ? (encoder.exitCode === 0 ? resolve() : reject(Error('Encoder failed'))) : encoder.once('exit', code => code === 0 ? resolve() : reject(Error('Encoder failed: ' + code))));
  report.duration = frames / 30; report.recordedFrames = received; report.encodedFrames = frames; started = 0;
}
try {
  const env = { ...process.env, SHIGUANG_DATA_DIR: profile, SHIGUANG_TEST_MODE: '1', SHIGUANG_HIDDEN_TEST: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  app = await _electron.launch({ executablePath: path.join(process.env.LOCALAPPDATA, 'Programs/Shiguang/Luma.exe'), env, timeout: 45000 }); child = app.process();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1920, 1080));
  page = await app.firstWindow(); page.on('pageerror', error => report.errors.push(error.message));
  page.setDefaultTimeout(12000);
  cdp = await page.context().newCDPSession(page);
  cdp.on('Page.screencastFrame', event => { latest = Buffer.from(event.data, 'base64'); received++; cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {}); });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  await page.getByTestId('home-albums').waitFor();
  await page.evaluate(directory => window.album.addSources([directory]), media);
  let snapshot = await until(async () => { const value = await page.evaluate(() => window.album.getSnapshot()); return value.media.length >= 20 && !value.jobs.some(job => job.status === 'running') ? value : null; }, 'demo originals indexed');
  console.log('Demo library ready:', snapshot.media.length);
  await page.evaluate(() => window.album.setupModels({ directory: 'E:\\拾光模型' }));
  await until(async () => { const state = await page.evaluate(() => window.album.intelligenceState()); if (state.jobs.some(job => job.status === 'error')) throw Error('Local demo indexing failed'); return state.indexed >= 19; }, 'real local OCR and content indexing', 240000);
  const content = await page.evaluate(() => window.album.searchMedia({ query: '山川', mode: 'content', limit: 120 }));
  const text = await page.evaluate(() => window.album.searchMedia({ query: '周末旅行', mode: 'text', limit: 120 }));
  assert.equal(content.semanticReady, true); assert.ok(content.hits.length); assert.ok(text.hits.length);
  report.realSearch = { contentMatches: content.hits.length, textMatches: text.hits.length, semanticReady: content.semanticReady };
  console.log('Real local search ready:', JSON.stringify(report.realSearch));
  await page.evaluate(() => window.album.setSettings({ sizingMode: 'balanced', camera: { x: 24, y: 24, scale: 1 }, fit: 'cover', thumbSize: 260 }));
  await page.reload(); await page.getByTestId('album-overview-wall').waitFor();
  await until(() => page.locator('.album-overview-cover img').evaluateAll(images => images.length >= 8 && images.every(image => image.complete && image.naturalWidth > 0)), 'album covers');
  await until(() => latest, 'native cover capture'); await sleep(700);
  await sharp(latest).resize(1440).jpeg({ quality: 90 }).toFile('docs/media/luma-albums.jpg');
  await page.getByRole('button', { name: '全部', exact: true }).click(); await waitGone(page.getByTestId('home-albums'));
  await until(() => page.locator('.media-tile img').evaluateAll(images => images.length > 8 && images.every(image => image.complete && image.naturalWidth > 0)), 'wall previews');
  await sleep(700); await sharp(latest).resize(1440).jpeg({ quality: 90 }).toFile('docs/media/luma-wall.jpg');
  await page.evaluate(() => {
    const style = document.createElement('style'); style.textContent = `#demo-pointer{position:fixed;z-index:2147483647;pointer-events:none;left:0;top:0;width:23px;height:29px;filter:drop-shadow(0 1px 3px #000a)}.demo-click{position:fixed;pointer-events:none;z-index:2147483646;width:40px;height:40px;margin:-20px;border:1.5px solid #fff9;border-radius:50%;animation:demo-ring .45s ease-out forwards}@keyframes demo-ring{to{transform:scale(1.65);opacity:0}}`; document.head.append(style);
    const pointer = document.createElement('div'); pointer.id = 'demo-pointer'; pointer.innerHTML = '<svg viewBox="0 0 24 30"><path d="M2 2L3 25L9 19L14 29L19 26L14 17L23 16Z" fill="white" stroke="#222" stroke-width="1.4"/></svg>'; document.body.append(pointer);
    document.addEventListener('pointermove', event => { pointer.style.transform = `translate(${event.clientX}px,${event.clientY}px)`; });
    document.addEventListener('pointerdown', event => { const ring = document.createElement('i'); ring.className = 'demo-click'; ring.style.left = event.clientX + 'px'; ring.style.top = event.clientY + 'px'; document.body.append(ring); setTimeout(() => ring.remove(), 500); });
  });
  await until(() => latest, 'native recording frames');
  encoder = spawn(path.resolve('resources/binaries/ffmpeg.exe'), ['-y','-f','image2pipe','-framerate','30','-vcodec','mjpeg','-i','pipe:0','-an','-c:v','libx264','-threads','4','-preset','veryfast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',raw], { windowsHide: true, stdio: ['pipe','ignore','pipe'] });
  let encoderError = ''; encoder.stderr.on('data', data => { encoderError = (encoderError + data).slice(-2000); }); encoder.stdin.on('error', () => {});
  received = 0; started = performance.now();
  timer = setInterval(() => { const target = Math.floor((performance.now() - started) / 1000 * 30); while (frames < target && latest && encoder.stdin.writableLength < 8 * 1024 * 1024 && !encoder.stdin.destroyed) { encoder.stdin.write(latest); frames++; } }, 15);
  async function scene(title, seconds, action) { const start = (performance.now() - started) / 1000; await action(); const elapsed = (performance.now() - started) / 1000 - start; if (elapsed < seconds) await sleep((seconds - elapsed) * 1000); const end = (performance.now() - started) / 1000; report.scenes.push({ start, end, title }); console.log('Recorded', title, Math.round((end - start) * 10) / 10); }
  async function drag(dx, dy, duration = 2500) { const x = 1050, y = 590; await page.mouse.move(x, y); await page.mouse.down(); const steps = 60; for (let i = 1; i <= steps; i++) { await page.mouse.move(x + dx * i / steps, y + dy * i / steps); await sleep(duration / steps); } await page.mouse.up(); await sleep(220); }
  async function photo() { return page.locator('.media-tile').evaluateAll((tiles, videos) => tiles.map(tile => ({ tile, box: tile.getBoundingClientRect() })).filter(({ tile, box }) => !videos.includes(tile.dataset.mediaId) && box.width > 90 && box.height > 90 && box.left > 35 && box.top > 70 && box.right < innerWidth - 35 && box.bottom < innerHeight - 120 && document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('[data-media-id]') === tile).sort((a,b) => (a.box.x+a.box.width/2-innerWidth/2)**2+(a.box.y+a.box.height/2-innerHeight/2)**2-((b.box.x+b.box.width/2-innerWidth/2)**2+(b.box.y+b.box.height/2-innerHeight/2)**2)).map(({ tile }) => tile.dataset.instanceId)[0], snapshot.media.filter(item => item.kind === 'video').map(item => item.id)); }
  await scene('自在看照片', 4, () => drag(480, 160, 3000));
  await scene('点一下，放大', 4, async () => { const id = await photo(); assert.ok(id); await page.locator(`[data-instance-id="${id}"]`).click(); await page.locator('.media-tile.focused').waitFor(); await sleep(700); });
  await scene('大小随心', 4, async () => { await page.keyboard.press('Escape'); await sleep(550); await page.mouse.move(960,540); for (let i=0;i<4;i++) { await page.mouse.wheel(0,75); await sleep(400); } });
  await scene('大小有别', 4, async () => { await page.getByTestId('more-toggle').click(); await page.getByTestId('sizing-mode').selectOption('bytes'); await sleep(1100); await page.getByRole('button', { name: '关闭选项', exact: true }).click(); await waitGone(page.getByTestId('options-panel')); });
  await scene('找到那本相册', 4, async () => { await page.getByTestId('back-albums').click(); await page.getByTestId('album-overview-wall').waitFor(); await page.getByRole('textbox', { name: '搜索相册', exact: true }).fill('海岸'); await sleep(600); await page.getByTestId('album-card').click(); });
  await scene('文件夹成相簿', 4, async () => { await page.locator('.album-switch-title').click(); await sleep(700); await page.getByRole('option').filter({ hasText: '山川' }).click(); });
  await scene('视频，一点即播', 5, async () => { await page.locator('.album-switch-title').click(); await page.getByRole('option').filter({ hasText: '视频' }).click(); await until(() => page.locator('.media-tile').count(), 'video tiles'); const tile = page.locator('.media-tile').filter({ has: page.locator('.video-duration') }).first(); await tile.click(); await page.getByTestId('viewer').waitFor(); await until(() => page.locator('.viewer-video').evaluate(video => video.readyState >= 2), 'demo video playback'); await sleep(3000); await page.keyboard.press('Escape'); await waitGone(page.getByTestId('viewer')); });
  await scene('先看，再选择', 7, async () => {
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, scanRoot);
    await page.getByTestId('import-folder').click(); await page.getByTestId('import-computer-scan').click();
    await until(() => page.locator('.computer-location-list input').count(), 'scan locations');
    for (const checkbox of await page.locator('.computer-location-list input').all()) if (await checkbox.isChecked()) await checkbox.uncheck();
    await page.getByRole('button', { name: '选择其他文件夹', exact: true }).click(); await page.getByTestId('start-computer-scan').click();
    await until(() => page.locator('.computer-folder-preview').evaluateAll(images => images.length >= 3 && images.every(image => image.tagName === 'IMG' && image.complete && image.naturalWidth > 0)), 'real discovery thumbnails');
    await page.getByRole('checkbox', { name: `选择 ${path.join(scanRoot,'Camera')}`, exact: true }).check(); await sleep(700); await page.getByTestId('add-computer-results').click(); await sleep(1000); await page.getByRole('button', { name: '关闭电脑扫描', exact: true }).click();
  });
  await scene('搜画面内容', 5, async () => { await page.getByTestId('back-albums').click(); await page.getByRole('button', { name: '全部', exact: true }).click(); await waitGone(page.getByTestId('home-albums')); await page.getByTestId('search-toggle').click(); await page.getByRole('textbox', { name: '搜索素材' }).fill('山川'); await page.getByRole('button', { name: '画面内容', exact: true }).click(); await sleep(1600); });
  await scene('也能搜文字', 5, async () => { await page.getByRole('button', { name: '图片文字', exact: true }).click(); await page.getByRole('textbox', { name: '搜索素材' }).fill('周末旅行'); await until(() => page.locator('.media-tile').count(), 'OCR result'); await sleep(600); const id = await photo(); await page.locator(`[data-instance-id="${id}"]`).dblclick(); await page.getByTestId('viewer').waitFor(); await sleep(1500); await page.keyboard.press('Escape'); await waitGone(page.getByTestId('viewer')); });
  await scene('Luma · 开源', 6, async () => { await page.getByRole('button', { name: '关闭搜索', exact: true }).click(); await sleep(400); await drag(-420,-110,3400); });
  await finishCapture();
  assert.deepEqual(report.errors, []); report.status = 'recorded'; console.log(JSON.stringify({ duration: report.duration, capturedFrames: received, raw }));
} catch (error) { report.status = 'failed'; report.failure = String(error); console.error(error); await finishCapture().catch(() => {}); process.exitCode = 1; }
finally { clearInterval(timer); if (encoder && encoder.exitCode === null) encoder.kill(); await app?.close().catch(() => {}); await closeDesktopSession({ child }); report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(work, 'recording.json'), JSON.stringify(report, null, 2)); }
