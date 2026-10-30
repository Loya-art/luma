import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { Library } from '../electron/library';
import { isHeif, makeAnalysisImage } from '../electron/media';

// Test files must be releasable immediately on Windows after decoding.
sharp.cache(false);

// Copy only into an isolated profile. Never rename, repair or rewrite the input.
const input = process.argv[2];
assert.ok(input && path.isAbsolute(input), 'Pass the absolute original photo path.');
const runtimeRoot = path.resolve('tests/.runtime');
const workspace = path.join(runtimeRoot, `real-heif-${Date.now()}`);
const source = path.join(workspace, '照片');
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), original: input, checks: [] };
const hash = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
let library: Library | undefined;
try {
  assert.equal((await fs.lstat(input)).isFile(), true);
  const before = await hash(input);
  await fs.mkdir(source, { recursive: true });
  const copied = path.join(source, '手机原图.png');
  await fs.copyFile(input, copied);
  assert.equal(await isHeif(copied), true);
  assert.equal(await hash(copied), before);
  library = new Library({ dataDir: path.join(workspace, 'profile'), watch: false, binaries: { ffmpeg: path.resolve('resources/binaries/ffmpeg.exe'), ffprobe: path.resolve('resources/binaries/ffprobe.exe') } });
  await library.addSources([source]);
  await library.waitForIdle();
  const snapshot = library.getSnapshot();
  assert.deepEqual(snapshot.errors, []);
  assert.equal(snapshot.media.length, 1);
  const item = snapshot.media[0];
  const derivatives: Record<string, unknown> = {};
  for (const variant of ['thumbnail', 'preview', 'original'] as const) {
    const resolved = await library.resolveMedia(item.id, variant);
    const decoded = await sharp(resolved.path).raw().toBuffer({ resolveWithObject: true });
    assert.ok(decoded.data.length > 0);
    assert.equal(resolved.mime, 'image/webp');
    if (variant !== 'thumbnail') assert.deepEqual([decoded.info.width, decoded.info.height], [item.width, item.height]);
    derivatives[variant] = { width: decoded.info.width, height: decoded.info.height, mime: resolved.mime, decodedBytes: decoded.data.length };
  }
  const analysis = await makeAnalysisImage(copied, path.join(workspace, 'analysis.webp'));
  const analyzed = await sharp(analysis).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([analyzed.info.width, analyzed.info.height], [item.width, item.height]);
  assert.equal(await hash(copied), before);
  assert.equal(await hash(input), before);
  Object.assign(report, { status: 'passed', format: 'HEVC HEIF with PNG extension', bytes: (await fs.stat(input)).size, sha256: before, width: item.width, height: item.height, derivatives, checks: ['Content-based HEIF detection.', 'Isolated library indexes the original without read errors.', 'Thumbnail, preview, full-resolution display and analysis images decode.', 'Original and isolated-copy SHA-256 remain identical.'] });
} catch (error) {
  Object.assign(report, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await library?.close();
  const relative = path.relative(runtimeRoot, workspace);
  assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(workspace).startsWith('real-heif-'));
  await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  report.finishedAt = new Date().toISOString();
  await fs.mkdir('docs/acceptance', { recursive: true });
  await fs.writeFile('docs/acceptance/1.2-real-heif-compat-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
