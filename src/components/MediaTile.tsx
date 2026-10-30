import { memo, useEffect, useRef, useState } from 'react';
import { Check, Heart, ImageOff, Play } from 'lucide-react';
import type { MediaItem } from '../shared/types';
import { duration, isGif } from './helpers';

interface Props {
  item: MediaItem;
  instanceId: string;
  rect: { x: number; y: number; width: number; height: number };
  fit: 'contain' | 'cover'; selected: boolean; focused: boolean; activePreview: boolean;
  onHover: (id: string | null, mediaId?: string) => void;
  onSelect: (event: React.MouseEvent, item: MediaItem, instanceId: string) => void;
  onOpen: (item: MediaItem, instanceId: string) => void;
  onContext: (event: React.MouseEvent, item: MediaItem, instanceId: string) => void;
  onFavorite: (item: MediaItem) => void;
}
export const MediaTile = memo(function MediaTile({ item, instanceId, rect, fit, selected, focused, activePreview, onHover, onSelect, onOpen, onContext, onFavorite }: Props) {
  const [broken, setBroken] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const selectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (selectTimer.current) clearTimeout(selectTimer.current); }, []);
  useEffect(() => { setBroken(false); }, [item.thumbnailUrl, item.mtimeMs]);
  useEffect(() => { if (activePreview && video.current) video.current.play().catch(() => {}); }, [activePreview]);
  return <article
    className={`media-tile ${selected ? 'selected' : ''} ${focused ? 'focused' : ''} ${item.missing ? 'missing' : ''}`}
    style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    data-testid="media-tile" data-media-id={item.id} data-instance-id={instanceId}
    role="button" tabIndex={0} aria-label={item.fileName} aria-pressed={selected}
    onMouseEnter={() => onHover(instanceId,item.id)} onMouseLeave={() => onHover(null)}
    onClick={event => {
      if (selectTimer.current) clearTimeout(selectTimer.current);
      if (event.ctrlKey || event.metaKey || event.shiftKey) onSelect(event, item, instanceId);
      else if (item.kind === 'video') onOpen(item, instanceId);
      else selectTimer.current = setTimeout(() => { selectTimer.current = null; onSelect(event, item, instanceId); }, 230);
    }} onDoubleClick={() => { if (selectTimer.current) clearTimeout(selectTimer.current); selectTimer.current = null; if (item.kind !== 'video') onOpen(item, instanceId); }}
    onContextMenu={event => onContext(event, item, instanceId)}
    onKeyDown={event => { if (event.key === 'Enter') { event.stopPropagation(); if (event.target === event.currentTarget) { event.preventDefault(); onOpen(item, instanceId); } } }}
  >
    {!broken && !item.missing ? <img src={activePreview && isGif(item) ? item.originalUrl : focused ? item.previewUrl : item.thumbnailUrl} alt="" draggable={false} decoding="async" style={{ objectFit: fit }} onError={() => setBroken(true)} /> : <div className="media-fallback"><ImageOff size={24} /><span>{item.missing ? '文件暂时离线' : '预览暂不可用'}</span></div>}
    {activePreview && item.kind === 'video' && !item.missing && <video ref={video} src={item.originalUrl} muted autoPlay loop playsInline preload="metadata" className="tile-video" style={{ objectFit: fit }} onError={event => { event.currentTarget.style.display = 'none'; }} />}
    <div className="tile-top"><span className="tile-check">{selected && <Check size={13} />}</span><button className={`tile-favorite ${item.favorite ? 'is-favorite' : ''}`} title={item.favorite ? '取消收藏' : '收藏'} aria-label={item.favorite ? '取消收藏' : '收藏'} onClick={event => { event.stopPropagation(); onFavorite(item); }} onDoubleClick={event => event.stopPropagation()}><Heart size={15} fill={item.favorite ? 'currentColor' : 'none'} /></button></div>
    <div className="tile-caption"><span>{item.fileName}</span>{item.kind === 'video' && <span className="video-badge"><Play size={10} fill="currentColor" />{duration(item.duration)}</span>}{isGif(item) && <span className="gif-badge">GIF</span>}</div>
    {item.kind === 'video' && <span className="video-duration"><Play size={10} fill="currentColor" />{duration(item.duration)}</span>}
  </article>;
});
