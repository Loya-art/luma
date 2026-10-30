import { _electron } from 'playwright';
import electron from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const cwd = process.cwd(), packaged = Boolean(process.env.SHIGUANG_EXECUTABLE);
const directory = path.join(cwd, 'tests', '.runtime', `window-smoke-${Date.now()}`);
const mediaDirectory = path.join(directory, 'window-test-media');
const output = path.join(cwd, 'docs', 'acceptance');
const prefix = packaged ? 'installed-' : '';
await fs.mkdir(mediaDirectory, { recursive: true });
for (const name of ['构成-01.jpg', '构成-02.png', '构成-03.webp']) await fs.copyFile(path.join(cwd, 'tests', '.fixtures', '混合尺寸素材', name), path.join(mediaDirectory, name));
const env = { ...process.env, SHIGUANG_DATA_DIR: path.join(directory, 'profile'), SHIGUANG_TEST_MODE: '1' };
delete env.ELECTRON_RENDERER_URL;
let app, closed = false;
try {
  app = await _electron.launch({ executablePath: process.env.SHIGUANG_EXECUTABLE || electron, args: packaged ? [] : [cwd], env });
  app.on('close', () => { closed = true; });
  const page = await app.firstWindow();
  await page.getByTestId('home-albums').waitFor();
  await page.evaluate(directory => window.album.addSources([directory]), mediaDirectory);
  await page.waitForFunction(async () => { const snapshot = await window.album.getSnapshot(); return snapshot.media.length === 3 && !snapshot.jobs.some(job => job.status === 'running'); });
  await page.getByTestId('album-card').first().waitFor();
  await page.waitForTimeout(500);
  const overlay = await page.evaluate(() => {
    const controls = navigator.windowControlsOverlay;
    const region = document.elementFromPoint(innerWidth * .23, 18);
    return { visible: controls?.visible, rectangle: controls?.getTitlebarAreaRect().toJSON(), dragRegion: region ? getComputedStyle(region).getPropertyValue('-webkit-app-region') : null };
  });
  assert.equal(overlay.visible, true, 'Native window controls overlay must be visible.');
  assert.equal(overlay.dragRegion, 'drag', 'The top strip must be a real native draggable region.');
  // On Windows Playwright may own a cmd.exe launcher; target Electron's real main PID.
  const applicationPid = await app.evaluate(() => process.pid);
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(cwd, 'scripts', 'native-window-smoke.ps1'), '-ApplicationProcessId', String(applicationPid), '-OutputDirectory', output, '-ReportPrefix', prefix, '-CloseWhenDone'];
  const result = await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const reportPath = path.join(output, `${prefix}native-window-report.json`);
  const report = JSON.parse((await fs.readFile(reportPath, 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(report.status, 'passed');
  report.overlay = overlay;
  report.packaged = packaged;
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, checks: report.checks, overlay, reportPath, screenshot: report.screenshot }));
} finally { if (app && !closed) await app.close().catch(() => {}); }
