import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';

const out = path.resolve('docs/acceptance');
const receipt = JSON.parse(await fs.readFile(path.join(out, 'production-phone-import.json'), 'utf8'));
const browser = await chromium.connectOverCDP('http://127.0.0.1:9237');
const page = browser.contexts()[0].pages().find(item => item.url().startsWith('file:'));
assert.ok(page);
const report = { checkedAt: new Date().toISOString(), jobId: receipt.jobId, checks: [] };
let state = await page.evaluate(() => window.album.phoneState());
if (process.argv.includes('--pause-resume')) {
  const before = state.jobs.find(item => item.id === receipt.jobId);
  assert.equal(before.status, 'running');
  await page.evaluate(id => window.album.pausePhoneImport(id), receipt.jobId);
  state = await page.evaluate(() => window.album.phoneState());
  assert.equal(state.jobs.find(item => item.id === receipt.jobId).status, 'paused');
  await page.evaluate(id => window.album.resumePhoneImport(id), receipt.jobId);
  const deadline = Date.now() + 30000;
  do {
    state = await page.evaluate(() => window.album.phoneState());
    if (state.jobs.find(item => item.id === receipt.jobId).done > before.done) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  assert.ok(state.jobs.find(item => item.id === receipt.jobId).done > before.done);
  report.checks.push('Actual wireless import pauses and continues the same persistent job.');
}
const db = new DatabaseSync(path.join(process.env.APPDATA, '拾光', 'library.sqlite'), { readOnly: true });
const sample = db.prepare('SELECT source_path,local_path,sha256,size FROM phone_job_files WHERE job_id=? AND status=\'done\' ORDER BY source_path LIMIT 8').all(receipt.jobId);
assert.ok(sample.length);
for (const row of sample) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(row.local_path)) digest.update(chunk);
  assert.equal(digest.digest('hex'), row.sha256);
  assert.equal((await fs.stat(row.local_path)).size, row.size);
}
report.checks.push('Eight copied original files match the manifest SHA-256 and original byte counts.');
report.manifestCount = db.prepare('SELECT COUNT(*) count FROM phone_manifest').get().count;
db.close();
const snapshot = await page.evaluate(() => window.album.getSnapshot());
const imported = snapshot.media.filter(item => item.path.startsWith('E:\\手机照片\\') && !item.missing);
assert.ok(imported.length);
report.indexedFromPhone = imported.length;
report.thumbnails = await page.evaluate(async items => {
  return Promise.all(items.map(async item => {
    try { const response = await fetch(item.thumbnailUrl); const bitmap = await createImageBitmap(await response.blob()); const okay = response.ok && bitmap.width > 0 && bitmap.height > 0; bitmap.close(); return okay; }
    catch { return false; }
  }));
}, imported.slice(0, 8));
assert.ok(report.thumbnails.every(Boolean));
report.checks.push('Imported originals appear in the real library with browser-decodable thumbnails.');
report.job = state.jobs.find(item => item.id === receipt.jobId);
report.status = 'passed';
await page.screenshot({ path: path.join(out, '1.1-real-phone-import.png') });
await fs.writeFile(path.join(out, 'production-phone-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
// Leave the installed app and ongoing copy open.
process.exit(0);
