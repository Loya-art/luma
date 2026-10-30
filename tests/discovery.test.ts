import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { ComputerDiscovery } from '../electron/discovery';
import { Library } from '../electron/library';
import { classifyPhotoFolder, recommendPhotoFolder } from '../src/shared/photo-folders';

sharp.cache(false);
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');

test('recommendations distinguish personal photo directories from incidental project images', () => {
  for (const directory of ['E:/Games/Test/Screenshots', 'E:/ComfyUI/output/2026', 'E:/照片/旅行', 'E:/Pictures/Camera']) assert.equal(recommendPhotoFolder(directory).recommended, true, directory);
  for (const directory of ['E:/work/project/public/images', 'E:/Pictures/code/src/images', 'E:/Downloads/unknown', 'E:/WeChat Files/123/Image']) assert.equal(recommendPhotoFolder(directory).recommended, false, directory);
});

test('folder roles preserve captures and creative output while excluding chat, cache and application assets', () => {
  const kept = [
    ['E:/Games/Minecraft/screenshots', 'screenshot'],
    ['C:/Program Files (x86)/Steam/userdata/123/760/remote/456/screenshots', 'screenshot'],
    ['C:/Users/test/AppData/Local/Game/Saved/Screenshots/Windows', 'screenshot'],
    ['E:/ComfyUI_windows_portable/ComfyUI/output/人物', 'ai-output'],
    ['E:/ComfyUI/output/resources', 'ai-output'],
    ['phone:device:/storage/emulated/0/DCIM/Camera', 'photo'],
    ['E:/照片/旅行', 'photo'],
  ];
  for (const [folder, kind] of kept) assert.equal(classifyPhotoFolder(folder).kind, kind, folder);
  const excluded = [
    'E:/Games/Game/textures', 'E:/Games/Game/materials', 'E:/Software/resources/icons',
    'E:/Documents/WeChat Files/account/FileStorage/Image', 'E:/Tencent Files/123/Image',
    'E:/xwechat_files/wxid_test/msg/attach', 'E:/Pictures/聊天图片',
    'E:/Games/Game/screenshots/thumbnails', 'E:/ComfyUI/output/.cache',
    'E:/ComfyUI/custom_nodes/Node/example', 'E:/ComfyUI/web/images',
    'E:/ComfyUI/models', 'E:/app/node_modules/example/screenshots',
  ];
  for (const folder of excluded) {
    const result = classifyPhotoFolder(folder);
    assert.equal(result.kind, 'utility', folder); assert.ok(result.reason, folder);
  }
});
async function fixture() { await fs.mkdir(path.resolve('tests/.runtime'), { recursive: true }); return fs.mkdtemp(path.resolve('tests/.runtime/discovery-')); }
async function image(file: string) { await fs.mkdir(path.dirname(file), { recursive: true }); await sharp({ create: { width: 90, height: 60, channels: 3, background: '#a2a2a2' } }).png().toFile(file); }

