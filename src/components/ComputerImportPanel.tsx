import { useEffect, useMemo, useState, type HTMLAttributes } from 'react';
import { Check, FolderOpen, HardDrive, ImageOff, LoaderCircle, Search, Square, X } from 'lucide-react';
import type { ComputerDiscoveryState, ComputerLocation } from '../shared/discovery';
import { bytes } from './helpers';
import './computer-import.css';

function FolderPreview({ url }: { url?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return url && !failed ? <img className="computer-folder-preview" src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)}/> : <span className="computer-folder-preview preview-unavailable"><ImageOff size={18}/><small>{failed ? '无法预览' : '暂无预览'}</small></span>;
}

export default function ComputerImportPanel({ onClose, report, ...surfaceProps }: { onClose: () => void; report: (error: unknown) => void } & HTMLAttributes<HTMLDivElement>) {
  const [locations, setLocations] = useState<ComputerLocation[]>([]);
  const [roots, setRoots] = useState<Set<string>>(new Set());
  const [state, setState] = useState<ComputerDiscoveryState | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [resultMode, setResultMode] = useState<'recommended' | 'all'>('recommended');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState('');
  const [visibleCount, setVisibleCount] = useState(40);
  const [added, setAdded] = useState(false);
  useEffect(() => {
    let alive = true;
    window.album.computerLocations().then(items => { if (!alive) return; setLocations(items); setRoots(new Set(items.filter(item => item.kind === 'folder' && ['图片', '桌面'].includes(item.name)).map(item => item.path))); }).catch(report);
    const refresh = () => window.album.computerDiscoveryState().then(value => { if (alive) setState(value); }).catch(report);
    refresh(); const timer = setInterval(refresh, 900);
    return () => { alive = false; clearInterval(timer); };
  }, [report]);
  const running = state?.status === 'running';
  const folders = state?.folders ?? [];
  const selected = folders.filter(folder => chosen.has(folder.path));
  const recommendations = folders.filter(folder => folder.recommended);
  const results = useMemo(() => { const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean); return folders.filter(folder => (resultMode === 'all' || folder.recommended) && words.every(word => `${folder.name} ${folder.path}`.toLocaleLowerCase().includes(word))); }, [folders, resultMode, query]);
  useEffect(() => { setChosen(new Set()); setAdded(false); setQuery(''); setResultMode('recommended'); }, [state?.id]);
  useEffect(() => setAdded(false), [chosen]);
  useEffect(() => setVisibleCount(40), [state?.id, resultMode, query]);
  const run = async (label: string, work: () => Promise<unknown>) => { setBusy(label); try { await work(); } catch (error) { report(error); } finally { setBusy(''); } };
  const selectLocation = (file: string) => setRoots(current => { const next = new Set(current); next.has(file) ? next.delete(file) : next.add(file); return next; });
  return <div {...surfaceProps} className="modal-backdrop" onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') onClose(); }}><section className="modal computer-import-modal" role="dialog" aria-modal="true" aria-label="扫描电脑照片">
    <div className="modal-heading"><h2><HardDrive size={20} />扫描电脑照片</h2><button aria-label="关闭电脑扫描" onClick={onClose}><X size={18} /></button></div>
    <p>寻找散落在电脑里的照片，按文件夹整理成相簿。加入相册不移动原文件，也不额外复制一份。</p>
    <div className="computer-scope-heading"><span>扫描范围</span><div><button className="button subtle" disabled={running} onClick={() => setRoots(new Set(locations.filter(item => item.kind === 'folder').map(item => item.path)))}>常用位置</button><button className="button subtle" disabled={running || !locations.some(item => item.kind === 'disk')} onClick={() => setRoots(new Set(locations.filter(item => item.kind === 'disk').map(item => item.path)))}>全部磁盘</button></div></div>
    <div className="computer-location-list">{locations.map(location => <label key={location.path}><input type="checkbox" disabled={running} checked={roots.has(location.path)} onChange={() => selectLocation(location.path)} />{location.kind === 'disk' ? <HardDrive size={19} /> : <FolderOpen size={19} />}<span><strong>{location.name}</strong><small>{location.path}</small></span>{location.totalBytes !== undefined && <small>{bytes(location.totalBytes)}</small>}</label>)}</div>
    <div className="computer-scope-actions"><button className="button subtle" disabled={running || !!busy} onClick={() => run('选择扫描位置', async () => { const picked = await window.album.chooseFolders(); if (!picked.length) return; setLocations(current => [...current, ...picked.filter(file => !current.some(item => item.path === file)).map(file => ({ path: file, name: file.split(/[\\/]/).filter(Boolean).pop() || file, kind: 'folder' as const }))]); setRoots(current => new Set([...current, ...picked])); })}><FolderOpen size={15} />选择其他文件夹</button>{running ? <button className="button subtle" data-testid="cancel-computer-scan" onClick={() => run('正在停止扫描', () => window.album.cancelComputerDiscovery())}><Square size={13} />停止扫描</button> : <button className="button primary" data-testid="start-computer-scan" disabled={!roots.size || !!busy} onClick={() => run('正在开始扫描', async () => { setState(await window.album.discoverComputer([...roots])); })}><Search size={15} />{state?.id ? '重新扫描' : '开始扫描'}</button>}</div>
    <p className="computer-exclusions">保留照片、游戏截图和 ComfyUI output 创作输出，默认过滤游戏贴图、软件素材、聊天图片和缓存。扫描只读取文件信息；无权访问的位置会列在下方。</p>
    {state?.id && <div className="computer-scan-status" role="status"><div>{running ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}<strong>{running ? '正在寻找照片' : state.status === 'cancelled' ? '扫描已停止，已发现的结果仍可加入' : state.status === 'error' ? '扫描遇到问题' : '扫描完成'}</strong></div><span>{state.count.toLocaleString()} 项 · {bytes(state.bytes)} · {folders.length.toLocaleString()} 个文件夹</span>{state.currentDirectory && <small title={state.currentDirectory}>{state.currentDirectory}</small>}<small>已查看 {state.visitedDirectories.toLocaleString()} 个目录 · 跳过 {state.skippedDirectories.toLocaleString()} 个目录{state.filteredDirectories ? ` · 其中过滤素材或聊天目录 ${state.filteredDirectories.toLocaleString()} 个` : ''}</small></div>}
    {!!folders.length && <div className="computer-results">
      <p className="computer-exclusions">找到的 {folders.length.toLocaleString()} 个候选目录还不是相册。先看预览，勾选想管理的目录后再加入。</p>
      <div className="computer-result-toolbar"><div className="segmented"><button aria-pressed={resultMode === 'recommended'} className={resultMode === 'recommended' ? 'active' : ''} onClick={() => setResultMode('recommended')}>推荐照片目录 · {recommendations.length.toLocaleString()}</button><button aria-pressed={resultMode === 'all'} className={resultMode === 'all' ? 'active' : ''} onClick={() => setResultMode('all')}>全部候选 · {folders.length.toLocaleString()}</button></div><label><Search size={15}/><input aria-label="搜索扫描结果" placeholder="搜索名称或路径" value={query} onChange={event => setQuery(event.target.value)}/></label></div>
      <div className="section-heading"><span>{results.length.toLocaleString()} 个结果</span><div><button disabled={!results.length} onClick={() => setChosen(current => new Set([...current, ...results.slice(0, visibleCount).map(folder => folder.path)]))}>选择已显示的 {Math.min(results.length, visibleCount)} 个</button><button disabled={!chosen.size} onClick={() => setChosen(new Set())}>清空选择</button></div></div>
      <div className="computer-folder-list" data-testid="computer-discovery-results">{results.slice(0, visibleCount).map(folder => <label key={folder.path}><input type="checkbox" aria-label={`选择 ${folder.path}`} checked={chosen.has(folder.path)} onChange={() => setChosen(current => { const next = new Set(current); next.has(folder.path) ? next.delete(folder.path) : next.add(folder.path); return next; })}/><FolderPreview url={folder.previewUrl}/><span><strong>{folder.name}</strong><small title={folder.path}>{folder.path}</small><small>{folder.recommendation}</small></span><small>{folder.photos} 张照片{folder.videos ? ` · ${folder.videos} 个视频` : ''}<br/>{bytes(folder.bytes)}</small></label>)}</div>
      {!results.length && <p className="computer-exclusions">{query ? '没有找到匹配目录，试试其他名称。' : '暂未发现推荐的照片目录，可切换“全部候选”预览，或缩小扫描范围。'}</p>}
      {results.length > visibleCount && <button className="button subtle computer-show-more" onClick={() => setVisibleCount(value => value + 40)}>继续显示（{visibleCount} / {results.length}）</button>}
      <p className="computer-exclusions">只加入所选目录本层的照片，子目录需要分别选择。关闭面板后扫描继续。</p><div className="modal-actions"><span className="muted">已选 {selected.length.toLocaleString()} 个文件夹 · {selected.reduce((total, folder) => total + folder.count, 0).toLocaleString()} 项</span><button className="button primary" data-testid="add-computer-results" disabled={!selected.length || !!busy || added} onClick={() => run('正在加入图库', async () => { await window.album.addDiscoveredFolders(state!.id!, selected.map(folder => folder.path)); setAdded(true); })}>{added ? <><Check size={15}/>已加入图库</> : '加入所选文件夹'}</button></div>{added && <p className="muted">照片正在后台建立预览，已经完成的可以立即浏览。</p>}
    </div>}
    {state?.id && !running && !folders.length && <p className="muted">这个范围暂未找到支持的照片或视频，可以选择其他磁盘或文件夹再试。</p>}
    {!!state?.filteredDirectories && <details className="computer-scan-issues" data-testid="computer-filtered-directories"><summary>已过滤 {state.filteredDirectories.toLocaleString()} 个素材、聊天或缓存目录{state.filteredDirectories > state.filtered.length ? `（显示前 ${state.filtered.length} 个）` : ''}</summary><p>这些目录未展开扫描，数量表示目录数，不是照片数。需要某个目录时，可使用“＋ → 从电脑文件夹添加”手动加入。</p>{state.filtered.map(item => <p key={item.path}><strong>{item.path}</strong><br />{item.reason}</p>)}</details>}
    {!!state?.issueCount && <details className="computer-scan-issues"><summary>{state.issueCount.toLocaleString()} 项读取提示{state.issueCount > state.issues.length ? `（显示前 ${state.issues.length} 项）` : ''}</summary>{state.issues.map((issue, index) => <p key={index}><strong>{issue.path}</strong><br />{issue.message}</p>)}</details>}
    {busy && <p className="connected-status"><LoaderCircle className="spin" size={14} />{busy}</p>}
  </section></div>;
}
