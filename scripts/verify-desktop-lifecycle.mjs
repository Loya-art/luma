import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { assertDebuggingPortAvailable, closeDesktopSession } from './desktop-session.mjs';

const report = { startedAt: new Date().toISOString(), checks: [], visibleWindowsStarted: false };
const root = path.resolve('tests/.runtime/lifecycle-' + Date.now());
await fs.mkdir(root, { recursive: true });
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await assert.rejects(assertDebuggingPortAvailable(port), /已被占用/);
await new Promise(resolve => reservation.close(resolve));
report.checks.push('Occupied CDP port is rejected before launching or closing any application.');
for (const file of ['scripts/start-phone-import.mjs', 'scripts/finish-v12-session.mjs']) {
  await assert.rejects(promisify(execFile)(process.execPath, [file], { windowsHide: true }), error => error.code === 1 && error.stderr.includes('--leave-open'));
}
report.checks.push('Real import/receive controllers refuse to run without explicit --leave-open.');
const edge = path.join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe');
await fs.access(edge);
await assertDebuggingPortAvailable(port);
const child = spawn(edge, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${path.join(root, 'edge-profile')}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
let browser;
try {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 150)); }
  }
  assert.ok(browser, 'Headless lifecycle browser must start.');
  await browser.close(); browser = undefined;
  assert.equal(child.exitCode, null);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  assert.ok(browser.contexts()[0].pages().length);
  report.checks.push('Closing a connectOverCDP client disconnects; the existing browser remains alive and reconnectable.');
  try { throw new Error('Deliberate acceptance failure'); }
  catch (error) { assert.match(error.message, /Deliberate/); }
  finally {
    await closeDesktopSession({ browser, child, timeoutMs: 1200 });
    browser = undefined;
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(sentinel.exitCode, null);
  report.checks.push('Failure-finally cleanup closes its captured process with a bounded fallback; unrelated sentinel stays alive.');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
finally {
  await closeDesktopSession({ browser, child, timeoutMs: 1200 });
  sentinel.kill();
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.resolve('docs/acceptance/1.2.1-desktop-lifecycle.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
