import { useEffect, useState, type HTMLAttributes } from 'react';
import { Copy, FolderOpen, LoaderCircle, QrCode, Smartphone, Square, X } from 'lucide-react';
import type { PhoneReceiveState } from '../shared/receive';
import { bytes } from './helpers';
import './phone-receive.css';

export default function PhoneReceivePanel({onClose,report,...surfaceProps}:{onClose:()=>void;report:(error:unknown)=>void}&HTMLAttributes<HTMLDivElement>) {
  const [state,setState]=useState<PhoneReceiveState|null>(null),[destination,setDestination]=useState(''),[albumName,setAlbumName]=useState('来自手机'),[busy,setBusy]=useState(false),[address,setAddress]=useState(0),[copied,setCopied]=useState(false);
  useEffect(()=>{let alive=true;const refresh=()=>window.album.phoneReceiveState().then(value=>{if(alive)setState(value);}).catch(report);refresh();const timer=setInterval(refresh,1200);return()=>{alive=false;clearInterval(timer);};},[report]);
  const run=async(work:()=>Promise<unknown>)=>{setBusy(true);try{await work();setState(await window.album.phoneReceiveState());}catch(error){report(error);}finally{setBusy(false);}};
  const current=state?.addresses[Math.min(address,(state?.addresses.length??1)-1)];
  return <div {...surfaceProps} className="modal-backdrop" onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape')onClose();}}><section className="modal connected-modal receive-modal" role="dialog" aria-modal="true" aria-label="手机无线传入">
    <div className="modal-heading"><h2><Smartphone size={19}/>手机无线传入</h2><button aria-label="关闭无线传入面板" onClick={onClose}><X size={18}/></button></div>
    <p>同一 Wi-Fi，扫码后在手机浏览器选择照片发送。无需开发者模式，也不用安装手机端软件。</p>
    {!state?.active?<div className="receive-setup"><button className="destination-picker" onClick={()=>run(async()=>{const selected=await window.album.chooseImportDestination();if(selected)setDestination(selected);})}><FolderOpen size={17}/><span>{destination||'选择照片保存文件夹，建议 E 盘'}</span></button><label>相册名称<input className="field" value={albumName} maxLength={100} aria-label="无线传入相册名称" onChange={event=>setAlbumName(event.target.value)}/></label><button className="button primary" disabled={busy||!destination||!albumName.trim()} onClick={()=>run(async()=>{setAddress(0);await window.album.startPhoneReceive({destination,albumName});})}><QrCode size={16}/>开始接收</button></div>:<>
      <div className="receive-connection">{current&&<><img className="receive-qr" src={current.qrCode} alt="手机扫码打开照片发送页面"/><div><strong>手机扫一扫，打开浏览器</strong><p>只接收你在手机上选中的照片和视频。手机原件保留，收到后可立即浏览。</p>{state.addresses.length>1&&<select className="field" aria-label="电脑网络地址" value={address} onChange={event=>setAddress(Number(event.target.value))}>{state.addresses.map((item,index)=><option key={item.name+index} value={index}>{item.name}</option>)}</select>}<button className="receive-link" title="复制手机访问地址" onClick={()=>run(async()=>{await navigator.clipboard.writeText(current.url);setCopied(true);setTimeout(()=>setCopied(false),2000);})}><Copy size={14}/>{copied?'地址已复制':current.url.split('#')[0]}</button><small>同一网络无法连接时，可让电脑连接手机热点后重新接收。系统询问网络访问时，允许专用网络即可。</small></div></> }</div>
      <div className="receive-summary"><span>已接收 <strong>{state.received}</strong> 项 · {state.bytes?bytes(state.bytes):'0 B'}</span><span>相同内容跳过 {state.skipped} 项</span>{state.uploading>0&&<span><LoaderCircle size={14} className="spin"/>正在接收 {state.uploading} 项</span>}</div>
      <p className="muted file-path">保存到 {state.destination} · 相册「{state.albumName}」</p>{state.lastError&&<p role="status">{state.lastError} · 请在手机页面重试未完成文件。</p>}
      <button className="button subtle" disabled={busy} onClick={()=>run(()=>window.album.stopPhoneReceive())}><Square size={13}/>停止接收</button><p className="muted">{state.expiresAt?`接收将在 ${new Date(state.expiresAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})} 自动关闭。`:''}关闭此面板后仍可接收；点击“停止接收”结束传输。</p>
    </>}
    {!!state?.files.length&&<details className="receive-files"><summary>最近接收记录</summary>{state.files.map((file,index)=><div key={index}><span>{file.name}</span><small>{file.status==='received'?'已接收':file.status==='duplicate'?'已存在':'未完成，请重试'}</small></div>)}</details>}
    <details className="receive-usb"><summary>普通数据线也可以，不用 USB 调试</summary><ol><li>数据线连接手机，解锁手机。</li><li>下拉通知，在 USB 用途中选择“文件传输”。</li><li>在 Windows 文件资源管理器里打开手机，将 DCIM、Pictures 等照片文件夹复制到电脑。</li><li>回到Luma，点“＋ → 从电脑文件夹添加”，即可自动整理为相簿。</li></ol><p className="muted">此方式通过系统文件传输窗口复制，Luma在文件到达电脑后读取。</p></details>
  </section></div>;
}
