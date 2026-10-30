import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PhoneReceiver } from '../electron/receive';

const workspace = path.resolve('tests/.runtime');
await fs.mkdir(workspace, { recursive: true });
const root = await fs.mkdtemp(path.join(workspace, 'review-receive-containment-'));
const destination = path.join(root, 'chosen-destination');
const outside = path.join(root, 'outside-destination');
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cGikAAAAASUVORK5CYII=', 'base64');
const digest = createHash('sha256').update(bytes).digest('hex');
const db = new DatabaseSync(path.join(root, 'library.sqlite'));
const receiver = new PhoneReceiver({ db, bindAddress: '127.0.0.1' });
try {
  await fs.mkdir(destination); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'original.png'), bytes);
  await fs.symlink(outside, path.join(destination, 'old-phone-folder'), process.platform === 'win32' ? 'junction' : 'dir');
  const lexicalCopy = path.join(destination, 'old-phone-folder', 'original.png');
  db.exec('CREATE TABLE phone_manifest(sha256 TEXT,local_path TEXT,size INTEGER)');
  db.prepare('INSERT INTO phone_manifest VALUES(?,?,?)').run(digest, lexicalCopy, bytes.length);
  const state = await receiver.start({ destination, albumName: 'incoming' });
  const address = new URL(state.addresses[0].url);
  const response = await fetch(address.origin + '/upload', { method: 'POST', body: bytes, headers: { 'X-Receive-Token': address.hash.slice(1), 'X-File-Name': 'incoming.png' } });
  const result = await response.json();
  console.log(JSON.stringify({ status: response.status, result, aliases: receiver.getAliases(), physicalCopy: await fs.realpath(lexicalCopy), destination }));
  assert.equal(response.status, 200);
  assert.deepEqual(result, { duplicate: false }, 'A copy physically outside the selected destination cannot satisfy its backup.');
  assert.equal(await fs.readFile(path.join(destination, 'incoming', 'incoming.png')).then(value => value.equals(bytes)), true);
} finally {
  await receiver.close(); db.close();
  assert.ok(root.startsWith(workspace + path.sep));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
}
