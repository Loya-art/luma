import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { _electron } from 'playwright';
import electron from 'electron';

// Opt-in real-folder regression: clone the current registered sources into a separate Roaming
// profile. Source files and the production database are read-only throughout the check.
const cwd = process.cwd();
const profile = await fs.mkdtemp(path.join(process.env.APPDATA, 'shiguang-import-regression-'));
const sourceDb = new DatabaseSync(path.join(process.env.APPDATA, '拾光', 'library.sqlite'), { readOnly: true });
const sources = sourceDb.prepare('SELECT path FROM sources').all();
await backup(sourceDb, path.join(profile, 'library.sqlite'));
sourceDb.close();
const extensions = new Set(['.jpg', '.jpeg', '.jfif', '.png', '.webp', '.avif', '.gif', '.tif', '.tiff', '.bmp', '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv', '.mpeg', '.mpg']);
const files = new Set();
async function visit(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (entry.isFile() && extensions.has(path.extname(file).toLowerCase())) files.add(file);
  }
}
for (const source of sources) await visit(source.path);
async function sourceHash() {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) hash.update(createHash('sha256').update(await fs.readFile(file)).digest());
  return hash.digest('hex');
}
const before = await sourceHash();
const report = { profile, packaged: Boolean(process.env.SHIGUANG_EXECUTABLE), candidateFiles: files.size, started: new Date().toISOString() };
let app;
try {
  app = await _electron.launch({ executablePath: process.env.SHIGUANG_EXECUTABLE || electron, args: process.env.SHIGUANG_EXECUTABLE ? [] : [cwd], env: { ...process.env, SHIGUANG_DATA_DIR: profile, SHIGUANG_TEST_MODE: '1' } });
  const page = await app.firstWindow();
  await page.getByTestId('home-albums').waitFor();
  let snapshot;
  for (let attempt = 0; attempt < 600; attempt++) {
    snapshot = await page.evaluate(() => window.album.getSnapshot());
    if (snapshot.media.length && !snapshot.jobs.some(job => job.status === 'running')) break;
    await page.waitForTimeout(200);
  }
  const decoded = await page.evaluate(async items => {
    const results = await Promise.all(items.map(async item => {
      try {
        const response = await fetch(item.thumbnailUrl), bitmap = await createImageBitmap(await response.blob());
        const valid = response.ok && bitmap.width > 0 && bitmap.height > 0; bitmap.close(); return valid;
      } catch { return false; }
    }));
    return results.filter(Boolean).length;
  }, snapshot.media);
  Object.assign(report, { imported: snapshot.media.length, decoded, mediaFolders: new Set(snapshot.media.map(item => path.dirname(item.path).toLowerCase())).size, errors: snapshot.errors.map(error => ({ extension: path.extname(error.path), code: error.message.split(':')[0] })), originalHashBefore: before, originalHashAfter: await sourceHash() });
  assert.equal(report.imported, files.size);
  assert.equal(report.decoded, files.size);
  assert.equal(report.errors.length, 0);
  assert.equal(report.originalHashAfter, report.originalHashBefore);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = String(error); process.exitCode = 1;
} finally {
  if (app) await app.close();
  report.finished = new Date().toISOString();
  const reportPath = path.join(cwd, 'docs/acceptance', process.env.SHIGUANG_EXECUTABLE ? 'installed-real-profile-import-report.json' : 'real-profile-import-report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportPath, ...report }));
}
