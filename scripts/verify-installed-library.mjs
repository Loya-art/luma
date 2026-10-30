import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { _electron } from 'playwright';

// Exercise the installed application against its actual default profile, without importing
// fixtures or changing classifications. The installer has already saved a consistent backup.
const project = process.cwd();
const receiptPath = path.join(project, 'docs', 'acceptance', 'installation.json');
const receipt = JSON.parse((await fs.readFile(receiptPath, 'utf8')).replace(/^\uFEFF/, ''));
const backup = new DatabaseSync(receipt.userDataBackup.path, { readOnly: true });
const sources = backup.prepare('SELECT id,path,path_key,name FROM sources ORDER BY id').all();
const albums = backup.prepare('SELECT * FROM albums ORDER BY id').all();
const knownClassifications = backup.prepare('SELECT id,favorite,excluded,tags,albums,open_count,last_opened_at FROM media ORDER BY id').all();
const exclusions = new Set(backup.prepare('SELECT path_key FROM media WHERE excluded=1').all().map(row => row.path_key.toLowerCase()));
backup.close();
const extensions = new Set(['.jpg','.jpeg','.jfif','.png','.webp','.avif','.gif','.tif','.tiff','.bmp','.mp4','.m4v','.mov','.mkv','.webm','.avi','.wmv','.mpeg','.mpg']);
const files = new Map();
async function visit(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (entry.isFile() && extensions.has(path.extname(file).toLowerCase())) files.set(file.toLowerCase(), file);
  }
}
for (const source of sources) await visit(source.path);
const expected = [...files].filter(([key]) => !exclusions.has(key));
async function originalsHash() {
  const hash = createHash('sha256');
  for (const [, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) hash.update(createHash('sha256').update(await fs.readFile(file)).digest());
  return hash.digest('hex');
}
const report = { started: new Date().toISOString(), executable: receipt.executable, defaultProfile: true, testEnvironment: false, candidateFiles: files.size, expectedIndexed: expected.length, checks: [], errors: [] };
const originalHashBefore = await originalsHash();
const env = { ...process.env };
for (const name of ['SHIGUANG_DATA_DIR', 'SHIGUANG_TEST_MODE', 'ELECTRON_RENDERER_URL']) delete env[name];
let app;
try {
  app = await _electron.launch({ executablePath: receipt.executable, args: [], env, timeout: 60000 });
  const page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.getByTestId('home-albums').waitFor({ timeout: 30000 });
  let snapshot;
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    snapshot = await page.evaluate(() => window.album.getSnapshot());
    const scans = snapshot.jobs.filter(job => job.type === 'scan');
    // The backend retains its current/last scan, not a history entry for every source.
    if (scans.some(job => job.status === 'complete' || job.status === 'error') && !snapshot.jobs.some(job => job.status === 'running') && snapshot.sources.every(source => source.status === 'online')) break;
    await page.waitForTimeout(200);
  }
  assert.ok(snapshot.jobs.some(job => job.type === 'scan' && job.status === 'complete'), 'Startup must complete a real scan.');
  assert.equal(snapshot.sources.every(source => source.status === 'online'), true, 'All existing source folders must be online.');
  assert.equal(snapshot.jobs.some(job => job.status === 'running'), false, 'Startup scans must complete.');
  assert.equal(snapshot.errors.length, 0, 'The actual default profile must read the registered folders successfully.');
  const paths = new Set(snapshot.media.map(item => item.path.toLowerCase()));
  for (const [key] of expected) assert.ok(paths.has(key), 'Every current supported, non-excluded source file must be indexed.');
  const decoded = await page.evaluate(async items => {
    const valid = await Promise.all(items.map(async item => {
      try { const response = await fetch(item.thumbnailUrl); const bitmap = await createImageBitmap(await response.blob()); const okay = response.ok && bitmap.width > 0 && bitmap.height > 0; bitmap.close(); return okay; }
      catch { return false; }
    }));
    return valid.filter(Boolean).length;
  }, snapshot.media.filter(item => !item.missing));
  assert.equal(decoded, snapshot.media.filter(item => !item.missing).length);
  report.checks.push('actual default-profile startup rescans existing folders and decodes every available thumbnail');
  const current = new DatabaseSync(path.join(process.env.APPDATA, '拾光', 'library.sqlite'), { readOnly: true });
  try {
    assert.deepEqual(current.prepare('SELECT id,path,path_key,name FROM sources ORDER BY id').all(), sources);
    assert.deepEqual(current.prepare('SELECT * FROM albums ORDER BY id').all(), albums);
    for (const row of knownClassifications) assert.deepEqual(current.prepare('SELECT id,favorite,excluded,tags,albums,open_count,last_opened_at FROM media WHERE id=?').get(row.id), row);
  } finally { current.close(); }
  report.checks.push('upgrade preserves registered sources, virtual albums and existing classifications');
  const folders = new Set(snapshot.media.map(item => path.dirname(item.path).toLowerCase()));
  const homeCaption = await page.locator('.home-current-caption>span').textContent();
  assert.equal(Number(homeCaption.split('/').at(-1).trim()), folders.size);
  const overlay = await page.evaluate(() => ({ visible: navigator.windowControlsOverlay?.visible, draggable: getComputedStyle(document.querySelector('.window-drag-region')).getPropertyValue('-webkit-app-region') }));
  assert.equal(overlay.visible, true);
  assert.equal(overlay.draggable, 'drag');
  report.checks.push('actual folder albums appear and the transparent native controls overlay is enabled');
  await page.waitForTimeout(500);
  const screenshot = path.join(project, 'docs', 'acceptance', 'installed-default-library.png');
  await page.screenshot({ path: screenshot });
  const originalHashAfter = await originalsHash();
  assert.equal(originalHashAfter, originalHashBefore);
  assert.equal(report.errors.length, 0);
  Object.assign(report, { indexed: snapshot.media.length, decoded, mediaFolders: folders.size, originalHashBefore, originalHashAfter, screenshot, status: 'passed' });
} catch (error) { report.status = 'failed'; report.failure = String(error); process.exitCode = 1; }
finally {
  if (app) await app.close().catch(() => {});
  report.finished = new Date().toISOString();
  await fs.writeFile(path.join(project, 'docs', 'acceptance', 'installed-default-library-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
