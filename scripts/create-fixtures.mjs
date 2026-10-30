import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findTool } from './system-tools.mjs';

// Original deterministic test art. The production application never imports it automatically.
const root = resolve('tests/.fixtures/混合尺寸素材');
await mkdir(join(root, '子文件夹'), { recursive: true });
const palette = [['#192e35', '#d99572', '#e9d8ad'], ['#2c3c35', '#a2bb85', '#e3d5a8'], ['#482d37', '#ba755b', '#f4d7ae'], ['#1f3549', '#7198a4', '#f2ca85'], ['#332f28', '#aa8358', '#e4c78f'], ['#263537', '#91a59d', '#dfb2a4']];
const dimensions = [[1280, 860], [720, 1100], [1000, 1000], [1600, 700], [600, 1400], [1200, 900], [900, 1200]];
function art(w, h, index, transparent = false) {
  const [base, accent, light] = palette[index % palette.length];
  const mode = index % 4;
  const motifs = mode === 0
    ? `<circle cx="${w * .67}" cy="${h * .34}" r="${Math.min(w, h) * .22}" fill="${light}"/><path d="M0 ${h * .75}Q${w * .2} ${h * .4} ${w * .55} ${h * .72}T${w * 1.2} ${h * .62}V${h}H0Z" fill="${accent}"/><path d="M0 ${h * .88}Q${w * .4} ${h * .6} ${w} ${h * .85}V${h}H0Z" fill="${base}" opacity=".7"/>`
    : mode === 1
    ? `<rect x="${w * .18}" y="${h * .12}" width="${w * .64}" height="${h * .76}" rx="${w * .32}" fill="${accent}"/><rect x="${w * .28}" y="${h * .22}" width="${w * .44}" height="${h * .66}" rx="${w * .22}" fill="${light}"/><path d="M${w * .28} ${h * .58}H${w * .72}V${h * .9}H${w * .28}Z" fill="${base}" opacity=".65"/>`
    : mode === 2
    ? Array.from({ length: 7 }, (_, n) => `<path d="M${w * -.1} ${h * (.1 + n * .14)}Q${w * .4} ${h * (-.05 + n * .14)} ${w * 1.1} ${h * (.21 + n * .14)}" fill="none" stroke="${n % 2 ? accent : light}" stroke-width="${h * .08}" opacity="${.45 + n * .07}"/>`).join('')
    : `<path d="M${w * .08} ${h * .88}L${w * .45} ${h * .12}L${w * .82} ${h * .88}Z" fill="${accent}"/><path d="M${w * .36} ${h * .88}L${w * .68} ${h * .3}L${w * .96} ${h * .88}Z" fill="${light}" opacity=".75"/><circle cx="${w * .25}" cy="${h * .23}" r="${Math.min(w, h) * .08}" fill="${light}"/>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${transparent ? '' : `<rect width="100%" height="100%" fill="${base}"/>`}${motifs}<text x="${w * .07}" y="${h * .94}" fill="${light}" opacity=".7" font-size="${Math.max(16, Math.min(w, h) * .025)}" font-family="Arial">STUDY ${String(index + 1).padStart(2, '0')} / SHIGUANG</text></svg>`);
}
for (let i = 0; i < 36; i++) {
  const [w, h] = dimensions[i % dimensions.length];
  const format = ['jpg', 'png', 'webp'][i % 3];
  const directory = i >= 30 ? join(root, '子文件夹') : root;
  const dest = join(directory, `构成-${String(i + 1).padStart(2, '0')}.${format}`);
  const image = sharp(art(w, h, i));
  if (format === 'jpg') await image.jpeg({ quality: 88 }).toFile(dest);
  else if (format === 'webp') await image.webp({ quality: 86 }).toFile(dest);
  else await image.png().toFile(dest);
}
await sharp(art(800, 1000, 40, true)).png().toFile(join(root, '透明背景.png'));
await sharp(art(1400, 600, 41)).avif({ quality: 65 }).toFile(join(root, '现代格式.avif'));
await sharp(art(600, 900, 42)).withMetadata({ orientation: 6 }).jpeg().toFile(join(root, '方向标记.jpg'));
await sharp(art(500, 2800, 43)).png().toFile(join(root, '超长截图.png'));
await sharp(art(2800, 500, 44)).jpeg().toFile(join(root, '全景横图.jpg'));
await writeFile(join(root, '损坏样本.jpg'), 'Intentionally invalid image for the import error check.');

let ffmpeg = resolve('resources/binaries/ffmpeg.exe');
if (!existsSync(ffmpeg)) ffmpeg = findTool('ffmpeg');
function run(args) { execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, stdio: 'pipe', timeout: 120_000 }); }
run(['-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', join(root, '动态色彩.mp4')]);
run(['-f', 'lavfi', '-i', 'testsrc2=size=540x720:rate=20', '-t', '3', '-c:v', 'mpeg4', '-q:v', '5', join(root, '兼容转换测试.mkv')]);
run(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=8', '-t', '2', join(root, '动态预览.gif')]);
await writeFile(resolve('tests/.fixtures/README.txt'), `Generated test corpus only. No original user media.\nImages with mixed sizes, transparency, EXIF orientation, AVIF, GIF; H264+AAC MP4 and MPEG4-in-MKV video; one intentionally broken JPEG.\nDirectory: ${root}\n`, 'utf8');
console.log(root);
console.log('Generated 44 supported media files plus one deliberately damaged JPEG.');
