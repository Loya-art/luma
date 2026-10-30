import { _electron } from 'playwright';
import electronPath from 'electron';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Synthetic index benchmark only. Real codec coverage is recorded separately by e2e.mjs.
const cwd = process.cwd();
const acceptance = path.join(cwd, 'docs', 'acceptance');
const e2e = JSON.parse(await fs.readFile(path.join(acceptance, 'e2e-report.json'), 'utf8'));
const dataDir = path.join(cwd, 'tests', '.runtime', `perf-${Date.now()}`);
await fs.mkdir(dataDir, { recursive: true });
await fs.copyFile(path.join(e2e.dataDir, 'library.sqlite'), path.join(dataDir, 'library.sqlite'));
const db = new DatabaseSync(path.join(dataDir, 'library.sqlite'));
const source = db.prepare('SELECT id FROM sources LIMIT 1').get();
db.exec('DELETE FROM media; DELETE FROM albums;');
db.prepare('UPDATE sources SET path=?, path_key=?, status=?').run(path.join(dataDir, 'benchmark-offline'), path.join(dataDir, 'benchmark-offline').toLowerCase(), 'offline');
db.prepare("UPDATE settings SET value=? WHERE key='preferences'").run(JSON.stringify({ view: 'wall', fit: 'cover', seed: 17, gap: 8, thumbSize: 240, sidebarOpen: true, camera: { x: 48, y: 48, scale: .85 }, lastSelectedId: null }));
const insert = db.prepare('INSERT INTO media(id,source_id,path,path_key,file_name,kind,width,height,duration,size,mtime_ms,added_at,missing,tags) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
db.exec('BEGIN');
for (let i = 0; i < 30000; i++) { const name = `benchmark-${String(i).padStart(5, '0')}.jpg`; const file = path.join(dataDir, 'benchmark-offline', name); insert.run(`perf-${i}`, source.id, file, file.toLowerCase(), name, 'image', [1280,720,1000][i % 3], [860,1100,1000][i % 3], null, 100000, Date.now() - i, Date.now() - i, 1, JSON.stringify(i % 100 === 0 ? ['性能样本'] : [])); }
db.exec('COMMIT'); db.close();
let app; const report = { kind: '30000 synthetic metadata records; no claim of 30000 real media decoding', dataDir, metrics: {} };
try {
  const started = Date.now();
  app = await _electron.launch({ executablePath: electronPath, args: [cwd], env: { ...process.env, SHIGUANG_DATA_DIR: dataDir, SHIGUANG_TEST_MODE: '1' }, timeout: 45000 });
  const page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 960 });
  await page.waitForFunction(() => document.querySelector('.page-heading span')?.textContent?.includes('30,000'), null, { timeout: 30000 });
  report.metrics.startupTo30000IndexMs = Date.now() - started;
  const query = await page.evaluate(async () => { const start = performance.now(); const data = await window.album.getSnapshot(); return { durationMs: performance.now() - start, count: data.media.length }; });
  assert.equal(query.count, 30000); report.metrics.snapshotRoundtripMs = query.durationMs;
  report.metrics.visibleWallDOM = await page.getByTestId('media-tile').count(); assert.ok(report.metrics.visibleWallDOM < 500);
  const inputStarted = Date.now(); await page.getByRole('textbox', { name: '搜索素材' }).fill('benchmark-29999');
  await page.waitForFunction(() => document.querySelector('.page-heading span')?.textContent === '1 项'); report.metrics.searchToResultMs = Date.now() - inputStarted;
  await page.getByRole('textbox', { name: '搜索素材' }).fill(''); await page.getByTestId('view-grid').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="view-grid"]')?.classList.contains('active'));
  report.metrics.visibleGridDOM = await page.getByTestId('media-tile').count(); assert.ok(report.metrics.visibleGridDOM < 500);
  assert.ok(report.metrics.snapshotRoundtripMs < 3000); assert.ok(report.metrics.searchToResultMs < 3000);
  report.status = 'passed'; console.log(JSON.stringify(report, null, 2));
} catch (error) { report.status = 'failed'; report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1; }
finally { await app?.close(); await fs.writeFile(path.join(acceptance, 'perf-report.json'), JSON.stringify(report, null, 2)); }
