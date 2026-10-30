import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import electron from 'electron';
import { closeDesktopSession } from './desktop-session.mjs';

// Exercise the real Electron path API without opening any BrowserWindow or
// reading the user's production profile. Each scenario has a scratch AppData.
const root = path.resolve(`tests/.runtime/luma-brand-${Date.now()}`);
const applicationData = path.join(root, 'AppData'), legacy = path.join(applicationData, '拾光'), override = path.join(root, 'override');
for (const [directory, label] of [[legacy, 'legacy-library'], [override, 'isolated-override']]) {
  await fs.mkdir(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, 'library.sqlite'));
  db.exec('CREATE TABLE brand_probe(value TEXT)'); db.prepare('INSERT INTO brand_probe VALUES(?)').run(label); db.close();
}
const entry = path.join(root, 'identity.cjs');
await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'brand-probe.ts', loader: 'ts', contents: `
import {app} from 'electron';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {configureApplicationIdentity} from './electron/branding';
app.disableHardwareAcceleration();
app.setPath('appData',process.env.LUMA_PROBE_APPDATA!);
configureApplicationIdentity(app,process.env.SHIGUANG_DATA_DIR);
app.whenReady().then(()=>{try{const db=new DatabaseSync(path.join(app.getPath('userData'),'library.sqlite'),{readOnly:true});const stored=db.prepare('SELECT value FROM brand_probe').get();db.close();console.log(JSON.stringify({name:app.getName(),directory:app.getPath('userData'),stored:stored.value,windows:0}));}finally{app.quit();}}).catch(error=>{console.error(error);app.exit(1);});
` }, outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
const checks = [];
for (const [testOverride, expectedDirectory, expectedValue] of [[undefined, legacy, 'legacy-library'], [override, override, 'isolated-override']]) {
  const env = { ...process.env, LUMA_PROBE_APPDATA: applicationData };
  delete env.ELECTRON_RUN_AS_NODE; delete env.SHIGUANG_DATA_DIR;
  if (testOverride) env.SHIGUANG_DATA_DIR = testOverride;
  let child;
  try {
    const output = await new Promise((resolve, reject) => { child = execFile(electron, [entry], { env, windowsHide: true, timeout: 20000 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)); });
    const result = JSON.parse(output.trim());
    assert.equal(result.name, 'Luma'); assert.equal(result.directory, expectedDirectory); assert.equal(result.stored, expectedValue);
    checks.push({ name: testOverride ? 'test profile override' : 'legacy library survives display rename', status: 'passed', directory: result.directory, value: result.stored });
  } finally { await closeDesktopSession({ child }); }
}
const report = { status: 'passed', checkedAt: new Date().toISOString(), visibleWindowsStarted: false, productionProfileTouched: false, checks };
await fs.mkdir('docs/acceptance', { recursive: true });
await fs.writeFile('docs/acceptance/luma-brand-compatibility.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
