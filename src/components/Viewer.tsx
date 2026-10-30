import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Expand, Heart, Maximize, Minus, Plus, RotateCcw, X, LoaderCircle, AlertCircle, FolderOpen } from 'lucide-react';
import type { JobState, MediaItem } from '../shared/types';
import { bytes, displayName, duration } from './helpers';
import type { MotionPhase } from './Presence';

interface Props { item: MediaItem; index: number; total: number; jobs: JobState[]; active?: boolean; motionPhase?: MotionPhase; onClose: () => void; onStep: (delta: number) => void; onFavorite: (item: MediaItem) => void; report: (error: unknown) => void }
export default function Viewer({ item, index, total, jobs, active = true, motionPhase = 'idle', onClose, onStep, onFavorite, report }: Props) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [videoUrl, setVideoUrl] = useState(item.originalUrl);
  const [converting, setConverting] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [stage, setStage] = useState({ width: 1000, height: 700 });
  const [original, setOriginal] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const media = useRef<HTMLVideoElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const itemRef = useRef(item.id);
  const activeRef = useRef(active); activeRef.current = active;
  const proxyAttempted = useRef(false);
  const wakeControls = useCallback(() => {
    setControlsVisible(true);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setControlsVisible(false), 2600);
  }, []);
  useEffect(() => { wakeControls(); return () => { if (idleTimer.current) clearTimeout(idleTimer.current); }; }, [item.id, wakeControls]);
  useEffect(() => {
    itemRef.current = item.id; proxyAttempted.current = false;
    setZoom(1); setOffset({ x: 0, y: 0 }); setVideoUrl(item.originalUrl); setConverting(false); setVideoError(false); setImageError(false); setOriginal(false);
  }, [item.id, item.originalUrl]);
  useEffect(() => {
    if (!frame.current) return;
    const resize = new ResizeObserver(entries => setStage({ width: entries[0].contentRect.width, height: entries[0].contentRect.height }));
    resize.observe(frame.current); return () => resize.disconnect();
  }, []);
  useEffect(() => {
    if (!active) { media.current?.pause(); return; }
    const handler = (event: KeyboardEvent) => {
      event.stopImmediatePropagation();
      wakeControls();
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
      if (event.key === 'ArrowLeft') onStep(-1);
      if (event.key === 'ArrowRight') onStep(1);
      if (event.key === '+' || event.key === '=') setZoom(value => Math.min(12, value * 1.25));
      if (event.key === '-') setZoom(value => Math.max(0.1, value / 1.25));
      if (event.key === '0') { setZoom(1); setOffset({ x: 0, y: 0 }); setOriginal(false); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [active, onClose, onStep, wakeControls]);
  const compatible = useCallback(async () => {
    if (!activeRef.current) return;
    if (proxyAttempted.current) { setVideoError(true); return; }
    proxyAttempted.current = true; setConverting(true); const id = item.id;
    try { const url = await window.album.prepareVideo(id); if (itemRef.current === id && activeRef.current) { setVideoUrl(url); setVideoError(false); } }
    catch (error) { if (itemRef.current === id && activeRef.current) { setVideoError(true); report(error); } }
    finally { if (itemRef.current === id && activeRef.current) setConverting(false); }
  }, [item.id, report]);
  const imageScale = Math.min(stage.width / Math.max(1, item.width), stage.height / Math.max(1, item.height), 1);
  const renderScale = original ? zoom : imageScale * zoom;
  const job = jobs.find(entry => entry.type === 'video' && entry.status === 'running');
  return <div className={`viewer ${controlsVisible ? '' : 'idle'}`} data-motion={motionPhase} inert={!active} aria-hidden={!active} data-testid="viewer" role="dialog" aria-modal="true" aria-label={`查看 ${item.fileName}`} onPointerMove={wakeControls} onPointerDown={wakeControls} onFocusCapture={wakeControls}>
    <header className="viewer-bar"><div className="viewer-title"><span className="eyebrow">{item.kind === 'video' ? 'VIDEO' : 'PHOTOGRAPH'}</span><strong>{item.fileName}</strong></div><div className="viewer-counter">{index + 1}<span>/ {total}</span></div><div className="viewer-actions"><button className={item.favorite ? 'active' : ''} title="收藏" onClick={() => onFavorite(item)}><Heart size={19} fill={item.favorite ? 'currentColor' : 'none'} /></button><button title="在文件夹中显示" onClick={() => window.album.reveal(item.id).catch(report)}><FolderOpen size={19} /></button><button title="全屏" onClick={() => { if (document.fullscreenElement) document.exitFullscreen(); else frame.current?.parentElement?.requestFullscreen(); }}><Expand size={19} /></button><button title="关闭 · Esc" onClick={onClose}><X size={22} /></button></div></header>
    <div ref={frame} className={`viewer-stage ${zoom > 1 || original ? 'zoomed' : ''}`} onWheel={event => { if (item.kind !== 'image') return; event.preventDefault(); setZoom(value => Math.max(0.1, Math.min(12, value * (event.deltaY < 0 ? 1.12 : 1 / 1.12)))); }}
      onPointerDown={event => { if (item.kind !== 'image' || event.target instanceof Element && event.target.closest('button')) return; drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (drag.current) setOffset({ x: drag.current.ox + event.clientX - drag.current.x, y: drag.current.oy + event.clientY - drag.current.y }); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      {item.missing ? <div className="viewer-message"><AlertCircle size={38} /><h3>原文件暂时无法访问</h3><p>重新连接磁盘，或在文件夹菜单中重新定位。</p></div> : item.kind === 'image' ? imageError ? <div className="viewer-message"><AlertCircle size={38} /><h3>无法显示这张图片</h3><button className="button" onClick={() => window.album.openExternal(item.id).catch(report)}>使用系统应用打开</button></div> : <img key={item.id} className="viewer-image" src={item.originalUrl} alt={item.fileName} draggable={false} style={{ width: Math.max(1, item.width) * renderScale, height: Math.max(1, item.height) * renderScale, transform: `translate(${offset.x}px, ${offset.y}px)` }} onError={() => setImageError(true)} /> : videoError ? <div className="viewer-message"><AlertCircle size={38} /><h3>这个视频暂时无法播放</h3><p>可使用系统播放器打开原文件。</p><button className="button" onClick={() => window.album.openExternal(item.id).catch(report)}>使用系统播放器打开</button></div> : <video key={`${item.id}:${videoUrl}`} ref={media} src={videoUrl} controls autoPlay={active} playsInline className="viewer-video" onLoadedData={() => { if (!activeRef.current) media.current?.pause(); }} onError={() => { if (!converting && activeRef.current) compatible(); }} />}
      {converting && <div className="conversion"><LoaderCircle size={28} className="spin" /><h3>正在准备兼容播放版本</h3><p>{job ? `${job.label} · ${job.total ? Math.round(job.done / job.total * 100) : 0}%` : '首次播放可能需要一点时间，原文件保持不变。'}</p><button className="button subtle" onClick={() => { window.album.cancelVideo(item.id).catch(report); setConverting(false); setVideoError(true); }}>取消转换</button></div>}
      <button className="viewer-prev" disabled={index === 0} title="上一项 · ←" onClick={() => onStep(-1)}><ChevronLeft size={28} /></button><button className="viewer-next" disabled={index === total - 1} title="下一项 · →" onClick={() => onStep(1)}><ChevronRight size={28} /></button>
    </div>
    <footer className="viewer-bottom"><span>{item.width} × {item.height}<i />{bytes(item.size)}{item.kind === 'video' && <><i />{duration(item.duration)}</>}</span>{item.kind === 'image' && <div className="zoom-tools"><button title="缩小" onClick={() => setZoom(value => Math.max(0.1, value / 1.2))}><Minus size={16} /></button><span>{Math.round(renderScale * 100)}%</span><button title="放大" onClick={() => setZoom(value => Math.min(12, value * 1.2))}><Plus size={16} /></button><em /><button title="适应窗口 · 0" onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); setOriginal(false); }}><Maximize size={16} /></button><button className="text-button" onClick={() => { setOriginal(true); setZoom(1); setOffset({ x: 0, y: 0 }); }}>1:1</button></div>}<span className="viewer-keyboard">← → 切换　 Esc 返回</span></footer>
  </div>;
}
