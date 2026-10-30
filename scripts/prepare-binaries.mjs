import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { findTool } from './system-tools.mjs';
const target = resolve('resources/binaries');
mkdirSync(target, { recursive: true });
for (const name of ['ffmpeg', 'ffprobe']) {
  const output = join(target, `${name}.exe`);
  if (existsSync(output)) continue;
  const source = findTool(name);
  copyFileSync(source, output);
  for (const license of ['LICENSE', 'LICENSE.txt']) {
    const candidate = resolve(dirname(source), '..', license);
    if (existsSync(candidate)) copyFileSync(candidate, join(target, 'FFmpeg-LICENSE.txt'));
  }
  console.log(`Bundled ${name}.exe`);
}
writeFileSync(join(target, 'FFmpeg-NOTICE.txt'), 'FFmpeg and ffprobe are separate programs used for local media processing.\nBuild distributor: https://www.gyan.dev/ffmpeg/builds/\nSource and licensing: https://ffmpeg.org/legal.html\nThis application invokes the tools as separate processes.\n', 'utf8');
