import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, ChevronLeft, ChevronRight, Folder, GalleryHorizontalEnd, LayoutGrid, LoaderCircle, Plus, RefreshCw, Search, X } from 'lucide-react';
import type { FolderAlbum } from './helpers';
import type { ImportError, MediaItem } from '../shared/types';
import { classifyPhotoFolder } from '../shared/photo-folders';
import './album-overview.css';

function AlbumCoverImage({ cover, background = false, outgoing = false, thumbnail = false }: { cover: MediaItem; background?: boolean; outgoing?: boolean; thumbnail?: boolean }) {
  const [fallback, setFallback] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFallback(false); setFailed(false); }, [cover.previewUrl, cover.thumbnailUrl]);
  if (failed) return background ? null : <Folder size={54} strokeWidth={.7} />;
  const primary = thumbnail ? cover.thumbnailUrl : cover.previewUrl, secondary = thumbnail ? cover.previewUrl : cover.thumbnailUrl;
  return <img className={background ? `home-background ${outgoing ? 'is-outgoing' : ''}` : undefined} src={fallback ? secondary : primary} alt="" draggable={false} decoding="async" loading={thumbnail ? 'lazy' : undefined} aria-hidden={background || undefined} onError={() => {
    if (!fallback && cover.thumbnailUrl !== cover.previewUrl) setFallback(true);
    else setFailed(true);
  }} />;
}

function AlbumBackground({ cover }: { cover: MediaItem | null }) {
  const [layers, setLayers] = useState<{ current: MediaItem | null; previous: MediaItem | null }>({ current: cover, previous: null });
  if (layers.current?.id !== cover?.id) setLayers({ current: cover, previous: layers.current });
  useEffect(() => {
    const timer = window.setTimeout(() => setLayers(value => ({ ...value, previous: null })), 320);
    return () => window.clearTimeout(timer);
  }, [cover?.id]);
  return <>{layers.previous && <AlbumCoverImage key={`previous-${layers.previous.id}`} cover={layers.previous} background outgoing />}{layers.current && <AlbumCoverImage key={layers.current.id} cover={layers.current} background />}</>;
}

