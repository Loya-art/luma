import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Album as AlbumIcon, ArrowDownWideNarrow, Check, ChevronDown, ChevronRight, CircleHelp, Ellipsis, Expand, Folder, FolderOpen, FolderPlus, Heart, Images, Info, LayoutGrid, ListFilter, LoaderCircle, Maximize2, Menu, Minus, Plus, RefreshCw, Search, Settings2, Shuffle, SlidersHorizontal, Tag, Trash2, Video, X, ZoomIn, LocateFixed, AlertCircle, ImageOff, ArrowUpRight, ArrowLeft, CheckSquare2, Layers } from 'lucide-react';
import { computeGridLayout } from './layout';
import { createInfiniteWallLayout, queryInfiniteWall, getInfiniteInstance } from './layout/infinite';
import { DEFAULT_SETTINGS, type Album, type Camera, type LibrarySnapshot, type MediaItem, type Settings, type Source } from './shared/types';
import { MediaTile } from './components/MediaTile';
import Viewer from './components/Viewer';
import AlbumHome, { type AlbumHomeView } from './components/AlbumHome';
import { Presence, usePresence } from './components/Presence';
import PhoneImportPanel from './components/PhoneImportPanel';
import PhoneReceivePanel from './components/PhoneReceivePanel';
import ComputerImportPanel from './components/ComputerImportPanel';
import IntelligencePanel, { AnalysisDetails } from './components/IntelligencePanel';
import AlbumSwitcher, { type SwitchAlbum } from './components/AlbumSwitcher';
import { SMART_CATEGORIES, type SearchMode, type SearchResponse } from './shared/intelligence';
import { bytes, date, duration, filterMedia, buildFolderAlbums, type FolderAlbum, type Filter } from './components/helpers';

const EMPTY: LibrarySnapshot = { media: [], sources: [], albums: [], tags: [], settings: DEFAULT_SETTINGS, jobs: [], errors: [] };
type Prompt = { title: string; description?: string; value?: string; placeholder?: string; confirm?: string; destructive?: boolean; input?: boolean; onConfirm: (value: string) => Promise<unknown> };
type Context = { x: number; y: number; media?: MediaItem; source?: Source; album?: Album };
const filterTitles: Record<Filter['kind'], string> = { all: '全部素材', favorite: '我的收藏', source: '文件夹', folder: '相簿', album: '相册', tag: '标签', smart: '智能相簿' };

