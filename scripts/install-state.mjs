import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import * as asar from '@electron/asar';
import { UUID } from 'builder-util-runtime';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expected = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'));
const [mode, target] = process.argv.slice(2);
if (!target) throw new Error('An absolute installation or user-data directory is required.');
// ASCII JSON remains unambiguous when Windows PowerShell 5 reads Node's stdout.
const writeJson = value => console.log(JSON.stringify(value).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`));

if (mode === 'identity') {
  const archive = path.join(path.resolve(target), 'resources', 'app.asar');
  const installed = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  if (installed.name !== expected.name) throw new Error('The existing application package does not match this project.');
  // The stable package/appId identify the product across the display-name change.
  // Packaged package.json intentionally omits build metadata, so legacy exe and
  // uninstaller names are checked against the actual files/registration by PS.
  // Match app-builder-lib/out/targets/nsis/NsisTarget.js for this configured appId.
  const guid = expected.build.nsis.guid || UUID.v5(expected.build.appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'));
  writeJson({ name: installed.name, version: installed.version, appId: expected.build.appId, guid, legacyDataDirectory: '拾光' });
} else if (mode === 'backup') {
  const directory = path.resolve(target), source = path.join(directory, 'library.sqlite');
  try { await fs.access(source); } catch { writeJson({ exists: false }); process.exit(0); }
  const backupDirectory = path.join(directory, 'Backups');
  await fs.mkdir(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(backupDirectory, `library-before-${expected.version}-${stamp}.sqlite`);
  const database = new DatabaseSync(source, { readOnly: true });
  try { await backup(database, destination); } finally { database.close(); }
  const saved = new DatabaseSync(destination, { readOnly: true });
  let summary;
  try {
    if (saved.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('The library backup did not pass SQLite quick_check.');
    summary = { sources: saved.prepare('SELECT COUNT(*) AS n FROM sources').get().n, media: saved.prepare('SELECT COUNT(*) AS n FROM media').get().n };
  } finally { saved.close(); }
  writeJson({ exists: true, path: destination, sha256: createHash('sha256').update(await fs.readFile(destination)).digest('hex'), ...summary });
} else throw new Error('Use identity or backup.');
