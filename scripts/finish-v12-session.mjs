import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

if (!process.argv.includes('--leave-open')) throw new Error('此操作会在现有软件中开启真实识别与无线接收。明确需要保持软件运行时，请使用 --leave-open。');

// The user selected local indexing and wireless receive, and previously chose
// E:\手机照片. Keep the installed app open with a ready-to-scan receive panel.
const out = path.resolve('docs/acceptance');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9238');
try {
const page = browser.contexts()[0].pages().find(item => item.url().startsWith('file:'));
assert.ok(page);
const snapshot = await page.evaluate(() => window.album.getSnapshot());
const heif = snapshot.media.find(item => item.fileName === '20260813_22083927.png' && item.path.startsWith('E:\\手机照片\\'));
assert.ok(heif, 'The actual misnamed HEIF original must now appear in the library.');
const decoded = await page.evaluate(async item => {
  const response = await fetch(item.originalUrl);
  const bitmap = await createImageBitmap(await response.blob());
  const result = { status: response.status, width: bitmap.width, height: bitmap.height };
  bitmap.close(); return result;
}, heif);
assert.deepEqual(decoded, { status: 200, width: 1080, height: 608 });
await page.evaluate(() => window.album.setupModels({ directory: 'E:\\拾光模型' }));
console.log(JSON.stringify({ phase: 'local-analysis-enabled', originalHeifDecoded: decoded }));
await page.getByTestId('import-folder').click();
await page.getByTestId('import-phone-receive').click();
await page.getByRole('dialog', { name: '手机无线传入' }).waitFor();
const receive = await page.evaluate(() => window.album.startPhoneReceive({ destination: 'E:\\手机照片', albumName: '来自手机' }));
assert.equal(receive.active, true);
assert.ok(receive.addresses.length);
await page.getByAltText('手机扫码打开照片发送页面').waitFor({ timeout: 15000 });
const first = receive.addresses[0], address = new URL(first.url);
const response = await fetch(address.origin + '/status', { headers: { 'X-Receive-Token': address.hash.slice(1), Origin: address.origin } });
assert.equal(response.status, 200);
assert.equal((await response.json()).active, true);
const qrPath = path.join(out, 'phone-receive-ready-qr.png');
await fs.writeFile(qrPath, Buffer.from(first.qrCode.split(',')[1], 'base64'));
await page.screenshot({ path: path.join(out, '1.2.1-installed-receive-ready.png') });
console.log(JSON.stringify({ phase: 'wireless-receive-ready', destination: receive.destination, network: first.name, endpoint: address.origin, expiresAt: receive.expiresAt }));
let intelligence;
for (let attempt = 0; attempt < 45; attempt++) {
  intelligence = await page.evaluate(() => window.album.intelligenceState());
  if (intelligence.indexed > 0 || intelligence.models.status !== 'ready' || intelligence.jobs.some(job => job.status === 'error')) break;
  await new Promise(resolve => setTimeout(resolve, 2000));
}
assert.equal(intelligence.models.status, 'ready');
assert.equal(intelligence.enabled, true);
assert.ok(intelligence.indexed > 0, 'Installed worker must actually index a local original.');
const report = { checkedAt: new Date().toISOString(), status: 'passed', defaultProfile: true, media: snapshot.media.length, originalHeifDecoded: decoded, localAnalysis: { enabled: intelligence.enabled, modelStatus: intelligence.models.status, indexed: intelligence.indexed, pending: intelligence.pending, jobs: intelligence.jobs.map(job => ({ id: job.id, kind: job.kind, status: job.status, done: job.done, total: job.total, failed: job.failed })) }, receiver: { active: receive.active, destination: receive.destination, albumName: receive.albumName, expiresAt: receive.expiresAt, networks: receive.addresses.map(item => ({ name: item.name, endpoint: item.url.split('#')[0] })), qrPath, localStatusProbe: response.status } };
await fs.writeFile(path.join(out, '1.2.1-production-session.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
} finally {
  // This script attaches to an existing user instance: only disconnect CDP.
  await browser.close();
}