test('discovery recursively finds mixed media and skips system/cache/link/profile directories without touching originals', async () => {
  const root = await fixture(); const external = await fixture();
  const original = path.join(root, '旅行', '中文照片.png');
  await image(original); await fs.writeFile(path.join(root, '旅行', '手机原片.HEIC'), 'read-only discovery does not decode');
  await fs.mkdir(path.join(root, '旅行', '视频')); await fs.writeFile(path.join(root, '旅行', '视频', '片段.mp4'), 'video');
  for (const folder of ['Windows', 'AppData', 'node_modules', '.git', 'MediaCache', 'profile']) await image(path.join(root, folder, 'not-an-album.png'));
  await image(path.join(external, 'outside.png'));
  await fs.symlink(external, path.join(root, '链接目录'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = sha(await fs.readFile(original));
  const service = new ComputerDiscovery({ excludedPaths: [path.join(root, 'profile')] });
  try {
    await service.start([root, path.join(root, '旅行')]); await service.waitForIdle();
    const state = service.getState();
    assert.equal(state.status, 'complete'); assert.equal(state.count, 3); assert.equal(state.folders.length, 2);
    assert.equal(state.roots.length, 1); assert.equal(state.issueCount, 0); assert.ok(state.skippedDirectories >= 7);
    assert.equal(state.folders.reduce((sum, folder) => sum + folder.photos, 0), 2);
    assert.equal(state.folders.reduce((sum, folder) => sum + folder.videos, 0), 1);
    assert.equal(sha(await fs.readFile(original)), before); assert.equal((await fs.stat(path.join(external, 'outside.png'))).isFile(), true);
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(external, { recursive: true, force: true }); }
});

test('read failures are visible while successful folders remain available', async () => {
  const root = await fixture(); await image(path.join(root, '照片.png'));
  const service = new ComputerDiscovery();
  try {
    await service.start([path.join(root, 'missing'), root]); await service.waitForIdle();
    // Nested ranges collapse to the parent; use a separate missing sibling.
    await service.start([root, root + '-missing']); await service.waitForIdle();
    const state = service.getState(); assert.equal(state.count, 1); assert.equal(state.issueCount, 1); assert.match(state.issues[0].path, /missing$/);
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('automatic discovery retains game screenshots and ComfyUI output, prunes utility trees and reports reasons without modifying originals', async () => {
  const root = await fixture();
  const keep = ['照片/旅行/原片.png', 'Games/MyGame/Screenshots/战斗.png', 'ComfyUI_windows_portable/ComfyUI/output/人物/创作.png'];
  const drop = ['Games/MyGame/textures/贴图.png', 'Games/MyGame/materials/材质.png', 'Documents/WeChat Files/account/FileStorage/Image/聊天.png', 'ComfyUI_windows_portable/ComfyUI/custom_nodes/Node/example/预览.png', 'ComfyUI_windows_portable/ComfyUI/output/cache/缩略图.png'];
  for (const name of [...keep, ...drop]) await image(path.join(root, name));
  const before = await Promise.all([...keep, ...drop].map(async name => sha(await fs.readFile(path.join(root, name)))));
  const service = new ComputerDiscovery({ knownScreenshotLocations: [] });
  try {
    await service.start([root]); await service.waitForIdle();
    const state = service.getState();
    assert.equal(state.status, 'complete'); assert.equal(state.count, keep.length);
    assert.deepEqual(state.folders.map(folder => folder.path).sort(), keep.map(name => path.dirname(path.join(root, name))).sort());
    assert.equal(state.filteredDirectories, 5); assert.equal(state.issueCount, 0);
    assert.ok(state.filtered.some(item => /WeChat Files/.test(item.path) && /聊天/.test(item.reason)));
    assert.ok(state.filtered.some(item => /textures/.test(item.path) && /贴图/.test(item.reason)));
    assert.equal(state.filtered.some(item => /FileStorage|example/.test(item.path)), false, 'Utility subtrees are pruned at their root.');
    state.filtered[0].reason = 'mutated client copy';
    assert.notEqual(service.getState().filtered[0].reason, 'mutated client copy');
    assert.deepEqual(await Promise.all([...keep, ...drop].map(async name => sha(await fs.readFile(path.join(root, name))))), before);
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('known screenshot directories bypass installation-folder pruning without opening application assets or leaving the selected scope', async () => {
  const root = await fixture(), outside = await fixture();
  const captures = path.join(root, 'Program Files (x86)', 'Steam', 'userdata', '123', '760', 'remote', '456', 'screenshots');
  const outsideCaptures = path.join(outside, 'Screenshots');
  await image(path.join(captures, '原图.png'));
  await image(path.join(captures, 'thumbnails', '缩略图.png'));
  await image(path.join(root, 'Program Files (x86)', 'Steam', 'steamapps', 'common', 'Game', 'textures', '材质.png'));
  await image(path.join(outsideCaptures, '不要扫描.png'));
  const service = new ComputerDiscovery({ knownScreenshotLocations: [captures, outsideCaptures].map(directory => ({ path: directory, name: '游戏截图', kind: 'folder' as const })) });
  try {
    await service.start([root]); await service.waitForIdle();
    const state = service.getState();
    assert.equal(state.status, 'complete'); assert.equal(state.count, 1);
    assert.deepEqual(state.folders.map(folder => folder.path), [captures]);
    assert.ok(state.filtered.some(item => item.path === path.join(captures, 'thumbnails')));
    assert.equal(state.issueCount, 0);
    await service.start([captures]); await service.waitForIdle();
    assert.equal(service.getState().count, 1, 'Directly selected screenshots work inside Program Files too.');
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
});

test('scan previews decode without importing files, reject stale/unknown IDs and skip temporary runtime directories', async () => {
  const root = await fixture(), pictures = path.join(root, 'Pictures');
  await image(path.join(pictures, 'Camera', '原片.png'));
  await image(path.join(pictures, '.runtime', 'generated', '临时图.png'));
  const library = new Library({ dataDir: path.join(root, 'profile'), binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, watch: false });
  try {
    const scan = await library.discoverComputer([pictures]);
    while (library.computerDiscoveryState().status === 'running') await new Promise(resolve => setTimeout(resolve, 1));
    const state = library.computerDiscoveryState(); assert.equal(state.count, 1); assert.equal(state.folders.length, 1);
    assert.equal(state.folders[0].recommended, true);
    const url = new URL(state.folders[0].previewUrl!), folderId = url.pathname.split('/')[2];
    const previews = await Promise.all(Array.from({ length: 8 }, () => library.resolveDiscoveryPreview(scan.id!, folderId)));
    assert.equal(new Set(previews.map(item => item.path)).size, 1);
    const meta = await sharp(previews[0].path).metadata(); assert.ok(meta.width! > 0 && meta.height! > 0);
    assert.equal(library.getSnapshot().media.length, 0, 'Previewing a candidate does not index it.');
    await assert.rejects(library.resolveDiscoveryPreview(scan.id!, '../outside'), /没有可预览/);
    await library.discoverComputer([pictures]);
    await assert.rejects(library.resolveDiscoveryPreview(scan.id!, folderId), /结果已变化/);
  } finally { await library.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a cancelled discovery keeps partial results and can be restarted', async () => {
  const root = await fixture();
  for (let index = 0; index < 300; index++) { const directory = path.join(root, String(index)); await fs.mkdir(directory); await fs.writeFile(path.join(directory, '照片.jpg'), 'photo'); }
  const service = new ComputerDiscovery();
  try {
    await service.start([root]);
    const deadline = Date.now() + 5000;
    while (service.getState().count === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
    service.cancel(); await service.waitForIdle(); const partial = service.getState();
    assert.equal(partial.status, 'cancelled'); assert.ok(partial.count > 0 && partial.count < 300);
    await service.start([root]); await service.waitForIdle(); assert.equal(service.getState().count, 300); assert.equal(service.getState().status, 'complete');
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('discovery selection stays exact across restarts/relink, excludes unchecked child/cache, preserves metadata and manual recursive import', async () => {
  const root = await fixture(); const source = path.join(root, '照片'); const profile = path.join(root, 'profile');
  await image(path.join(source, '主照片.png')); await image(path.join(source, '未勾选子相簿', 'child.png')); await image(path.join(source, 'node_modules', 'app.png'));
  const original = sha(await fs.readFile(path.join(source, '主照片.png')));
  const options = { dataDir: profile, binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, watch: false };
  let library = new Library(options);
  try {
    const scan = await library.discoverComputer([source]);
    while (library.computerDiscoveryState().status === 'running') await new Promise(resolve => setTimeout(resolve, 1));
    const state = library.computerDiscoveryState(); assert.equal(state.folders.length, 2);
    await assert.rejects(() => library.addDiscoveredFolders('stale', [source]), /扫描结果已变化/);
    await library.addDiscoveredFolders(scan.id!, [source]); await library.waitForIdle();
    let snapshot = library.getSnapshot(); assert.equal(snapshot.media.length, 1);
    const id = snapshot.media[0].id; const sourceId = snapshot.sources[0].id;
    library.updateMedia([id], { favorite: true, addTags: ['人工分类'] });
    await library.close(); library = new Library(options); await library.initialize(); await library.waitForIdle();
    snapshot = library.getSnapshot(); assert.equal(snapshot.media.length, 1); assert.equal(snapshot.media[0].id, id); assert.equal(snapshot.media[0].favorite, true);
    const relocated = path.join(root, '新位置'); await fs.rename(source, relocated); await library.relinkSource(sourceId, relocated); await library.waitForIdle();
    snapshot = library.getSnapshot(); assert.equal(snapshot.media.length, 1); assert.equal(snapshot.media[0].id, id); assert.deepEqual(snapshot.media[0].tags, ['人工分类']); assert.equal(snapshot.media[0].missing, false);
    assert.equal(sha(await fs.readFile(path.join(relocated, '主照片.png'))), original);
    await library.removeSource(sourceId); await library.waitForIdle();
    const db = new DatabaseSync(path.join(profile, 'library.sqlite'), { readOnly: true });
    try { assert.equal(db.prepare('SELECT COUNT(*) count FROM settings WHERE key=?').get(`source-direct:${sourceId}`)?.count, 0); } finally { db.close(); }
    await library.addSources([relocated]); await library.waitForIdle(); assert.equal(library.getSnapshot().media.length, 3, 'Explicit manual folder import retains recursive behavior.');
  } finally { await library.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
