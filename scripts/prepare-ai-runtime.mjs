import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const execute = promisify(execFile);
const root = path.resolve('resources/binaries');
const version = '0.12.7';
const target = path.join(root, 'uv.exe');
await fs.mkdir(root, { recursive: true });
if (!(await fs.stat(target).then(stat => stat.size > 1_000_000, () => false))) {
  // Official portable runtime manager, not a machine-wide installation.
  // https://docs.astral.sh/uv/getting-started/installation/#standalone-installer
  const url = `https://github.com/astral-sh/uv/releases/download/${version}/uv-x86_64-pc-windows-msvc.zip`;
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`uv download HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const temporary = await fs.mkdtemp(path.join(root, '.uv-download-'));
  try {
    const zip = path.join(temporary, 'uv.zip'); await fs.writeFile(zip, archive);
    const quote = value => `'${value.replace(/'/g, "''")}'`;
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(temporary)}`], { windowsHide: true });
    await fs.copyFile(path.join(temporary, 'uv.exe'), target);
    await fs.writeFile(path.join(root, 'UV-DOWNLOAD.json'), JSON.stringify({ url, sha256: createHash('sha256').update(archive).digest('hex') }, null, 2));
  } finally { if (!temporary.startsWith(root + path.sep)) throw new Error('Unexpected uv staging path'); await fs.rm(temporary, { recursive: true, force: true }); }
}
const { stdout } = await execute(target, ['--version'], { windowsHide: true });
if (!stdout.startsWith(`uv ${version} `)) throw new Error(`Unexpected uv version: ${stdout}`);
for (const license of ['MIT', 'APACHE']) {
  const file = path.join(root, `UV-LICENSE-${license}.txt`);
  if (!(await fs.stat(file).then(stat => stat.size > 500, () => false))) {
    const response = await fetch(`https://raw.githubusercontent.com/astral-sh/uv/${version}/LICENSE-${license}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`uv license download HTTP ${response.status}`);
    await fs.writeFile(file, await response.text());
  }
}
await fs.writeFile(path.join(root, 'UV-NOTICE.txt'), `uv ${version}, Astral Software Inc., MIT OR Apache-2.0.\nhttps://github.com/astral-sh/uv\nhttps://github.com/astral-sh/uv/blob/${version}/LICENSE-MIT\nhttps://github.com/astral-sh/uv/blob/${version}/LICENSE-APACHE\nManaged CPython and model packages are downloaded only when local analysis is enabled.\n`);
console.log(stdout.trim());
