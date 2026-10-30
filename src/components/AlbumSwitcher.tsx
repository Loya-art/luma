import { useEffect, useRef, useState } from 'react';
import { Album, Check, ChevronLeft, ChevronRight, Images } from 'lucide-react';
import type { Filter } from './helpers';
import { Presence } from './Presence';
export interface SwitchAlbum {key:string;name:string;count:number;cover?:string;filter:Filter;kind:string}
export default function AlbumSwitcher({albums,current,onSwitch}:{albums:SwitchAlbum[];current:string;onSwitch:(album:SwitchAlbum)=>void}){
  const [open,setOpen]=useState(false),[active,setActive]=useState(0);const root=useRef<HTMLDivElement>(null);const index=albums.findIndex(album=>album.key===current),album=albums[index];
  useEffect(()=>{setActive(Math.max(0,index));},[index]);
  const change=(next:number)=>{const selected=albums[(next+albums.length)%albums.length];if(selected){onSwitch(selected);setOpen(false);}};
  if(!album)return null;
  return <div className={`album-switcher ${open?'is-open':''}`} ref={root} data-testid="album-switcher" onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape'){setOpen(false);return;}if(open&&['ArrowDown','ArrowUp','Enter'].includes(event.key)){event.preventDefault();if(event.key==='Enter')change(active);else setActive(value=>(value+(event.key==='ArrowDown'?1:-1)+albums.length)%albums.length);}}}>
    <Presence>{open&&<div className="album-switch-surface"><button className="album-switch-dismiss" aria-label="关闭相册列表" onClick={()=>setOpen(false)}/><section className="album-switch-list" role="listbox" aria-label="切换相册" tabIndex={0}><header><span>相册</span><small>{albums.length} 本</small></header>{albums.map((item,itemIndex)=><button role="option" aria-selected={item.key===current} className={`${item.key===current?'current':''} ${itemIndex===active?'keyboard-active':''}`} key={item.key} onFocus={()=>setActive(itemIndex)} onClick={()=>change(itemIndex)}>{item.cover?<img src={item.cover} alt=""/>:<span className="switch-cover-empty"><Album size={21}/></span>}<span><strong>{item.name}</strong><small>{item.kind} · {item.count} 项</small></span>{item.key===current&&<Check size={15}/>}</button>)}</section></div>}</Presence>
    <div className="album-switch-current"><button title="上一个相册" aria-label="上一个相册" disabled={albums.length<2} onClick={()=>change(index-1)}><ChevronLeft size={17}/></button><button className="album-switch-title" aria-expanded={open} aria-label={`切换相册，当前${album.name}`} onClick={()=>{setOpen(value=>!value);setActive(index);}}>{album.cover?<img src={album.cover} alt=""/>:<span className="switch-cover-empty"><Album size={18}/></span>}<span><strong>{album.name}</strong><small>{album.count} 项素材</small></span><Images size={17}/></button><button title="下一个相册" aria-label="下一个相册" disabled={albums.length<2} onClick={()=>change(index+1)}><ChevronRight size={17}/></button></div>
  </div>;
}
