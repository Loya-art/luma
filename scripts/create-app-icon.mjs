import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Original vector mark: four differently sized frames echo the album wall.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#33443a"/><stop offset="1" stop-color="#111a15"/></linearGradient></defs>
  <rect x="12" y="12" width="488" height="488" rx="112" fill="url(#bg)"/>
  <g stroke="#d2e6c6" stroke-width="13" stroke-linejoin="round">
    <rect x="112" y="108" width="124" height="174" rx="9" fill="#bcd3ac" fill-opacity=".18"/>
    <rect x="276" y="108" width="124" height="100" rx="9" fill="none"/>
    <rect x="112" y="322" width="124" height="82" rx="9" fill="none"/>
    <rect x="276" y="248" width="124" height="156" rx="9" fill="#bcd3ac" fill-opacity=".18"/>
  </g>
</svg>`;
const output = resolve('resources');
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'icon.svg'), svg);
await sharp(Buffer.from(svg)).resize(512, 512).png().toFile(resolve(output, 'icon.png'));
const sizes = [16, 24, 32, 48, 64, 256];
const images = await Promise.all(sizes.map(size => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer()));
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
let offset = header.length;
for (let i = 0; i < images.length; i++) {
  const entry = 6 + i * 16;
  header[entry] = sizes[i] === 256 ? 0 : sizes[i]; header[entry + 1] = header[entry];
  header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[i].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
  offset += images[i].length;
}
await writeFile(resolve(output, 'icon.ico'), Buffer.concat([header, ...images]));
console.log('Application icon ready.');
