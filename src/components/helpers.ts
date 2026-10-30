import type { MediaItem, Source } from '../shared/types';

export const bytes = (value: number) => value >= 1073741824 ? `${(value / 1073741824).toFixed(1)} GB` : value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`;
export const duration = (value: number | null) => { const n = Math.round(value || 0); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; };
export const date = (value: number) => new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export const isGif = (item: MediaItem) => /\.gif$/i.test(item.fileName);
export const displayName = (value: string) => value.replace(/\.[^.]+$/, '');
export type Filter = { kind: 'all' | 'favorite' | 'source' | 'folder' | 'album' | 'tag' | 'smart'; id?: string; name?: string };
const directoryPath = (value: string) => {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[a-z]:$/i.test(normalized)) return `${normalized}/`;
  return normalized || (value.startsWith('/') ? '/' : '');
};
export const folderPath = (filePath: string) => {
  const normalized = filePath.replace(/\\/g, '/');
  const separator = normalized.lastIndexOf('/');
  return separator < 0 ? '' : directoryPath(normalized.slice(0, separator + 1));
};
export const pathKey = (value: string) => directoryPath(value).toLowerCase();
export interface FolderAlbum { id: string; path: string; name: string; count: number; videoCount: number; cover: MediaItem | null; status?: Source['status'] }
export function buildFolderAlbums(media: MediaItem[], sources: Source[]): FolderAlbum[] {
  const folders = new Map<string, FolderAlbum>();
  for (const item of media) {
    const groups=item.phoneFolders?.length?item.phoneFolders.map(folder=>({path:folder.id,id:folder.id,name:folder.name})):[{path:folderPath(item.path),id:pathKey(folderPath(item.path)),name:folderPath(item.path).split('/').pop()||folderPath(item.path)}];
    for(const group of groups){const {path,id,name}=group;
    let folder = folders.get(id);
    if (!folder) { folder = { id, path, name, count: 0, videoCount: 0, cover: null }; folders.set(id, folder); }
    folder.count++; if (item.kind === 'video') folder.videoCount++;
    if (!folder.cover || folder.cover.missing && !item.missing || folder.cover.kind === 'video' && item.kind === 'image' && !item.missing) folder.cover = item;
    }
  }
  for (const source of sources) {
    const key = pathKey(source.path);
    if (!source.count && !folders.has(key)) folders.set(key, { id: key, path: source.path, name: source.name, count: 0, videoCount: 0, cover: null, status: source.status });
    else if (folders.has(key)) folders.get(key)!.status = source.status;
  }
  return [...folders.values()].sort((a,b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) || a.id.localeCompare(b.id));
}
export function filterMedia(media: MediaItem[], filter: Filter, query: string, type: string, sort: string): MediaItem[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const items = media.filter(item => {
    if (type !== 'all' && item.kind !== type) return false;
    if (filter.kind === 'favorite' && !item.favorite) return false;
    if (filter.kind === 'source' && item.sourceId !== filter.id) return false;
    if (filter.kind === 'folder' && (filter.id?.startsWith('phone:')?!item.phoneFolders?.some(folder=>folder.id===filter.id):pathKey(folderPath(item.path)) !== pathKey(filter.id || ''))) return false;
    if (filter.kind === 'album' && !item.albumIds.includes(filter.id!)) return false;
    if (filter.kind === 'tag' && !item.tags.includes(filter.id!)) return false;
    if (filter.kind === 'smart' && !item.aiTags?.includes(filter.id!)) return false;
    const haystack = `${item.fileName} ${item.tags.join(' ')} ${(item.aiTags??[]).join(' ')}`.toLocaleLowerCase();
    return words.every(word => haystack.includes(word));
  });
  return items.sort((a, b) => sort === 'name' ? a.fileName.localeCompare(b.fileName, 'zh-CN', { numeric: true }) : sort === 'oldest' ? a.mtimeMs - b.mtimeMs : sort === 'added' ? a.addedAt - b.addedAt || a.id.localeCompare(b.id) : b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
}
