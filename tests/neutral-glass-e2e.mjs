import { _electron } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve('tests/.runtime/neutral-glass-' + Date.now());
const media = path.join(root, '照片');
const out = path.resolve('docs/acceptance');
await fs.mkdir(out, { recursive: true });
for (const [folder, files] of [['旅途', ['构成-01.jpg', '构成-02.png', '构成-03.webp']], ['日常', ['构成-06.webp', '构成-07.jpg', '构成-08.png']]]) {
  await fs.mkdir(path.join(media, folder), { recursive: true });
  for (const name of files) await fs.copyFile(path.resolve('tests/.fixtures/混合尺寸素材', name), path.join(media, folder, name));
}
const report = { startedAt: new Date().toISOString(), profile: root, checks: [], errors: [], surfaces: [] };
const app = await _electron.launch({ executablePath: process.env.SHIGUANG_EXECUTABLE || electronPath, args: process.env.SHIGUANG_EXECUTABLE ? [] : [process.cwd()], env: { ...process.env, SHIGUANG_DATA_DIR: path.join(root, 'profile'), SHIGUANG_TEST_MODE: '1' } });
let page;
async function inspect(selector) {
  const result = await page.locator(selector).evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color, border: style.borderTopColor, backdrop: style.backdropFilter };
  });
  for (const key of ['background', 'color', 'border']) {
    const channels = result[key].match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (channels?.length === 3) assert.ok(channels.every(value => value === channels[0]), `${selector} ${key} must be neutral: ${result[key]}`);
  }
  assert.match(result.background, /rgba\(255, 255, 255, 0\./);
  assert.match(result.backdrop, /saturate\(0\)/);
  report.surfaces.push({ selector, ...result });
}
try {
  page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByTestId('home-albums').waitFor();
  await page.evaluate(dir => window.album.addSources([dir]), media);
  for (let attempt = 0; attempt < 300; attempt++) {
    const snapshot = await page.evaluate(() => window.album.getSnapshot());
    if (snapshot.media.length === 6 && !snapshot.jobs.some(job => job.status === 'running')) break;
    await page.waitForTimeout(100);
    if (attempt === 299) throw new Error('Fixture scan did not finish.');
  }
  await page.waitForTimeout(500);
  await inspect('.floating-dock');
  await inspect('.album-cover-card.is-current');
  const coverFilter = await page.locator('.album-cover-card.is-current img').evaluate(element => getComputedStyle(element).filter);
  assert.equal(coverFilter, 'none');
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(out, 'neutral-glass-home.png') });
  await page.getByTestId('open-album').click();
  await page.getByTestId('album-switcher').waitFor();
  assert.equal(await page.locator('.album-switch-title .lucide-images').count(), 1);
  assert.equal(await page.locator('.lucide-list-music').count(), 0);
  await page.locator('.album-switch-title').click();
  await page.getByRole('listbox', { name: '切换相册' }).waitFor();
  await inspect('.album-switch-current');
  await inspect('.album-switch-list');
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(out, 'neutral-glass-album-switcher.png') });
  await page.locator('.album-switch-title').click();
  await page.getByRole('listbox', { name: '切换相册' }).waitFor({ state: 'hidden' });
  await page.getByTestId('more-toggle').click();
  await page.getByTestId('options-panel').waitFor();
  await inspect('.options-panel');
  await page.getByTestId('wall-help-toggle').click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(out, 'neutral-glass-options.png') });
  const filter = await page.getByTestId('media-tile').first().locator('img').evaluate(element => getComputedStyle(element).filter);
  assert.ok(!/grayscale|saturate\(0\)/.test(filter));
  await page.getByTestId('more-toggle').click();
  await page.getByTestId('import-folder').click();
  await page.getByTestId('import-phone').click();
  await page.getByRole('dialog', { name: '从手机导入' }).waitFor();
  await inspect('.connected-modal');
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(out, 'neutral-glass-phone.png') });
  report.checks.push('Home, dock, album switcher, options and phone dialog use neutral white translucent surfaces.', 'Backdrop colors are removed inside glass only; foreground photos retain their color.', 'Album switching uses the stacked-photo icon and contains no musical-note icon.');
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  if (page) await page.screenshot({ path: path.join(out, 'neutral-glass-failure.png') });
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(out, 'neutral-glass-report.json'), JSON.stringify(report, null, 2));
  await app.close();
  console.log(JSON.stringify(report));
}
