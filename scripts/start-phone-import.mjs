import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { assertDebuggingPortAvailable, closeDesktopSession } from './desktop-session.mjs';

if (!process.argv.includes('--leave-open')) throw new Error('这是真实手机导入操作。明确需要保持软件运行时，使用 --leave-open；验收测试不会自动留下窗口。');
const phoneSerial = process.env.SHIGUANG_PHONE_SERIAL;
const destination = process.env.SHIGUANG_IMPORT_DESTINATION;
if (!phoneSerial || !destination || !path.isAbsolute(destination)) throw new Error('请设置 SHIGUANG_PHONE_SERIAL 和绝对路径 SHIGUANG_IMPORT_DESTINATION。');

// Use the installed application and its ordinary persistent profile. The detached
// desktop process remains open when this short acceptance controller disconnects.
const out = path.resolve('docs/acceptance');
const receipt = JSON.parse((await fs.readFile(path.join(out, 'installation.json'), 'utf8')).replace(/^\uFEFF/, ''));
const packageInfo = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8'));
assert.equal(receipt.productVersion.split('.').slice(0, 3).join('.'), packageInfo.version);
const env = { ...process.env };
for (const key of ['SHIGUANG_DATA_DIR', 'SHIGUANG_TEST_MODE', 'ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE']) delete env[key];
await assertDebuggingPortAvailable(9237);
const child = spawn(receipt.executable, ['--remote-debugging-port=9237', '--remote-debugging-address=127.0.0.1'], { detached: true, stdio: 'ignore', windowsHide: false, env });
child.unref();
let browser, importStarted = false;
let launchError; child.once('error', error => { launchError = error; });
try {
for (let attempt = 0; attempt < 60; attempt++) {
  if (launchError) throw launchError;
  if (child.exitCode !== null) throw new Error('手机导入进程在连接前已退出');
  try { browser = await chromium.connectOverCDP('http://127.0.0.1:9237'); break; }
  catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
}
assert.ok(browser, 'The installed desktop app must expose its local acceptance connection.');
const context = browser.contexts()[0];
let page = context.pages().find(item => item.url().startsWith('file:'));
for (let attempt = 0; !page && attempt < 30; attempt++) { await new Promise(resolve => setTimeout(resolve, 500)); page = context.pages().find(item => item.url().startsWith('file:')); }
assert.ok(page);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.getByTestId('home-albums').waitFor({ timeout: 60000 });
const devices = await page.evaluate(() => window.album.phoneDevices());
const device = devices.find(item => item.serial === phoneSerial && item.state === 'device');
assert.ok(device, 'The explicitly selected paired phone must be online.');
console.log(JSON.stringify({ phase: 'connected', device }));
const scan = await page.evaluate(id => window.album.scanPhone(id), device.id);
const folders = scan.folders.filter(item => item.recommended !== false);
const selected = folders.reduce((result, item) => ({ count: result.count + item.count, bytes: result.bytes + item.bytes }), { count: 0, bytes: 0 });
console.log(JSON.stringify({ phase: 'scanned', all: scan.count, selected, issues: scan.issues }));
const jobId = await page.evaluate(request => window.album.importPhone(request), { scanId: scan.id, destination, folderPaths: folders.map(item => item.path) });
importStarted = true;
const report = { startedAt: new Date().toISOString(), executable: receipt.executable, defaultProfile: true, pid: child.pid, device, scanId: scan.id, all: { count: scan.count, bytes: scan.bytes }, selected, jobId, errors };
await fs.writeFile(path.join(out, 'production-phone-import.json'), JSON.stringify(report, null, 2));
await page.getByTestId('import-folder').click();
await page.getByTestId('import-phone').click();
await page.getByRole('dialog', { name: '从手机导入' }).waitFor();
for (let attempt = 0; attempt < 90; attempt++) {
  const state = await page.evaluate(() => window.album.phoneState());
  const current = state.jobs.find(item => item.id === jobId);
  if (attempt % 10 === 0) console.log(JSON.stringify({ phase: 'importing', job: current }));
  if (current?.imported > 0 || current?.status === 'error' || current?.status === 'complete') { report.latestJob = current; break; }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
report.snapshotCount = (await page.evaluate(() => window.album.getSnapshot())).media.length;
report.errors = errors;
await page.screenshot({ path: path.join(out, '1.1-real-phone-import.png') });
await fs.writeFile(path.join(out, 'production-phone-import.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ phase: 'started', report }));
if (report.latestJob?.status === 'error') process.exitCode = 1;
} finally {
  // A started import is retained only because --leave-open was explicitly given.
  await closeDesktopSession({ browser, child, leaveOpen: importStarted });
}
