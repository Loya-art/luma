import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const url = 'https://raw.githubusercontent.com/strukturag/libheif/v1.19.8/examples/example.heic';
const expected = '7f8b363e4936c0666a25f64f3a92fda10bd8e5453be4592530b65a55dd98f3f2';
const file = path.resolve('tests/.fixtures/compat/example.heic');
const digest = data => createHash('sha256').update(data).digest('hex');
try { if (digest(await fs.readFile(file)) === expected) process.exit(0); } catch {}
const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
if (!response.ok) throw Error(`HEIC fixture download failed: HTTP ${response.status}`);
const data = Buffer.from(await response.arrayBuffer());
if (digest(data) !== expected) throw Error('The public HEIC test fixture checksum does not match.');
await fs.mkdir(path.dirname(file), { recursive: true });
await fs.writeFile(file, data);
console.log('Pinned upstream HEIC fixture ready.');
