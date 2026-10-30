import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFolderAlbums, filterMedia, folderPath, pathKey } from '../src/components/helpers';
import type { MediaItem, Source } from '../src/shared/types';

function media(id: string, file: string, patch: Partial<MediaItem> = {}): MediaItem {
  return {
    id, sourceId: 'source', path: file, fileName: file.split(/[\\/]/).pop()!, kind: 'image',
    width: 640, height: 480, duration: null, size: 1000, mtimeMs: 1000, addedAt: 1000,
    openCount: 0, lastOpenedAt: null, takenAt: null, favorite: false, missing: false,
    tags: [], albumIds: [], thumbnailUrl: `thumb:${id}`, previewUrl: `preview:${id}`, originalUrl: `original:${id}`,
    ...patch,
  };
}
const source = (path: string, count: number): Source => ({ id: path, path, name: path.split(/[\\/]/).pop() || path, count, status: 'online' });

test('folder paths preserve drive roots and normalize path keys', () => {
  assert.equal(folderPath('C:\\photo.jpg'), 'C:/');
  assert.equal(folderPath('C:/photo.jpg'), 'C:/');
  assert.equal(folderPath('/photo.jpg'), '/');
  assert.equal(folderPath('C:\\Photos\\trip\\photo.jpg'), 'C:/Photos/trip');
  assert.equal(pathKey('C:\\'), pathKey('c:/'));
  assert.equal(pathKey('C:\\Photos\\'), pathKey('c:/photos'));
});

test('each actual parent directory is an album and folder filtering stays direct', () => {
  const items = [media('root', 'D:\\Photos\\root.jpg'), media('child', 'D:\\Photos\\Trip\\a.jpg'), media('deep', 'D:\\Photos\\Trip\\Night\\b.mp4', { kind: 'video' })];
  const albums = buildFolderAlbums(items, [source('D:\\Photos', 3)]);
  assert.equal(albums.length, 3);
  assert.deepEqual(albums.map(album => album.count), [1, 1, 1]);
  const trip = albums.find(album => album.name === 'Trip')!;
  assert.deepEqual(filterMedia(items, { kind: 'folder', id: trip.path }, '', 'all', 'name').map(item => item.id), ['child']);
  assert.equal(albums.find(album => album.name === 'Night')!.videoCount, 1);
});

test('same folder names remain distinct and empty registered sources appear once', () => {
  const items = [media('one', 'C:\\Work\\旅行\\a.jpg'), media('two', 'D:\\Personal\\旅行\\b.jpg'), media('drive', 'E:\\root.jpg')];
  const albums = buildFolderAlbums(items, [source('D:\\Empty', 0), source('d:/empty/', 0), source('C:\\Work', 1)]);
  assert.equal(albums.filter(album => album.name === '旅行').length, 2);
  assert.equal(new Set(albums.map(album => album.id)).size, albums.length);
  assert.equal(albums.find(album => pathKey(album.path) === 'd:/empty')?.count, 0);
  assert.equal(albums.find(album => pathKey(album.path) === 'e:/')?.path, 'E:/');
  assert.equal(albums.length, 4);
});

test('folder album covers prefer readable images over videos or missing files', () => {
  const items = [media('missing', 'D:\\Photos\\old.jpg', { missing: true }), media('video', 'D:\\Photos\\clip.mp4', { kind: 'video' }), media('image', 'D:\\Photos\\photo.jpg')];
  assert.equal(buildFolderAlbums(items, [source('D:\\Photos', 3)])[0].cover?.id, 'image');
});

test('phone aliases replace physical copied folders and preserve deduplicated album membership',()=>{
  const a={id:'phone:one:/DCIM/Camera',name:'Camera',path:'手机 · /DCIM/Camera'},b={id:'phone:one:/Pictures/旅行',name:'旅行',path:'手机 · /Pictures/旅行'};
  const items=[media('same','E:\\手机照片\\copied\\a.jpg',{phoneFolders:[a,b]}),media('next','E:\\手机照片\\copied\\b.jpg',{phoneFolders:[a]})];
  const albums=buildFolderAlbums(items,[source('E:\\手机照片',2)]);
  assert.deepEqual(albums.map(album=>album.name).sort(),['Camera','旅行']);
  assert.equal(albums.find(album=>album.name==='Camera')!.count,2);
  assert.deepEqual(filterMedia(items,{kind:'folder',id:b.id},'','all','name').map(item=>item.id),['same']);
});