export type AlbumHomeView = 'overview' | 'focus';
interface Props { albums: FolderAlbum[]; query: string; onQueryChange: (query: string) => void; view: AlbumHomeView; onViewChange: (view: AlbumHomeView) => void; showOther: boolean; onShowOtherChange: (show: boolean) => void; initialScrollTop: number; onScrollChange: (top: number) => void; activeId: string | null; onActiveChange: (id: string) => void; loading: boolean; fatal: string; scanning: boolean; errors: ImportError[]; onErrors: () => void; onRescan: () => void; onOpen: (album: FolderAlbum) => void; onAll: () => void; onFavorites: () => void; onImport: () => void }
export default function AlbumHome({ albums, query, onQueryChange, view, onViewChange, showOther, onShowOtherChange, initialScrollTop, onScrollChange, activeId, onActiveChange, loading, fatal, scanning, errors, onErrors, onRescan, onOpen, onAll, onFavorites, onImport }: Props) {
  const root = useRef<HTMLElement>(null);
  const overview = useRef<HTMLDivElement>(null);
  const classified = useMemo(() => albums.map(album => ({ album, classification: classifyPhotoFolder(album.path) })), [albums]);
  const hiddenCount = classified.filter(item => item.classification.kind === 'utility').length;
  const visible = useMemo(() => { const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean); return classified.filter(item => (showOther || item.classification.kind !== 'utility') && words.every(word => `${item.album.name} ${item.album.path}`.toLocaleLowerCase().includes(word))).map(item => item.album); }, [classified, query, showOther]);
  const current = Math.max(0, visible.findIndex(album => album.id === activeId));
  const active = visible[current];
  const wheelAt = useRef(0);
  const drag = useRef<{ x: number; moved: boolean } | null>(null);
  const ignoreClick = useRef(false);
  const move = (delta: number) => { if (!visible.length) return; const index = Math.max(0, Math.min(visible.length - 1, current + delta)); onActiveChange(visible[index].id); if (view === 'overview') requestAnimationFrame(() => { const card = [...(overview.current?.querySelectorAll<HTMLButtonElement>('[data-album-id]') ?? [])].find(item => item.dataset.albumId === visible[index].id); card?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }); };
  const errorsFor = (album: FolderAlbum) => errors.filter(error => error.path.replace(/\\/g, '/').toLowerCase().startsWith(album.path.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() + '/') || error.path.replace(/\\/g, '/').toLowerCase() === album.path.replace(/\\/g, '/').toLowerCase()).length;
  const statusFor = (album: FolderAlbum) => album.count ? `${album.count.toLocaleString()} 项素材${album.videoCount > 0 ? ` · ${album.videoCount} 段视频` : ''}` : album.status === 'scanning' || scanning ? '正在查找照片与视频…' : album.status === 'offline' ? '文件夹暂时无法访问' : errorsFor(album) ? '读取遇到问题' : '没有找到支持的照片或视频';
  useLayoutEffect(() => { if (overview.current) overview.current.scrollTop = initialScrollTop; }, [view, query, showOther]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (root.current?.closest('[data-motion="exit"]') || document.querySelector('.viewer,.modal-backdrop:not([aria-hidden="true"])')) return;
      if (event.target instanceof Element && event.target.closest('input,textarea,select')) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
      if (view === 'overview' && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { const columns = overview.current ? getComputedStyle(overview.current).gridTemplateColumns.split(' ').length : 1; event.preventDefault(); move(columns * (event.key === 'ArrowDown' ? 1 : -1)); }
      if (event.key === 'Enter' && active) { event.preventDefault(); onOpen(active); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [current, visible, active, onOpen, view]);
  return <section ref={root} className={`album-home album-home--${view}`} data-testid="home-albums" aria-label="文件夹相簿">
    <AlbumBackground cover={view === 'focus' ? active?.cover || null : null} />
    <div className="home-shade" />
    <nav className="home-tabs" aria-label="浏览入口"><button className="active">相簿</button><button onClick={onAll}>全部</button><button onClick={onFavorites}>收藏</button></nav>
    <div className="album-overview-toolbar">
      <span className="album-overview-count">{visible.length.toLocaleString()} 本相册</span>
      <label className="album-name-search"><Search size={16}/><input id="album-search" aria-label="搜索相册" value={query} onChange={event => onQueryChange(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (query) onQueryChange(''); else event.currentTarget.blur(); } }} placeholder="搜索相册名称或文件夹…"/>{query && <button aria-label="清空相册搜索" onClick={() => onQueryChange('')}><X size={14}/></button>}</label>
      <div className="album-home-view-toggle" role="group" aria-label="相册浏览方式"><button className={view === 'overview' ? 'active' : ''} aria-pressed={view === 'overview'} data-testid="album-view-overview" onClick={() => onViewChange('overview')} title="相册总览"><LayoutGrid size={16}/><span>相册墙</span></button><button className={view === 'focus' ? 'active' : ''} aria-pressed={view === 'focus'} data-testid="album-view-focus" onClick={() => onViewChange('focus')} title="逐本聚焦浏览"><GalleryHorizontalEnd size={16}/><span>聚焦</span></button></div>
      {hiddenCount > 0 && <button className="album-other-toggle" aria-pressed={showOther} onClick={() => onShowOtherChange(!showOther)} title="软件素材、聊天图片等文件夹">{showOther ? '收起其他文件夹' : `显示其他文件夹 · ${hiddenCount}`}</button>}
    </div>
    {!visible.length ? <div className="home-empty album-overview-empty" role="status">{loading ? fatal ? <><AlertCircle size={26} /><p>暂时无法打开图库</p><span>{fatal}</span></> : <><LoaderCircle size={24} className="spin" /><span>正在打开你的图库…</span></> : query ? <><p>没有找到这个相簿</p><span>换一个文件夹名称试试</span></> : scanning ? <><LoaderCircle size={24} className="spin" /><p>正在整理文件夹</p><span>照片和子文件夹相簿会陆续出现在这里</span></> : hiddenCount && !showOther ? <><p>其他图像文件夹已收起</p><span>这里默认展示照片、截图和创作输出</span><button onClick={() => onShowOtherChange(true)}>查看其他文件夹</button></> : <><button className="empty-import" onClick={onImport}><Plus size={22} strokeWidth={1.4} />添加文件夹</button><span>包含照片的子文件夹，也会自动成为相簿</span></>}</div> : view === 'overview' ? <div className="album-overview-scroll" ref={overview} data-testid="album-overview-wall" onScroll={event => onScrollChange(event.currentTarget.scrollTop)}>{visible.map((album, index) => <button key={album.id} className={`album-overview-card ${index === current ? 'is-current' : ''}`} data-testid="album-card" data-album-id={album.id} data-album-path={album.path} aria-label={`${album.name}，${album.count} 项素材`} aria-current={index === current ? 'true' : undefined} onClick={() => { onActiveChange(album.id); onOpen(album); }}><span className="album-overview-cover">{album.cover ? <AlbumCoverImage cover={album.cover} thumbnail/> : <Folder size={40} strokeWidth={.8}/>}</span><span className="album-overview-copy"><strong>{album.name}</strong><span>{statusFor(album)}</span><small title={album.path}>{album.path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').slice(-2).join(' / ')}</small></span></button>)}</div> : <>
      <div className="album-carousel" onWheel={event => { if (Math.abs(event.deltaX) + Math.abs(event.deltaY) < 15 || performance.now() - wheelAt.current < 280) return; wheelAt.current = performance.now(); move((Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) > 0 ? 1 : -1); }} onPointerDown={event => { drag.current = { x: event.clientX, moved: false }; }} onPointerMove={event => { if (drag.current && Math.abs(event.clientX - drag.current.x) > 35) drag.current.moved = true; }} onPointerUp={event => { if (drag.current?.moved) { move(event.clientX > drag.current.x ? -1 : 1); ignoreClick.current = true; setTimeout(() => { ignoreClick.current = false; }, 180); } drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        {visible.map((album, index) => { const distance = index - current; if (Math.abs(distance) > 3) return null; return <button key={album.id} className={`album-cover-card ${distance === 0 ? 'is-current' : ''}`} data-testid="album-card" data-album-path={album.path} aria-label={`${album.name}，${album.count} 项素材`} aria-current={distance === 0 ? 'true' : undefined} style={{ '--distance': distance, '--card-scale': distance === 0 ? 1 : Math.max(.52, .76 - (Math.abs(distance) - 1) * .11), opacity: distance === 0 ? 1 : Math.max(.12, .56 - (Math.abs(distance) - 1) * .19), zIndex: 10 - Math.abs(distance) } as React.CSSProperties} onClick={() => { if (ignoreClick.current) return; if (distance === 0) onOpen(album); else onActiveChange(album.id); }}>
          <span className="album-cover-image">{album.cover ? <AlbumCoverImage cover={album.cover} /> : <Folder size={54} strokeWidth={.7} />}</span>
          <span className="album-cover-copy"><strong>{album.name}</strong><span>{statusFor(album)}</span><small title={album.path}>{album.path.replace(/\//g, '\\')}</small></span>
        </button>; })}
      </div>
      {visible.length > 1 && <><button className="carousel-arrow previous" aria-label="上一本相簿" disabled={current === 0} onClick={() => move(-1)}><ChevronLeft size={21} strokeWidth={1.3} /></button><button className="carousel-arrow next" aria-label="下一本相簿" disabled={current === visible.length - 1} onClick={() => move(1)}><ChevronRight size={21} strokeWidth={1.3} /></button></>}
      <div className="home-current-caption"><h1 key={active.id}>{active.name}</h1><span>{current + 1} / {visible.length}</span>{!active.count && !scanning && <div className="album-import-state" role="status"><span>{errorsFor(active) ? '部分文件未能读取，可查看原因后重试' : active.status === 'offline' ? '重新连接磁盘后，可再次扫描' : '可导入 JPG、PNG、WebP 等图片与常见视频'}</span>{errorsFor(active) > 0 && <button onClick={onErrors}><AlertCircle size={12} />查看扫描记录</button>}<button onClick={onRescan}><RefreshCw size={12} />重新扫描</button></div>}<button data-testid="open-album" onClick={() => { onActiveChange(active.id); onOpen(active); }}>打开相簿<ArrowRight size={14} strokeWidth={1.3} /></button></div>
    </>}
  </section>;
}