export default function App() {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot>(EMPTY);
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SETTINGS, sidebarOpen: false, view: 'wall', fit: 'cover' });
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const sidebarMotion = usePresence(settings.sidebarOpen);
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);
  const [fatal, setFatal] = useState('');
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [home, setHome] = useState(true);
  const [homeAlbumId, setHomeAlbumId] = useState<string | null>(null);
  const [homeAlbumQuery, setHomeAlbumQuery] = useState('');
  const [homeAlbumView, setHomeAlbumView] = useState<AlbumHomeView>('overview');
  const [showOtherAlbums, setShowOtherAlbums] = useState(false);
  const homeAlbumScroll = useRef(0);
  const [wallHelpOpen, setWallHelpOpen] = useState(false);
  const frozenLayout = useRef<ReturnType<typeof computeGridLayout> | null>(null);
  const frozenWall = useRef<ReturnType<typeof createInfiniteWallLayout> | null>(null);
  const viewerReturnInstance = useRef<string | null>(null);
  const recordedViewerId = useRef<string | null>(null);
  const [filter, setFilter] = useState<Filter>({ kind: 'all' });
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [importOpen,setImportOpen]=useState(false),[phoneOpen,setPhoneOpen]=useState(false),[intelligenceOpen,setIntelligenceOpen]=useState(false),[computerOpen,setComputerOpen]=useState(false),[receiveOpen,setReceiveOpen]=useState(false);
  const [searchMode,setSearchMode]=useState<SearchMode>('all'),[searchResult,setSearchResult]=useState<SearchResponse|null>(null),[searchBusy,setSearchBusy]=useState(false);
  const searchSequence=useRef(0);
  const [mediaType, setMediaType] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sort, setSort] = useState('added');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [focusSize, setFocusSize] = useState<{width:number;height:number} | null>(null);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const focusOrigin = useRef<Camera | null>(null);
  const [cameraMotion, setCameraMotion] = useState(false);
  const cameraMotionRef = useRef(false);
  const cameraMotionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cameraMotionStart = useRef<Camera | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [errorsOpen, setErrorsOpen] = useState(false);
  const [context, setContext] = useState<Context | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const [promptBusy, setPromptBusy] = useState(false);
  const [albumPicker, setAlbumPicker] = useState<string[] | null>(null);
  const [tagPicker, setTagPicker] = useState<string[] | null>(null);
  const [tagValue, setTagValue] = useState('');
  const [activePreview, setActivePreview] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const [panning, setPanning] = useState(false);
  const pan = useRef<{ x: number; y: number; camera: Camera; moved: boolean; pointerId: number } | null>(null);
  const ignoreClick = useRef(false);
  const viewport = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({ width: 1100, height: 720 });
  const [scrollTop, setScrollTop] = useState(0);
  const lastSelected = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSettings = useRef<Partial<Settings>>({});
  const refreshBusy = useRef(false);
  const refreshPending = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message); if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 4200);
  }, []);
  const report = useCallback((error: unknown) => { notify(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error)); }, [notify]);
  const refresh = useCallback(async () => {
    if (refreshBusy.current) { refreshPending.current = true; return; }
    refreshBusy.current = true;
    try {
      const data = await window.album.getSnapshot();
      setSnapshot(data);
      if (!loadedRef.current) { setSettings({ ...DEFAULT_SETTINGS, ...data.settings, sidebarOpen: false, view: 'wall' }); loadedRef.current = true; setLoaded(true); }
    } catch (error) { if (!loadedRef.current) setFatal(String(error)); else report(error); }
    finally { refreshBusy.current = false; if (refreshPending.current) { refreshPending.current = false; refreshTimer.current = setTimeout(() => { refreshTimer.current = null; refresh(); }, 600); } }
  }, [report]);
  useEffect(() => {
    if (!window.album) { setFatal('请通过Luma桌面应用打开图库。'); return; }
    refresh();
    const off = window.album.onChange(event => {
      if (refreshTimer.current) return;
      refreshTimer.current = setTimeout(() => { refreshTimer.current = null; refresh(); }, event.type === 'progress' ? 1200 : 350);
    });
    return () => { off(); if (refreshTimer.current) clearTimeout(refreshTimer.current); refreshTimer.current = null; };
  }, [refresh]);
  const changeSettings = useCallback((patch: Partial<Settings>) => {
    const returnFromDrawer = patch.sidebarOpen === false && document.activeElement instanceof HTMLElement && document.activeElement.closest('.sidebar');
    setSettings(value => ({ ...value, ...patch }));
    if (returnFromDrawer) requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="library-toggle"]')?.focus({ preventScroll: true }));
    pendingSettings.current = { ...pendingSettings.current, ...patch };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const update = pendingSettings.current; pendingSettings.current = {};
      window.album?.setSettings(update).catch(report);
    }, 280);
  }, [report]);
  const stopCameraMotion = useCallback((): Camera => {
    let current = settingsRef.current.camera;
    if (cameraMotionRef.current && viewport.current) {
      const world = viewport.current.querySelector('.gallery-world');
      if (world) {
        const matrix = new DOMMatrix(getComputedStyle(world).transform);
        current = { x: matrix.e, y: matrix.f, scale: Math.hypot(matrix.a, matrix.b) || current.scale };
        settingsRef.current = { ...settingsRef.current, camera: current };
        changeSettings({ camera: current });
      }
    }
    cameraMotionRef.current = false; setCameraMotion(false);
    if (cameraMotionTimer.current) clearTimeout(cameraMotionTimer.current);
    return current;
  }, [changeSettings]);
  const animateCamera = useCallback((next: Camera) => {
    if (cameraMotionTimer.current) clearTimeout(cameraMotionTimer.current);
    let start=settingsRef.current.camera;
    const world=viewport.current?.querySelector('.gallery-world');
    if(world){const matrix=new DOMMatrix(getComputedStyle(world).transform);start={x:matrix.e,y:matrix.f,scale:Math.hypot(matrix.a,matrix.b)||start.scale};}
    cameraMotionStart.current=start;
    const motion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    cameraMotionRef.current = motion; setCameraMotion(motion); changeSettings({ camera: next });
    cameraMotionTimer.current = setTimeout(() => { cameraMotionRef.current = false; setCameraMotion(false); }, motion ? 350 : 0);
  }, [changeSettings]);
  const resetFocus = useCallback((restore = false) => {
    setFocusedId(null); setFocusSize(null);
    const origin = focusOrigin.current; focusOrigin.current = null;
    if (restore && origin) animateCamera(origin); else stopCameraMotion();
  }, [animateCamera, stopCameraMotion]);
  useEffect(() => () => { if (cameraMotionTimer.current) clearTimeout(cameraMotionTimer.current); }, []);
  useEffect(() => {
    const flush = () => { if (Object.keys(pendingSettings.current).length) window.album?.setSettings(pendingSettings.current); };
    window.addEventListener('beforeunload', flush); return () => window.removeEventListener('beforeunload', flush);
  }, []);
  useEffect(() => {
    const el = viewport.current; if (!el) return;
    const observer = new ResizeObserver(entries => setViewportSize({ width: entries[0].contentRect.width, height: entries[0].contentRect.height }));
    observer.observe(el); return () => observer.disconnect();
  }, [loaded, home]);
  const run = useCallback(async (operation: () => Promise<unknown>, success?: string) => { try { await operation(); await refresh(); if (success) notify(success); } catch (error) { report(error); } }, [notify, refresh, report]);
  const importFolders = useCallback(async () => {
    try { const paths = await window.album.chooseFolders(); if (paths.length) { await window.album.addSources(paths); await refresh(); } }
    catch (error) { report(error); }
  }, [refresh, report]);
  const openPrompt = useCallback((value: Prompt) => { setPrompt(value); setPromptValue(value.value || ''); setPromptBusy(false); setContext(null); }, []);
  const createAlbum = useCallback(() => openPrompt({ title: '新建相册', description: '把有关联的画面放在一起。素材仍保留在原文件夹。', placeholder: '例如：旅行片段、设计参考', input: true, confirm: '创建相册', onConfirm: async name => { if (!name.trim()) throw new Error('请输入相册名称'); const album = await window.album.createAlbum(name.trim()); setFilter({ kind: 'album', id: album.id, name: album.name }); setAlbumPicker(null); await refresh(); } }), [openPrompt, refresh]);
  const navigate = useCallback((next: Filter) => { setHome(false); setSearchOpen(false); setFilter(next); setSelected(new Set()); setSelectedInstanceId(null); resetFocus(false); setQuery(''); setContext(null); changeSettings({ camera: { x: 24, y: 24, scale: 0.85 } }); setScrollTop(0); if (viewport.current) viewport.current.scrollTop = 0; }, [changeSettings, resetFocus]);
  const scopeMedia = useMemo(() => {
    const from = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : -Infinity;
    const to = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : Infinity;
    return filterMedia(snapshot.media, filter, '', mediaType, sort).filter(item => item.mtimeMs >= from && item.mtimeMs <= to);
  }, [snapshot.media, filter, mediaType, sort, dateFrom, dateTo]);
  useEffect(()=>{const seq=++searchSequence.current;setSearchResult(null);if(!query.trim()){setSearchBusy(false);return;}setSearchBusy(true);const timer=setTimeout(()=>{window.album.searchMedia({query:query.trim(),mode:searchMode,ids:scopeMedia.map(item=>item.id),limit:120,offset:0}).then(result=>{if(seq===searchSequence.current)setSearchResult(result);}).catch(error=>{if(seq===searchSequence.current)report(error);}).finally(()=>{if(seq===searchSequence.current)setSearchBusy(false);});},230);return()=>{clearTimeout(timer);};},[query,searchMode,scopeMedia,report]);
  const loadSearchPage=async()=>{if(!searchResult||searchBusy)return;const seq=searchSequence.current;setSearchBusy(true);try{const page=await window.album.searchMedia({query:query.trim(),mode:searchMode,ids:scopeMedia.map(item=>item.id),limit:120,offset:searchResult.hits.length});if(seq===searchSequence.current)setSearchResult(current=>{if(!current)return page;const seen=new Set(current.hits.map(hit=>hit.id));return {...page,offset:0,hits:[...current.hits,...page.hits.filter(hit=>!seen.has(hit.id))]};});}catch(error){if(seq===searchSequence.current)report(error);}finally{if(seq===searchSequence.current)setSearchBusy(false);}};
  const filtered=useMemo(()=>{if(!query.trim())return scopeMedia;if(!searchResult)return filterMedia(scopeMedia,{kind:'all'},query,'all',sort);const items=new Map(scopeMedia.map(item=>[item.id,item]));return searchResult.hits.map(hit=>items.get(hit.id)).filter((item):item is MediaItem=>!!item);},[scopeMedia,query,searchResult,sort]);
  const byId = useMemo(() => new Map(snapshot.media.map(item => [item.id, item])), [snapshot.media]);
  const viewerItem = viewerId ? byId.get(viewerId) : null;
  const viewerMotion = usePresence(viewerItem);
  const selectedItems = useMemo(() => [...selected].map(id => byId.get(id)).filter((item): item is MediaItem => Boolean(item)), [selected, byId]);
  const primary = selectedItems[selectedItems.length - 1];
  const albumCounts = useMemo(() => { const counts = new Map<string, number>(); for (const item of snapshot.media) for (const id of item.albumIds) counts.set(id, (counts.get(id) || 0) + 1); return counts; }, [snapshot.media]);
  const tagCounts = useMemo(() => { const counts = new Map<string, number>(); for (const item of snapshot.media) for (const tag of item.tags) counts.set(tag, (counts.get(tag) || 0) + 1); return counts; }, [snapshot.media]);
  const favorites = useMemo(() => snapshot.media.filter(item => item.favorite).length, [snapshot.media]);
  const wallModel = useMemo(() => createInfiniteWallLayout(filtered, { seed: settings.seed, gap: settings.gap, unit: settings.thumbSize / 2, sizingMode: settings.sizingMode ?? 'balanced' }), [filtered, settings.seed, settings.gap, settings.thumbSize, settings.sizingMode]);
  const stableWall = viewerMotion.value && frozenWall.current ? frozenWall.current : wallModel;
  const liveLayout = useMemo(() => settings.view === 'grid' ? computeGridLayout(filtered, { width: Math.max(240, viewportSize.width - 32), gap: settings.gap, targetHeight: settings.thumbSize, fit: settings.fit, seed: settings.seed, sizingMode: settings.sizingMode ?? 'balanced' }) : { tiles: [], width: 0, height: 0 }, [filtered, settings.view, settings.seed, settings.gap, settings.thumbSize, settings.fit, settings.sizingMode, viewportSize.width]);
  const displayedLayout = viewerMotion.value && frozenLayout.current ? frozenLayout.current : liveLayout;
  const folderAlbums = useMemo(() => buildFolderAlbums(snapshot.media, snapshot.sources), [snapshot.media, snapshot.sources]);
  const switchAlbums=useMemo<SwitchAlbum[]>(()=>[
    ...folderAlbums.map(album=>({key:`folder:${album.path}`,name:album.name,count:album.count,cover:album.cover?.thumbnailUrl,filter:{kind:'folder' as const,id:album.path,name:album.name},kind:'文件夹相簿'})),
    ...snapshot.albums.map(album=>{const items=snapshot.media.filter(item=>item.albumIds.includes(album.id));return{key:`album:${album.id}`,name:album.name,count:items.length,cover:items.find(item=>item.kind==='image'&&!item.missing)?.thumbnailUrl,filter:{kind:'album' as const,id:album.id,name:album.name},kind:'相册'};}),
    ...SMART_CATEGORIES.map(name=>{const items=snapshot.media.filter(item=>item.aiTags?.includes(name));return{key:`smart:${name}`,name,count:items.length,cover:items.find(item=>!item.missing)?.thumbnailUrl,filter:{kind:'smart' as const,id:name,name},kind:'智能相簿'};}).filter(album=>album.count>0)
  ],[folderAlbums,snapshot.albums,snapshot.media]);
  const aiScope=(selected.size?selectedItems:filtered).filter(item=>item.kind==='image'&&!item.missing).map(item=>item.id);
  const camera = settings.camera;
  const visibleTiles = useMemo(() => {
    const buffer = 200;
    if (settings.view === 'wall') {
      let left=(-camera.x-buffer)/camera.scale,top=(-camera.y-buffer)/camera.scale,right=(viewportSize.width-camera.x+buffer)/camera.scale,bottom=(viewportSize.height-camera.y+buffer)/camera.scale;
      if(cameraMotion&&cameraMotionStart.current){const start=cameraMotionStart.current;left=Math.min(left,(-start.x-buffer)/start.scale);top=Math.min(top,(-start.y-buffer)/start.scale);right=Math.max(right,(viewportSize.width-start.x+buffer)/start.scale);bottom=Math.max(bottom,(viewportSize.height-start.y+buffer)/start.scale);}
      return queryInfiniteWall(stableWall, { x:left,y:top,width:right-left,height:bottom-top }, { focusInstanceId: focusedId ?? undefined, focusSize: focusSize ?? undefined, limit: 400, priorityBounds: {x:-camera.x/camera.scale,y:-camera.y/camera.scale,width:viewportSize.width/camera.scale,height:viewportSize.height/camera.scale} });
    }
    return displayedLayout.tiles.filter(tile => tile.y + tile.height >= scrollTop-buffer && tile.y <= scrollTop+viewportSize.height+buffer).map(tile => ({...tile,instanceId:tile.id,mediaId:tile.id,repeatX:0,repeatY:0}));
  }, [stableWall, displayedLayout, settings.view, camera, cameraMotion, focusedId, focusSize, scrollTop, viewportSize]);
  const minimumScale = Math.max(0.18, Math.sqrt(viewportSize.width * viewportSize.height / (220 * Math.max(1,stableWall.averageTileArea))));
  useEffect(() => {
    if(settings.view!=='wall'||!filtered.length||settings.camera.scale>=minimumScale)return;
    const old=settings.camera,x=viewportSize.width/2,y=viewportSize.height/2;
    changeSettings({camera:{scale:minimumScale,x:x-(x-old.x)/old.scale*minimumScale,y:y-(y-old.y)/old.scale*minimumScale}});
  },[minimumScale,filtered.length,settings.view,settings.camera,viewportSize,changeSettings]);
  const zoomAt = useCallback((factor: number, x?: number, y?: number) => {
    const old = stopCameraMotion(); const nextScale = Math.max(minimumScale, Math.min(2.8, old.scale * factor));
    const pointX = x ?? viewportSize.width / 2; const pointY = y ?? viewportSize.height / 2;
    changeSettings({ camera: { scale: nextScale, x: pointX - (pointX - old.x) / old.scale * nextScale, y: pointY - (pointY - old.y) / old.scale * nextScale } });
    setActivePreview(null);
  }, [minimumScale, viewportSize, changeSettings, stopCameraMotion]);
  useEffect(() => {
    const el = viewport.current; if (!el || settings.view !== 'wall') return;
    const onWheel = (event: WheelEvent) => { event.preventDefault(); const bounds = el.getBoundingClientRect(); if (event.shiftKey) { const old = stopCameraMotion(); changeSettings({ camera: { ...old, x: old.x - event.deltaY, y: old.y - event.deltaX } }); } else zoomAt(Math.exp(-event.deltaY * 0.0014), event.clientX - bounds.left, event.clientY - bounds.top); };
    el.addEventListener('wheel', onWheel, { passive: false }); return () => el.removeEventListener('wheel', onWheel);
  }, [settings.view, zoomAt, changeSettings, stopCameraMotion, loaded, home]);
  const lastView = useRef(settings.view);
  useEffect(() => {
    if (lastView.current === settings.view) return; lastView.current = settings.view;
    const id = lastSelected.current || settings.lastSelectedId;
    const tile = settings.view === 'wall' ? visibleTiles.find(entry => entry.mediaId === id) : displayedLayout.tiles.find(entry => entry.id === id);
    if (!tile) return;
    if (settings.view === 'grid' && viewport.current) { viewport.current.scrollTop = Math.max(0, tile.y - 80); setScrollTop(viewport.current.scrollTop); }
    else if (settings.view === 'wall') changeSettings({ camera: { ...settings.camera, x: viewportSize.width / 2 - (tile.x + tile.width / 2) * settings.camera.scale, y: viewportSize.height / 2 - (tile.y + tile.height / 2) * settings.camera.scale } });
  }, [settings.view, displayedLayout, visibleTiles, changeSettings, viewportSize, settings.camera, settings.lastSelectedId]);
  const favorite = useCallback((item: MediaItem) => { run(() => window.album.updateMedia([item.id], { favorite: !item.favorite })); }, [run]);
  const hover = useCallback((id: string | null, mediaId?: string) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setActivePreview(null);
    if (id && !pan.current?.moved && !viewerId && !byId.get(mediaId || id)?.missing) hoverTimer.current = setTimeout(() => setActivePreview(id), 500);
  }, [viewerId, byId]);
  const openViewer = useCallback((item: MediaItem, instanceId?: string) => { if (ignoreClick.current || viewerMotion.value && !viewerId) return; if (hoverTimer.current) clearTimeout(hoverTimer.current); setActivePreview(null); frozenLayout.current = displayedLayout; frozenWall.current = stableWall; viewerReturnInstance.current = instanceId ?? selectedInstanceId; setViewerId(item.id); setContext(null); }, [displayedLayout, stableWall, selectedInstanceId, viewerMotion.value, viewerId]);
  const closeViewer = useCallback(() => {
    const id = viewerId;
    setViewerId(null);
    requestAnimationFrame(() => { const original = viewerReturnInstance.current ? document.querySelector<HTMLElement>(`[data-instance-id="${viewerReturnInstance.current}"]`) : null; (original || (id ? document.querySelector<HTMLElement>(`[data-media-id="${id}"]`) : null))?.focus({ preventScroll: true }); });
  }, [viewerId]);
  const backHome = useCallback(() => { setHome(true); setSearchOpen(false); setAppearanceOpen(false); setQuery(''); setSelected(new Set()); setSelectedInstanceId(null); resetFocus(false); changeSettings({ sidebarOpen: false }); }, [changeSettings, resetFocus]);
  const openFolderAlbum = useCallback((album: FolderAlbum) => { setHomeAlbumId(album.id); navigate({ kind: 'folder', id: album.path, name: album.name }); changeSettings({ view: 'wall', camera: { x: 0, y: 0, scale: 0.85 } }); }, [navigate, changeSettings]);
  useEffect(() => { if (viewerId && recordedViewerId.current !== viewerId) { recordedViewerId.current = viewerId; window.album.recordOpen(viewerId).catch(report); } else if (!viewerId) recordedViewerId.current = null; }, [viewerId, report]);
  const onSelect = useCallback((event: React.MouseEvent, item: MediaItem, instanceId: string) => {
    if (ignoreClick.current) return;
    const modified = event.ctrlKey || event.metaKey || event.shiftKey;
    setSelected(previous => {
      if (event.shiftKey && lastSelected.current) {
        const from = filtered.findIndex(entry => entry.id === lastSelected.current); const to = filtered.findIndex(entry => entry.id === item.id);
        if (from >= 0 && to >= 0) return new Set([...previous, ...filtered.slice(Math.min(from, to), Math.max(from, to) + 1).map(entry => entry.id)]);
      }
      if (event.ctrlKey || event.metaKey) { const next = new Set(previous); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; }
      return new Set([item.id]);
    });
    lastSelected.current = item.id; setSelectedInstanceId(instanceId); changeSettings({ lastSelectedId: item.id });
    if (settingsRef.current.view === 'wall' && !modified) {
      if (focusedId === instanceId) { resetFocus(true); return; }
      const current = settingsRef.current.camera;
      if (!focusedId || !focusOrigin.current) focusOrigin.current = {...current};
      const aspect = Math.max(.05,item.width/Math.max(1,item.height));
      let height = viewportSize.height*.64, width = height*aspect;
      if (width>viewportSize.width*.68) { width=viewportSize.width*.68; height=width/aspect; }
      const size={width:width/current.scale,height:height/current.scale};
      const tile=getInfiniteInstance(stableWall,instanceId,{focusInstanceId:instanceId,focusSize:size});
      if (!tile) return;
      setFocusedId(instanceId); setFocusSize(size);
      if (hoverTimer.current) clearTimeout(hoverTimer.current); setActivePreview(null);
      animateCamera({scale:current.scale,x:viewportSize.width/2-(tile.x+tile.width/2)*current.scale,y:viewportSize.height/2-(tile.y+tile.height/2)*current.scale});
    }
  }, [filtered, focusedId, stableWall, viewportSize, changeSettings, resetFocus, animateCamera]);
  const contextMedia = useCallback((event: React.MouseEvent, item: MediaItem, instanceId: string) => { event.preventDefault(); event.stopPropagation(); setSelectedInstanceId(instanceId); if (!selectedRef.current.has(item.id)) setSelected(new Set([item.id])); setContext({ x: event.clientX, y: event.clientY, media: item }); }, []);
  useEffect(() => { if (!context) return; const close = () => setContext(null); window.addEventListener('click', close); return () => window.removeEventListener('click', close); }, [context]);
  const removeSelected = useCallback((ids = [...selectedRef.current]) => {
    if (!ids.length) return;
    openPrompt({ title: `删除 ${ids.length} 项素材？`, description: '原文件将从磁盘移至 Windows 回收站，可在回收站中恢复。所有相册中的同一文件都会一起移除。', confirm: '移至回收站', destructive: true, onConfirm: async () => { const result=await window.album.trashMedia(ids); setSelected(new Set(result.failed.map(item=>item.id))); setSelectedInstanceId(null); resetFocus(false); await refresh(); if(result.failed.length)throw new Error(`已删除 ${result.removed.length} 项；${result.failed.map(item=>item.fileName+'：'+item.message).join('；')}`); notify(`已将 ${result.removed.length} 项移至回收站`); } });
  }, [openPrompt, refresh]);
  const stepViewer = useCallback((delta: number) => { setViewerId(current => { const index = filtered.findIndex(item => item.id === current); return filtered[Math.max(0, Math.min(filtered.length - 1, index + delta))]?.id || current; }); }, [filtered]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const editing = event.target instanceof Element && event.target.closest('input,textarea,select');
      if (viewerMotion.value || prompt || tagPicker || albumPicker || phoneOpen || intelligenceOpen || importOpen || computerOpen || receiveOpen) return;
      if (editing && (event.key !== 'Escape' || !searchOpen)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') { event.preventDefault(); backHome(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' || !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 's') { event.preventDefault(); if(home){document.getElementById('album-search')?.focus();return;} setSearchOpen(true); setTimeout(() => document.getElementById('library-search')?.focus(), 0); return; }
      if (event.key === 'Escape') { if (appearanceOpen || settings.sidebarOpen || infoOpen || searchOpen) { setSearchOpen(false); setQuery(''); changeSettings({ sidebarOpen: false }); setAppearanceOpen(false); setInfoOpen(false); setContext(null); } else if (selected.size) { setSelected(new Set()); setSelectedInstanceId(null); resetFocus(true); } else if (!home) backHome(); return; }
      if (home) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); setSelected(new Set(filtered.map(item => item.id))); }
      if (event.key === 'Enter' && primary && !(event.target instanceof Element && event.target.closest('button,[role="button"]'))) { event.preventDefault(); openViewer(primary); }
      if (event.key === 'Delete' && selected.size) removeSelected();
      if (event.key.startsWith('Arrow') && settings.view === 'wall' && visibleTiles.length) {
        event.preventDefault(); const tiles = visibleTiles;
        const cx=(viewportSize.width/2-camera.x)/camera.scale,cy=(viewportSize.height/2-camera.y)/camera.scale;
        const active = tiles.find(tile => selected.size&&tile.instanceId === selectedInstanceId) || [...tiles].sort((a,b)=>(a.x+a.width/2-cx)**2+(a.y+a.height/2-cy)**2-((b.x+b.width/2-cx)**2+(b.y+b.height/2-cy)**2))[0];
        const ax = active.x + active.width / 2, ay = active.y + active.height / 2;
        const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
        const sign = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
        let best = active, score = Infinity;
        for (const tile of tiles) { if (tile.instanceId === active.instanceId) continue; const dx = tile.x + tile.width / 2 - ax, dy = tile.y + tile.height / 2 - ay; const along = (horizontal ? dx : dy) * sign, across = horizontal ? dy : dx; if (along <= 1) continue; const candidate = along + Math.abs(across) * 2.5 + across * across / Math.max(1, along); if (candidate < score) { score = candidate; best = tile; } }
        setSelected(new Set([best.mediaId])); setSelectedInstanceId(best.instanceId); resetFocus(false); lastSelected.current = best.mediaId;
        const normal=getInfiniteInstance(stableWall,best.instanceId)||best;
        const cam = settingsRef.current.camera, x = (normal.x + normal.width / 2) * cam.scale + cam.x, y = (normal.y + normal.height / 2) * cam.scale + cam.y;
        changeSettings({ lastSelectedId: best.mediaId });
        if(x<70||x>viewportSize.width-70||y<70||y>viewportSize.height-100)animateCamera({...cam,x:viewportSize.width/2-(normal.x+normal.width/2)*cam.scale,y:viewportSize.height/2-(normal.y+normal.height/2)*cam.scale});
      }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [viewerMotion.value, prompt, tagPicker, albumPicker, phoneOpen, intelligenceOpen, importOpen, computerOpen, receiveOpen, filtered, primary, selected.size, selectedInstanceId, openViewer, removeSelected, backHome, home, appearanceOpen, settings.sidebarOpen, infoOpen, searchOpen, settings.view, stableWall, visibleTiles, camera, viewportSize, changeSettings, resetFocus, animateCamera]);
  const sourceContext = (event: React.MouseEvent, source: Source) => { event.preventDefault(); event.stopPropagation(); setContext({ x: event.clientX, y: event.clientY, source }); };
  const runningJob = snapshot.jobs.find(job => job.status === 'running');
  const title = filter.name || filterTitles[filter.kind];

  return <div className={`app ${settings.sidebarOpen ? '' : 'sidebar-hidden'}`} onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; setDragOver(true); } }} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDragLeave={() => { dragDepth.current--; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragOver(false); } }} onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragOver(false); const paths = window.album.getDroppedPaths(Array.from(event.dataTransfer.files)); if (paths.length) run(() => window.album.addSources(paths)); }}>
    <div className="window-drag-region" aria-hidden="true" />
    <aside className="sidebar" aria-hidden={!settings.sidebarOpen} inert={!settings.sidebarOpen}>
      <div className="drawer-heading"><span>图库</span><button className="icon-button" title="关闭图库" onClick={() => changeSettings({ sidebarOpen: false })}><X size={17} /></button></div>
      <div className="sidebar-section main-nav"><button className={`nav-item ${filter.kind === 'all' ? 'active' : ''}`} onClick={() => navigate({ kind: 'all' })}><Images size={18} /><span>全部素材</span><small>{snapshot.media.length.toLocaleString()}</small></button><button className={`nav-item ${filter.kind === 'favorite' ? 'active' : ''}`} onClick={() => navigate({ kind: 'favorite' })}><Heart size={18} /><span>我的收藏</span><small>{favorites.toLocaleString()}</small></button></div>
      <div className="sidebar-scroll"><div className="sidebar-section"><div className="section-heading"><span>文件夹</span><button title="添加文件夹" data-testid="import-folder-sidebar" onClick={importFolders}><Plus size={15} /></button></div>{snapshot.sources.length === 0 && <p className="sidebar-empty">从一个文件夹开始</p>}{snapshot.sources.map(source => <div className="nav-row" key={source.id}><button className={`nav-item ${filter.kind === 'source' && filter.id === source.id ? 'active' : ''}`} onClick={() => navigate({ kind: 'source', id: source.id, name: source.name })} title={source.path} onContextMenu={event => sourceContext(event, source)}><Folder size={17} /><span>{source.name}</span>{source.status === 'offline' ? <i className="offline-dot" title="文件夹离线" /> : <small>{source.count}</small>}</button><button className="row-menu" aria-label={`${source.name} 文件夹菜单`} onClick={event => sourceContext(event, source)}><Ellipsis size={16} /></button></div>)}</div>
      <div className="sidebar-section"><div className="section-heading"><span>相册</span><button title="新建相册" data-testid="create-album" onClick={createAlbum}><Plus size={15} /></button></div>{snapshot.albums.length === 0 && <p className="sidebar-empty">收藏片段，组成故事</p>}{snapshot.albums.map(album => <div className="nav-row" key={album.id}><button className={`nav-item ${filter.kind === 'album' && filter.id === album.id ? 'active' : ''}`} onClick={() => navigate({ kind: 'album', id: album.id, name: album.name })}><AlbumIcon size={17} /><span>{album.name}</span><small>{albumCounts.get(album.id) || 0}</small></button><button className="row-menu" aria-label={`${album.name} 相册菜单`} onClick={event => { event.stopPropagation(); setContext({ x: event.clientX, y: event.clientY, album }); }}><Ellipsis size={16} /></button></div>)}</div>
      <div className="sidebar-section"><div className="section-heading"><span>标签</span><Tag size={13} /></div>{snapshot.tags.length === 0 && <p className="sidebar-empty">为画面留下线索</p>}<div className="sidebar-tags">{snapshot.tags.map(tag => <button key={tag} className={filter.kind === 'tag' && filter.id === tag ? 'active' : ''} onClick={() => navigate({ kind: 'tag', id: tag, name: tag })}><span className="tag-dot" />{tag}<small>{tagCounts.get(tag) || 0}</small></button>)}</div></div></div>
      <div className="sidebar-section smart-nav"><div className="section-heading"><span>智能相簿</span><button title="智能整理" onClick={()=>setIntelligenceOpen(true)}><Settings2 size={14}/></button></div>{SMART_CATEGORIES.map(name=><button className={`nav-item ${filter.kind==='smart'&&filter.id===name?'active':''}`} key={name} onClick={()=>navigate({kind:'smart',id:name,name})}><Layers size={16}/><span>{name}</span><small>{snapshot.media.filter(item=>item.aiTags?.includes(name)).length}</small></button>)}</div>
      <div className="sidebar-bottom"><div className="local-badge"><span />本地图库<small>文件留在原处</small></div><button className="button import-secondary" onClick={importFolders}><FolderPlus size={16} />添加文件夹</button><button className="button import-secondary" onClick={()=>setIntelligenceOpen(true)}><Layers size={16}/>智能整理</button><button className="help-link" onClick={() => setHelpOpen(true)}><CircleHelp size={14} />操作指南<span>?</span></button></div>
    </aside>
    {sidebarMotion.value && !settings.sidebarOpen && <div className="sidebar-exit-shield" aria-hidden="true" onPointerDown={event => event.preventDefault()} />}
    <main className="workspace">
      <nav className="floating-dock" aria-label="图库工具">
        <button data-testid="import-folder" title="添加照片" aria-label="添加照片" onClick={()=>setImportOpen(value=>!value)}><Plus size={20} strokeWidth={1.6} /></button>
        <button className={searchOpen ? 'active' : ''} data-testid="search-toggle" title="搜索 · Ctrl F" aria-label="搜索" onClick={() => { if(home){document.getElementById('album-search')?.focus();return;}setSearchOpen(value => !value); setAppearanceOpen(false); }}><Search size={18} strokeWidth={1.6} /></button>
        <button className={settings.sidebarOpen ? 'active' : ''} data-testid="library-toggle" title="图库与整理" aria-label="图库与整理" onClick={() => { changeSettings({ sidebarOpen: !settings.sidebarOpen }); setAppearanceOpen(false); }}><AlbumIcon size={18} strokeWidth={1.6} /></button>
        <button className={appearanceOpen ? 'active' : ''} data-testid="more-toggle" title="排版与选项" aria-label="排版与选项" onClick={() => { setAppearanceOpen(value => !value); setSearchOpen(false); }}><SlidersHorizontal size={18} strokeWidth={1.6} /></button>
      </nav>
      {!home && <button className="back-albums" data-testid="back-albums" title="返回相簿 · Ctrl B" onClick={backHome}><ArrowLeft size={18} strokeWidth={1.5} /></button>}
      <Presence>{searchOpen && <div className="floating-search"><Search size={17} /><input id="library-search" aria-label="搜索素材" autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索文字、人物、海边合照…" /><span>{searchBusy?'搜索中…':`${(searchResult?.total??filtered.length).toLocaleString()} 项`}</span><button title="关闭搜索" aria-label="关闭搜索" onClick={() => { setSearchOpen(false); setQuery(''); }}><X size={16} /></button></div>}</Presence>
      <Presence>{searchOpen&&<div className="search-mode-bar"><div className="segmented">{(['all','text','content'] as SearchMode[]).map(mode=><button key={mode} className={searchMode===mode?'active':''} onClick={()=>setSearchMode(mode)}>{mode==='all'?'全部':mode==='text'?'图片文字':'画面内容'}</button>)}</div>{searchResult?.warning&&<small>{searchResult.warning}</small>}{searchResult&&searchResult.total>filtered.length&&<button className="button subtle" disabled={searchBusy} onClick={loadSearchPage}>再显示 120 项</button>}</div>}</Presence>
      <Presence>{appearanceOpen && <div className="options-panel" data-testid="options-panel">
        <div className="popover-heading"><span>排版与选项</span><button title="关闭选项" onClick={() => setAppearanceOpen(false)}><X size={16} /></button></div>
        <div className="option-row"><label>浏览</label><div className="segmented view-toggle"><button className={settings.view === 'wall' ? 'active' : ''} data-testid="view-wall" title="自由图片墙" onClick={() => { resetFocus(false); changeSettings({ view: 'wall' }); }}><LayoutGrid size={14} />图片墙</button><button className={settings.view === 'grid' ? 'active' : ''} data-testid="view-grid" title="滚动整理视图" onClick={() => { resetFocus(false); changeSettings({ view: 'grid' }); }}><Images size={14} />整理</button></div></div>
        <div className="option-row"><label>尺寸偏好</label><select aria-label="尺寸偏好" data-testid="sizing-mode" className="text-select" value={settings.sizingMode ?? 'balanced'} onChange={event => { resetFocus(false); changeSettings({ sizingMode: event.target.value as Settings['sizingMode'], camera: { x: 0, y: 0, scale: .85 } }); }}><option value="balanced">均衡</option><option value="views">常看 · 看得越多越大</option><option value="recent">最近 · 拍得越近越大</option><option value="bytes">文件体积 · 越大越醒目</option></select></div>
        <div className="option-row"><label>画面</label><div className="segmented fit-toggle"><button className={settings.fit === 'contain' ? 'active' : ''} data-testid="fit-contain" onClick={() => changeSettings({ fit: 'contain' })}>完整显示</button><button className={settings.fit === 'cover' ? 'active' : ''} data-testid="fit-cover" onClick={() => changeSettings({ fit: 'cover' })}>紧密拼贴</button></div></div>
        <label className="option-range">图片大小<span>{settings.thumbSize}</span><input aria-label="图片大小" type="range" min="140" max="400" step="10" value={settings.thumbSize} onChange={event => changeSettings({ thumbSize: +event.target.value })} /></label>
        <label className="option-range">间距<span>{settings.gap}</span><input aria-label="图片间距" type="range" min="2" max="24" step="1" value={settings.gap} onChange={event => changeSettings({ gap: +event.target.value })} /></label>
        <div className="option-actions"><button onClick={() => { resetFocus(false); changeSettings({ seed: settings.seed + 1 }); }}><Shuffle size={15} />换个排法</button><button onClick={() => { resetFocus(false); changeSettings({ camera: { x: 16, y: 16, scale: 0.85 } }); }}><LocateFixed size={15} />回到起点</button></div>
        {!home && <div className="wall-lighting"><div className="focus-tint-row"><Layers size={17} strokeWidth={1.5} /><span>聚焦叠色</span><button className={`glass-switch ${settings.focusTint !== false ? 'on' : ''}`} role="switch" aria-label="聚焦叠色" aria-checked={settings.focusTint !== false} onClick={() => changeSettings({ focusTint: settings.focusTint === false })}><i /></button></div><div className="lighting-row"><div className="segmented"><button className={settings.lighting !== 'dim' ? 'active' : ''} onClick={() => changeSettings({ lighting: 'light' })}>开灯</button><button className={settings.lighting === 'dim' ? 'active' : ''} onClick={() => changeSettings({ lighting: 'dim' })}>关灯</button></div><button title="显示快捷键" aria-label="显示快捷键" data-testid="wall-help-toggle" className={wallHelpOpen ? 'active' : ''} onClick={() => setWallHelpOpen(value => !value)}><CircleHelp size={18} strokeWidth={1.5} /></button></div>{wallHelpOpen && <div className="wall-shortcuts"><div><span>打开选中的图片</span><kbd>Enter</kbd></div><div><span>取消选中 / 返回相簿</span><kbd>Esc</kbd></div><div><span>方向键移动选中</span><kbd>↑ ↓ ← →</kbd></div><div><span>搜索图片</span><kbd>S</kbd></div><div><span>返回相簿</span><kbd>Ctrl B</kbd></div></div>}</div>}
        <div className="option-separator" />
        <div className="option-row"><label>类型</label><select className="text-select" aria-label="素材类型" value={mediaType} onChange={event => { setMediaType(event.target.value); resetFocus(false); }}><option value="all">全部素材</option><option value="image">图片</option><option value="video">视频</option></select></div>
        <div className="option-row"><label>排序</label><select className="text-select" aria-label="排序方式" value={sort} onChange={event => { setSort(event.target.value); resetFocus(false); }}><option value="added">导入顺序</option><option value="newest">日期 · 从新到旧</option><option value="oldest">日期 · 从旧到新</option><option value="name">文件名称</option></select></div>
        <button className="option-disclosure" aria-label="日期筛选" data-testid="date-filters" onClick={() => setFiltersOpen(value => !value)}><span>修改日期筛选</span><ChevronDown size={14} /></button>
        {filtersOpen && <div className="inline-date-filter"><label>从<input type="date" aria-label="起始修改日期" data-testid="date-from" value={dateFrom} max={dateTo || undefined} onChange={event => { setDateFrom(event.target.value); resetFocus(false); }} /></label><label>到<input type="date" aria-label="截止修改日期" data-testid="date-to" value={dateTo} min={dateFrom || undefined} onChange={event => { setDateTo(event.target.value); resetFocus(false); }} /></label><button onClick={() => { setDateFrom(''); setDateTo(''); }}>清除日期筛选</button></div>}
        <div className="option-actions"><button onClick={()=>{setIntelligenceOpen(true);setAppearanceOpen(false);}}><Layers size={15}/>智能整理与模型</button><button onClick={()=>{setPhoneOpen(true);setAppearanceOpen(false);}}><FolderPlus size={15}/>手机导入任务</button></div><div className="option-separator" /><div className="option-bottom"><span>{filtered.length.toLocaleString()} 项素材</span><button onClick={() => { setHelpOpen(true); setAppearanceOpen(false); }} title="操作指南"><CircleHelp size={15} /></button>{snapshot.errors.length > 0 && <button title="扫描记录" onClick={() => { setErrorsOpen(true); setAppearanceOpen(false); }}><AlertCircle size={15} />{snapshot.errors.length}</button>}</div>
      </div>}</Presence>
      <Presence>{home && <div className="page-layer album-page"><AlbumHome albums={folderAlbums} query={homeAlbumQuery} onQueryChange={value => { homeAlbumScroll.current = 0; setHomeAlbumQuery(value); }} view={homeAlbumView} onViewChange={setHomeAlbumView} showOther={showOtherAlbums} onShowOtherChange={value => { homeAlbumScroll.current = 0; setShowOtherAlbums(value); }} initialScrollTop={homeAlbumScroll.current} onScrollChange={top => { homeAlbumScroll.current = top; }} onOpen={openFolderAlbum} onAll={() => navigate({ kind: 'all' })} onFavorites={() => navigate({ kind: 'favorite' })} onImport={importFolders} activeId={homeAlbumId} onActiveChange={setHomeAlbumId} loading={!loaded} fatal={fatal} scanning={Boolean(runningJob)} errors={snapshot.errors} onErrors={() => setErrorsOpen(true)} onRescan={() => run(() => window.album.rescan())} /></div>}</Presence><Presence>{!home && <div className="content-row page-layer wall-page"><div className={`gallery-viewport ${settings.view} ${panning ? 'panning' : ''} ${settings.lighting === 'dim' ? 'lights-dim' : ''} ${selected.size ? 'has-selection' : ''} ${settings.focusTint !== false ? 'focus-tint' : ''}`} ref={viewport} data-testid="gallery-viewport" onScroll={event => { if (settings.view === 'grid') { setScrollTop(event.currentTarget.scrollTop); setActivePreview(null); } }}
        onPointerDown={event => { if (settings.view !== 'wall' || event.button !== 0 || event.target instanceof Element && event.target.closest('button,input,select')) return; pan.current = { x: event.clientX, y: event.clientY, camera: stopCameraMotion(), moved: false, pointerId: event.pointerId }; }}
        onPointerMove={event => { if (!pan.current) return; const dx = event.clientX - pan.current.x; const dy = event.clientY - pan.current.y; if (Math.abs(dx) + Math.abs(dy) > 5) { if (!pan.current.moved) { event.currentTarget.setPointerCapture(event.pointerId); setPanning(true); setActivePreview(null); if (hoverTimer.current) clearTimeout(hoverTimer.current); } pan.current.moved = true; changeSettings({ camera: { ...pan.current.camera, x: pan.current.camera.x + dx, y: pan.current.camera.y + dy } }); } }}
        onPointerUp={event => { if (!pan.current) return; if (pan.current.moved) { ignoreClick.current = true; setTimeout(() => { ignoreClick.current = false; }, 180); } pan.current = null; setPanning(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { pan.current = null; setPanning(false); }}
        onClick={event => { if ((event.target === event.currentTarget || event.target instanceof Element && event.target.classList.contains('gallery-world')) && !ignoreClick.current) { resetFocus(true); setSelected(new Set()); setSelectedInstanceId(null); } }}>
        {!loaded ? <div className="loading-state">{fatal ? <><AlertCircle size={30} /><h2>暂时无法打开图库</h2><p>{fatal}</p></> : <><LoaderCircle className="spin" size={25} /><p>正在唤醒你的图库…</p></>}</div> : !snapshot.media.length && !runningJob ? <div className="empty-state"><button className="empty-import" onClick={importFolders}><Plus size={22} strokeWidth={1.4} /><span>添加文件夹</span></button><p className="drop-hint">或将文件夹拖到这里</p></div> : !filtered.length ? <div className="no-results"><Search size={30} /><h2>{runningJob ? '正在整理第一批画面' : filter.kind === 'album' ? '这个相册，等待你的第一张图' : '这里暂时没有素材'}</h2><p>{runningJob ? '扫描完成的素材会自动出现在这里。' : query ? '换一个词试试；文字和内容搜索需先在智能整理中建立本地索引。' : filter.kind === 'album' ? '在全部素材中选中图片，再加入相册。' : '试试其他筛选，或添加一个文件夹。'}</p>{!runningJob && <button className="button subtle" onClick={() => { navigate({ kind: 'all' }); setMediaType('all'); setDateFrom(''); setDateTo(''); }}>查看全部素材</button>}</div> : <div className={`gallery-world ${cameraMotion ? 'camera-animating' : ''}`} style={settings.view === 'wall' ? { width: stableWall.width, height: stableWall.height, transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` } : { width: displayedLayout.width, height: displayedLayout.height, margin: '16px' }} data-testid="gallery-world">{visibleTiles.map(tile => { const item = byId.get(tile.mediaId); return item && <MediaTile key={tile.instanceId} item={item} instanceId={tile.instanceId} rect={tile} fit={settings.fit} selected={selected.has(item.id) && (settings.view === 'grid' || selected.size > 1 || selectedInstanceId === tile.instanceId)} focused={focusedId === tile.instanceId} activePreview={activePreview === tile.instanceId && !panning} onHover={hover} onSelect={onSelect} onOpen={openViewer} onContext={contextMedia} onFavorite={favorite} />; })}</div>}

      </div>
      <Presence>{infoOpen && primary && <aside className="details-panel"><div className="details-heading"><span>素材详情</span><button title="关闭详情" onClick={() => setInfoOpen(false)}><X size={16} /></button></div><div className="details-preview"><img src={primary.previewUrl} alt={primary.fileName} /></div><h3>{primary.fileName}</h3><div className="details-badges"><span>{primary.kind === 'video' ? '视频' : primary.fileName.split('.').pop()?.toUpperCase()}</span>{primary.missing && <span className="missing-label">离线</span>}<button className={primary.favorite ? 'active' : ''} onClick={() => favorite(primary)}><Heart size={14} fill={primary.favorite ? 'currentColor' : 'none'} />{primary.favorite ? '已收藏' : '收藏'}</button></div><dl><dt>尺寸</dt><dd>{primary.width} × {primary.height}</dd><dt>大小</dt><dd>{bytes(primary.size)}</dd>{primary.kind === 'video' && <><dt>时长</dt><dd>{duration(primary.duration)}</dd></>}<dt>修改时间</dt><dd>{date(primary.mtimeMs)}</dd><dt>加入图库</dt><dd>{date(primary.addedAt)}</dd></dl><div className="detail-section"><div className="section-heading"><span>标签</span><button title="添加标签" onClick={() => { setTagPicker([primary.id]); setTagValue(''); }}><Plus size={15} /></button></div><div className="detail-tags">{primary.tags.length ? primary.tags.map(tag => <span key={tag}>{tag}<button title={`移除标签 ${tag}`} onClick={() => run(() => window.album.updateMedia([primary.id], { removeTags: [tag] }))}><X size={11} /></button></span>) : <p>尚未添加标签</p>}</div></div><div className="detail-section"><div className="section-heading"><span>所在相册</span><button title="加入相册" onClick={() => setAlbumPicker([primary.id])}><Plus size={15} /></button></div>{primary.albumIds.length ? primary.albumIds.map(id => <div className="detail-album" key={id}><AlbumIcon size={14} /><span>{snapshot.albums.find(album => album.id === id)?.name || '相册'}</span><button title="移出这个相册" onClick={() => run(() => window.album.updateMedia([primary.id], { removeAlbumIds: [id] }))}><X size={13} /></button></div>) : <p className="muted">尚未加入相册</p>}</div><AnalysisDetails id={primary.id} revision={snapshot.media} report={report}/>{query&&searchResult?.hits.find(hit=>hit.id===primary.id)&&<p className="search-match-reason">{searchResult.hits.find(hit=>hit.id===primary.id)?.reason}</p>}<div className="detail-section"><span className="section-label">文件位置</span><p className="file-path">{primary.path}</p><button className="button subtle" onClick={() => window.album.reveal(primary.id).catch(report)}><FolderOpen size={14} />在文件夹中显示<ArrowUpRight size={13} /></button></div>{selected.size > 1 && <div className="details-note">已选择 {selected.size} 项，当前显示最后选中的素材。</div>}</aside>}</Presence>
      </div>}</Presence>
      <Presence>{selected.size > 0 && !viewerId && <div className="selection-bar"><button title="取消选择" onClick={() => { setSelected(new Set()); setSelectedInstanceId(null); resetFocus(false); }}><X size={16} /></button><strong>已选 {selected.size} 项</strong><span /><button title="收藏所选" onClick={() => run(() => window.album.updateMedia([...selected], { favorite: !selectedItems.every(item => item.favorite) }))}><Heart size={16} />收藏</button><button onClick={() => { setTagPicker([...selected]); setTagValue(''); }}><Tag size={16} />标签</button><button onClick={() => setAlbumPicker([...selected])}><AlbumIcon size={16} />加入相册</button><button title="查看详情" onClick={() => setInfoOpen(value => !value)}><Info size={16} /></button><button title="删除原文件" onClick={() => removeSelected()}><Trash2 size={16} /></button></div>}</Presence>
      <Presence>{!home&&!viewerId&&['folder','album','smart'].includes(filter.kind)&&<AlbumSwitcher albums={switchAlbums} current={`${filter.kind}:${filter.id}`} onSwitch={album=>navigate(album.filter)}/>}</Presence>
      <Presence>{runningJob && <div className="scan-pill"><LoaderCircle size={13} className="spin" /><span>{runningJob.label}</span><small>{runningJob.done.toLocaleString()}{runningJob.total > 0 ? ` / ${runningJob.total.toLocaleString()}` : ''}</small>{runningJob.type === 'scan' && <button title="停止扫描" onClick={() => window.album.cancelScan().catch(report)}><X size={13} /></button>}</div>}</Presence>
    </main>
    <Presence>{importOpen&&<div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setImportOpen(false);}} onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape')setImportOpen(false);}}><section className="modal import-choice" role="dialog" aria-label="添加照片"><div className="modal-heading"><h2>添加照片</h2><button aria-label="关闭添加照片" onClick={()=>setImportOpen(false)}><X size={18}/></button></div><button className="import-choice-row" onClick={()=>{setImportOpen(false);importFolders();}}><FolderPlus size={25}/><span><strong>从电脑文件夹添加</strong><small>保留原文件夹，自动整理为相簿</small></span><ChevronRight size={16}/></button><button className="import-choice-row" data-testid="import-computer-scan" onClick={()=>{setImportOpen(false);setComputerOpen(true);}}><Search size={25}/><span><strong>扫描电脑照片</strong><small>查找整个磁盘，选好后加入相簿</small></span><ChevronRight size={16}/></button><button className="import-choice-row" data-testid="import-phone-receive" onClick={()=>{setImportOpen(false);setReceiveOpen(true);}}><Images size={25}/><span><strong>手机无线传入</strong><small>同一 Wi-Fi 扫码，不用开发者模式</small></span><ChevronRight size={16}/></button><button className="import-choice-row" data-testid="import-phone" onClick={()=>{setImportOpen(false);setPhoneOpen(true);}}><FolderOpen size={25}/><span><strong>调试连接导入（高级）</strong><small>无线或 USB 调试，整机共享照片扫描与备份</small></span><ChevronRight size={16}/></button></section></div>}</Presence>
    <Presence>{computerOpen&&<ComputerImportPanel onClose={()=>setComputerOpen(false)} report={report}/>}</Presence>
    <Presence>{receiveOpen&&<PhoneReceivePanel onClose={()=>setReceiveOpen(false)} report={report}/>}</Presence>
    <Presence>{phoneOpen&&<PhoneImportPanel onClose={()=>setPhoneOpen(false)} report={report}/>}</Presence>
    <Presence>{intelligenceOpen&&<IntelligencePanel ids={aiScope} onClose={()=>setIntelligenceOpen(false)} report={report}/>}</Presence>
    <Presence>{context && <div className="context-menu" style={{ left: Math.min(context.x, window.innerWidth - 225), top: Math.min(context.y, window.innerHeight - 265) }} onClick={event => event.stopPropagation()}>
      {context.media && <><button onClick={() => { openViewer(context.media!); setContext(null); }}><Expand size={15} />打开查看</button><button onClick={() => { favorite(context.media!); setContext(null); }}><Heart size={15} />{context.media.favorite ? '取消收藏' : '加入收藏'}</button><button onClick={() => { setTagPicker([...selected]); setTagValue(''); setContext(null); }}><Tag size={15} />添加标签</button><button onClick={() => { setAlbumPicker([...selected]); setContext(null); }}><AlbumIcon size={15} />加入相册</button><hr /><button onClick={() => { window.album.reveal(context.media!.id).catch(report); setContext(null); }}><FolderOpen size={15} />在文件夹中显示</button><button onClick={() => { window.album.openExternal(context.media!.id).catch(report); setContext(null); }}><ArrowUpRight size={15} />使用系统应用打开</button><hr /><button className="danger" onClick={() => removeSelected()}><Trash2 size={15} />删除原文件</button></>}
      {context.source && <><span className="context-title">{context.source.name}</span><button onClick={() => { run(() => window.album.rescan(context.source!.id)); setContext(null); }}><RefreshCw size={15} />重新扫描</button><button onClick={() => { run(() => window.album.relinkSource(context.source!.id)); setContext(null); }}><FolderOpen size={15} />重新定位文件夹</button><hr /><button className="danger" onClick={() => { const source = context.source!; openPrompt({ title: `移除文件夹“${source.name}”？`, description: '取消对这个文件夹的索引，磁盘上的文件保持原样。', confirm: '移除文件夹', destructive: true, onConfirm: async () => { await window.album.removeSource(source.id); navigate({ kind: 'all' }); await refresh(); } }); }}><Trash2 size={15} />从图库移除文件夹</button></>}
      {context.album && <><span className="context-title">{context.album.name}</span><button onClick={() => { const album = context.album!; openPrompt({ title: '重命名相册', input: true, value: album.name, confirm: '保存名称', onConfirm: async name => { if (!name.trim()) throw new Error('请输入相册名称'); await window.album.renameAlbum(album.id, name.trim()); if (filter.id === album.id) setFilter({ kind: 'album', id: album.id, name: name.trim() }); await refresh(); } }); }}><AlbumIcon size={15} />重命名相册</button><button className="danger" onClick={() => { const album = context.album!; openPrompt({ title: `删除相册“${album.name}”？`, description: '相册中的素材仍保留在图库和原文件夹。', confirm: '删除相册', destructive: true, onConfirm: async () => { await window.album.deleteAlbum(album.id); if (filter.id === album.id) navigate({ kind: 'all' }); await refresh(); } }); }}><Trash2 size={15} />删除相册</button></>}
    </div>}</Presence>
    <Presence>{prompt && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !promptBusy) setPrompt(null); }}><form className="modal" onSubmit={async event => { event.preventDefault(); setPromptBusy(true); try { await prompt.onConfirm(promptValue); setPrompt(null); } catch (error) { report(error); } finally { setPromptBusy(false); } }}><div className="modal-heading"><h2>{prompt.title}</h2><button type="button" title="关闭" onClick={() => setPrompt(null)} disabled={promptBusy}><X size={18} /></button></div>{prompt.description && <p>{prompt.description}</p>}{prompt.input && <input className="field" autoFocus aria-label={prompt.title} value={promptValue} placeholder={prompt.placeholder} onChange={event => setPromptValue(event.target.value)} maxLength={100} />}<div className="modal-actions"><button type="button" className="button subtle" onClick={() => setPrompt(null)} disabled={promptBusy}>取消</button><button className={`button ${prompt.destructive ? 'danger-button' : 'primary'}`} disabled={promptBusy || prompt.input && !promptValue.trim()}>{promptBusy && <LoaderCircle size={15} className="spin" />}{prompt.confirm || '确定'}</button></div></form></div>}</Presence>
    <Presence>{tagPicker && <div className="modal-backdrop"><form className="modal" onSubmit={async event => { event.preventDefault(); const tags = [...new Set(tagValue.split(/[,，;；\n]/).map(value => value.trim()).filter(Boolean))]; if (!tags.length) return; await run(() => window.album.updateMedia(tagPicker, { addTags: tags }), '标签已添加'); setTagPicker(null); }}><div className="modal-heading"><h2>为 {tagPicker.length} 项素材添加标签</h2><button type="button" title="关闭" onClick={() => setTagPicker(null)}><X size={18} /></button></div><p>用逗号分隔多个标签，也可以选择已有标签。</p><input className="field" aria-label="标签名称" autoFocus value={tagValue} onChange={event => setTagValue(event.target.value)} placeholder="旅行，海边，灵感" /><div className="tag-suggestions">{snapshot.tags.slice(0, 30).map(tag => <button type="button" key={tag} onClick={() => setTagValue(value => [...new Set([...value.split(/[,，]/).map(word => word.trim()).filter(Boolean), tag])].join('，'))}>{tag}<Plus size={12} /></button>)}</div><div className="modal-actions"><button className="button subtle" type="button" onClick={() => setTagPicker(null)}>取消</button><button className="button primary" disabled={!tagValue.trim()}>添加标签</button></div></form></div>}</Presence>
    <Presence>{albumPicker && <div className="modal-backdrop"><div className="modal"><div className="modal-heading"><h2>加入相册</h2><button title="关闭" onClick={() => setAlbumPicker(null)}><X size={18} /></button></div><p>将 {albumPicker.length} 项素材加入相册，不会移动原文件。</p><div className="album-options">{snapshot.albums.map(album => <button key={album.id} onClick={async () => { await run(() => window.album.updateMedia(albumPicker, { addAlbumIds: [album.id] }), `已加入“${album.name}”`); setAlbumPicker(null); }}><AlbumIcon size={20} /><span>{album.name}</span><small>{albumCounts.get(album.id) || 0} 项</small><ChevronRight size={16} /></button>)}</div><button className="button subtle full-width" onClick={() => { const ids = albumPicker; setAlbumPicker(null); openPrompt({ title: '新建相册并加入素材', input: true, placeholder: '相册名称', confirm: '创建并加入', onConfirm: async name => { const album = await window.album.createAlbum(name.trim()); await window.album.updateMedia(ids, { addAlbumIds: [album.id] }); await refresh(); } }); }}><Plus size={16} />新建相册</button></div></div>}</Presence>
    <Presence>{helpOpen && <div className="modal-backdrop"><div className="modal help-modal"><div className="modal-heading"><h2>慢慢看，好好收藏。</h2><button title="关闭" onClick={() => setHelpOpen(false)}><X size={18} /></button></div><p>Luma引用你选择的文件夹，分类与预览保存在本机。</p><div className="shortcut-row"><span>图片墙漫游</span><kbd>鼠标拖动</kbd></div><div className="shortcut-row"><span>缩放图片墙</span><kbd>滚轮</kbd></div><div className="shortcut-row"><span>横向移动图片墙</span><kbd>Shift + 滚轮</kbd></div><div className="shortcut-row"><span>聚焦一张图片</span><kbd>单击</kbd></div><div className="shortcut-row"><span>打开原图</span><kbd>双击 / Enter</kbd></div><div className="shortcut-row"><span>播放视频</span><kbd>单击 / Enter</kbd></div><div className="shortcut-row"><span>选择多项 / 连续多项</span><kbd>Ctrl / Shift + 单击</kbd></div><div className="shortcut-row"><span>全选当前结果</span><kbd>Ctrl + A</kbd></div><div className="shortcut-row"><span>关闭查看器 / 取消选择</span><kbd>Esc</kbd></div><p className="help-note">照片的“删除”会将原文件移至 Windows 回收站。移除文件夹或删除虚拟相册仅取消整理关系。文件夹被移动或磁盘离线后，可通过文件夹菜单重新定位。</p></div></div>}</Presence>
    <Presence>{errorsOpen && <div className="modal-backdrop"><div className="modal errors-modal"><div className="modal-heading"><h2>扫描记录</h2><button title="关闭" onClick={() => setErrorsOpen(false)}><X size={18} /></button></div><p>部分文件可能损坏、格式暂不支持或暂时无法读取。</p><div className="error-list">{snapshot.errors.map((error, index) => <div key={`${error.path}:${index}`}><strong>{error.path.split(/[\\/]/).pop()}</strong><p>{error.message}</p><small>{error.path}</small></div>)}</div></div></div>}</Presence>
    {viewerMotion.value && <Viewer item={viewerMotion.value} active={Boolean(viewerItem)} motionPhase={viewerMotion.phase} index={filtered.findIndex(item => item.id === viewerMotion.value!.id)} total={filtered.length} jobs={snapshot.jobs} onClose={closeViewer} onStep={stepViewer} onFavorite={favorite} report={report} />}
    {viewerMotion.value && !viewerItem && <div className="viewer-exit-shield" aria-hidden="true" onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => event.stopPropagation()} />}
    <Presence>{toast && <div className="toast" role="status"><span>{toast}</span><button title="关闭提示" onClick={() => setToast('')}><X size={14} /></button></div>}</Presence>
    <Presence>{dragOver && <div className="drop-overlay"><FolderPlus size={40} /><h2>添加文件夹</h2><p>松开以索引文件夹中的照片与视频</p></div>}</Presence>
  </div>;
}
