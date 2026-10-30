import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve('promo/.work');
const media = path.join(root, 'media');
const photos = [
  ['山川', '1500530855697-b586d89ba3ee'], ['山川', '1464822759023-fed622ff2c3b'], ['山川', '1469474968028-56623f02e42e'],
  ['林间', '1441974231531-c6227db76b6e'], ['林间', '1472396961693-142e6e269027'], ['林间', '1476231682828-37e571bc172f'],
  ['海岸', '1500375592092-40eb2168fd21'], ['海岸', '1473116763249-2faaef81ccda'], ['海岸', '1518837695005-2083093ee35b'],
  ['城市', '1519608487953-e999c86e7455'], ['城市', '1477959858617-67f85cf4f1df'], ['城市', '1480714378408-67cf0d13bc1b'],
  ['日落', '1500534314209-a25ddb2bd429'], ['日落', '1472120435266-53107fd0c44a'], ['日落', '1490730141103-6cac27aaab94'],
  ['旷野', '1470770841072-f978cf4d019e'], ['旷野', '1472214103451-9374bd1c798e'], ['旷野', '1501785888041-af3ef285b470'],
];
await fs.mkdir(media, { recursive: true });
const credits = [];
let cursor = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (cursor < photos.length) {
    const index = cursor++, [folder, id] = photos[index];
    const url = `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${[1300,1500,1700][index%3]}&q=88`;
    const file = path.join(media, folder, `${folder}-${String(index + 1).padStart(2, '0')}.jpg`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { await fs.access(file); } catch {
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw Error(`${id}: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      await sharp(bytes).rotate().jpeg({ quality: 92 }).toFile(file);
    }
    const info = await sharp(file).metadata(); if (!info.width) throw Error(`Invalid demo image ${id}`);
    credits[index] = { folder, source: url, file: path.relative(media, file).replaceAll('\\', '/') };
    console.log('Ready', folder, index + 1);
  }
}));
const videoUrl = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
const video = path.join(media, '视频', '花间蜜蜂.mp4');
await fs.mkdir(path.dirname(video), { recursive: true });
try { await fs.access(video); } catch { const response = await fetch(videoUrl); if (!response.ok) throw Error('Video download failed'); await fs.writeFile(video, Buffer.from(await response.arrayBuffer())); }
const notes = path.join(media, '旅行手帐'); await fs.mkdir(notes, { recursive: true });
const svg = `<svg width="1400" height="1000" xmlns="http://www.w3.org/2000/svg"><rect width="1400" height="1000" fill="#eee9dd"/><path d="M120 120H1280V880H120Z" fill="none" stroke="#c8c1b3" stroke-width="2"/><text x="175" y="260" fill="#34332f" font-family="Microsoft YaHei" font-size="76" font-weight="700">周末旅行计划</text><text x="180" y="410" fill="#615d55" font-family="Microsoft YaHei" font-size="40">第一站：山川与森林</text><text x="180" y="500" fill="#615d55" font-family="Microsoft YaHei" font-size="40">第二站：沿海公路看日落</text><text x="180" y="640" fill="#8c8477" font-family="Microsoft YaHei" font-size="30">带上相机，慢慢走。</text><text x="180" y="785" fill="#8c8477" font-family="Microsoft YaHei" font-size="24">Luma 演示手帐 · 原创示例</text></svg>`;
await sharp(Buffer.from(svg)).png().toFile(path.join(notes, '周末旅行计划.png'));
const discover = path.join(root, 'scan', 'Pictures');
for (const [directory, index] of [['Camera', 0], ['Games/Screenshots', 1], ['ComfyUI/output', 2], ['project/src', 3]]) {
  const file = path.join(discover, directory, '示例照片.jpg'); await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, await fs.readFile(path.join(media, credits[index].file)));
}
await fs.mkdir('docs/media', { recursive: true });
await fs.writeFile('docs/media/credits.md', '# Demonstration media\n\nThe public screenshots and video use a separate demo library. Original stock files are not included in the repository.\n\n## Photos\n\nPhotos from [Unsplash](https://unsplash.com), used under the [Unsplash license](https://unsplash.com/license). Individual image sources:\n\n' + credits.map(item => `- ${item.folder}: [image source](${item.source})`).join('\n') + `\n\n## Video\n\n[Flower / bee example video](${videoUrl}), published by MDN in its CC0 video samples. [Example documentation](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video).\n\n## Original material\n\nThe Chinese travel-note example, mouse annotations, subtitles and music are original demo material. Luma interface recordings are licensed with this project; the stock media retain their respective licenses.\n`);
await fs.writeFile(path.join(root, 'media-sources.json'), JSON.stringify(credits, null, 2));
console.log(JSON.stringify({ media, pictures: photos.length + 1, video: 1 }));
