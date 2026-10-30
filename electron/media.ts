import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import exifr from 'exifr';

const activeTemporaryFiles = new Set<string>();
/** Publish only completed derived files; redirected Windows profiles may reject rename with EXDEV. */
async function publishDerivedFile(temporary:string,target:string):Promise<void>{
  try{await fs.rename(temporary,target);}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='EXDEV')throw error;
    try{await fs.copyFile(temporary,target);}
    catch(copyError){await removeTemporary(target).catch(()=>{});throw copyError;}
    await removeTemporary(temporary);
  }
}
async function removeTemporary(file:string):Promise<void>{
  for(let attempt=0;attempt<5;attempt++){
    try{await fs.rm(file,{force:true});return;}catch(error){if(attempt===4)throw error;await delay(80*(attempt+1));}
  }
}
/** Reap abandoned derived files only after a day; never remove an active writer's output. */
export async function cleanOrphanMediaTemps(directory:string,minimumAgeMs=24*60*60*1000):Promise<void>{
  const now=Date.now();
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    if(!entry.isFile()||(!entry.name.endsWith('.tmp.webp')&&!entry.name.endsWith('.partial.mp4')))continue;
    const file=path.join(directory,entry.name);if(activeTemporaryFiles.has(file))continue;
    try{const stat=await fs.stat(file);if(now-stat.mtimeMs>=minimumAgeMs)await removeTemporary(file);}catch{}
  }
}

export const IMAGE_EXTENSIONS = new Set(['.jpg','.jpeg','.jfif','.png','.webp','.avif','.gif','.tif','.tiff','.bmp','.heic','.heif']);
/** Identify the ISO-BMFF image brands rather than trusting a phone's filename.
 * HEIF uses the ftyp box; AVIF shares mif1 but is decoded natively by sharp.
 * https://github.com/strukturag/libheif#supported-features */
export async function isHeif(file:string):Promise<boolean>{
  const handle=await fs.open(file,'r');const header=Buffer.alloc(4096);let length=0;
  try{length=(await handle.read(header,0,header.length,0)).bytesRead;}finally{await handle.close();}
  for(let offset=0;offset+8<=length;){
    let size=header.readUInt32BE(offset),boxHeader=8;
    if(size===1){if(offset+16>length)return false;const extended=header.readBigUInt64BE(offset+8);if(extended>BigInt(Number.MAX_SAFE_INTEGER))return false;size=Number(extended);boxHeader=16;}
    if(size<boxHeader)return false;
    if(header.toString('ascii',offset+4,offset+8)==='ftyp'){
      const body=offset+boxHeader,end=Math.min(offset+size,length);if(body+8>end)return false;
      const brands=[header.toString('ascii',body,body+4)];
      for(let index=body+8;index+4<=end;index+=4)brands.push(header.toString('ascii',index,index+4));
      return !brands.some(brand=>brand==='avif'||brand==='avis')&&brands.some(brand=>['heic','heix','hevc','hevx','heim','heis','hevm','hevs','mif1','msf1'].includes(brand));
    }
    offset+=size;
  }
  return false;
}
let heifRuntime:Promise<any>|null=null;
/** Official libheif-js API; bundled WebAssembly decodes HEVC when sharp's build cannot.
 * https://github.com/catdad-experiments/libheif-js#usage */
async function heifImage(file:string):Promise<sharp.Sharp> {
  const lib=await (heifRuntime??=import('libheif-js/wasm-bundle.js').then(async m=>await m.default));
  const decoder=new lib.HeifDecoder();const images=decoder.decode(await fs.readFile(file));
  if(!images.length)throw new Error('HEIC/HEIF 图片无法解码，原件已保留');
  // Some libheif-js builds expose is_primary() without its native symbol.
  const image=images.find((item:any)=>{try{return item.is_primary?.();}catch{return false;}})??images[0];
  const width=image.get_width(),height=image.get_height();
  try {
    if(width*height>64_000_000)throw new Error('HEIC/HEIF 图片尺寸过大，原件已保留');
    const pixels=await new Promise<{data:Uint8ClampedArray}>((resolve,reject)=>image.display({data:new Uint8ClampedArray(width*height*4),width,height},(value:any)=>value?resolve(value):reject(new Error('HEIC/HEIF 解码失败，原件已保留'))));
    return sharp(Buffer.from(pixels.data),{raw:{width,height,channels:4}});
  } finally {for(const item of images)item.free?.();}
}
export async function decodedImage(file:string):Promise<sharp.Sharp>{
  if(await isHeif(file))return heifImage(file);
  return sharp(file,{animated:false,failOn:'none',limitInputPixels:268402689}).rotate();
}
export async function makeAnalysisImage(file:string,target:string,maximumSize=2400):Promise<string>{
  await fs.mkdir(path.dirname(target),{recursive:true});const temp=target+'.tmp.webp';
  try{let image=await decodedImage(file);if(maximumSize>0)image=image.resize(maximumSize,maximumSize,{fit:'inside',withoutEnlargement:true});await image.webp({quality:94}).toFile(temp);await publishDerivedFile(temp,target);return target;}
  finally{await removeTemporary(temp).catch(()=>{});}
}
export const VIDEO_EXTENSIONS = new Set(['.mp4','.m4v','.mov','.mkv','.webm','.avi','.wmv','.mpeg','.mpg','.3gp','.mts','.m2ts']);
export const kindOf = (file: string): 'image'|'video'|null => {
  const ext=path.extname(file).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext)?'image':VIDEO_EXTENSIONS.has(ext)?'video':null;
};
export interface Probe { width:number; height:number; duration:number|null; takenAt:number|null }
function timestamp(value:unknown):number|null{
  const result=value instanceof Date?value.getTime():typeof value==='string'?Date.parse(value):NaN;
  return Number.isFinite(result)&&result>0?result:null;
}
async function imageTakenAt(file:string):Promise<number|null>{
  try{
    // Restrict parsing to capture dates. https://github.com/MikeKovarik/exifr#usage
    const metadata=await exifr.parse(file,['DateTimeOriginal','CreateDate']);
    return timestamp(metadata?.DateTimeOriginal)??timestamp(metadata?.CreateDate);
  }catch{return null;}
}
export interface Binaries { ffmpeg:string; ffprobe:string }
export function execute(binary:string,args:string[], options:{timeout?:number;signal?:AbortSignal;onStderr?:(text:string)=>void;onStdout?:(text:string)=>void;onProcess?:(process:ChildProcess)=>void}={}):Promise<string> {
  return new Promise((resolve,reject)=> {
    if(options.signal?.aborted) { reject(new Error('任务已取消')); return; }
    const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    options.onProcess?.(child);
    let output='',error='',settled=false,stopReason:Error|undefined;
    let stopDeadline:ReturnType<typeof setTimeout>|undefined;
    const stop=(reason:Error)=>{
      if(settled||stopReason)return;stopReason=reason;
      try{child.kill();}catch{}
      // Normally close fires immediately after termination. Keep a bounded escape for a broken
      // process/pipe, while the aged orphan reaper handles any delayed Windows file release.
      stopDeadline=setTimeout(()=>finish(stopReason),5000);
    };
    const abort=()=>stop(new Error('任务已取消'));
    options.signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>stop(new Error('媒体处理超时')),options.timeout??45000);
    const finish=(err?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);if(stopDeadline)clearTimeout(stopDeadline);options.signal?.removeEventListener('abort',abort);err?reject(err):resolve(output);};
    child.stdout?.on('data',chunk=>{const text=String(chunk);output=(output+text).slice(-2_000_000);options.onStdout?.(text);});
    child.stderr?.on('data',chunk=>{const text=String(chunk);error=(error+text).slice(-3000);options.onStderr?.(text);});
    child.once('error',err=>{if(!stopReason)finish(err);});
    child.once('close',code=>finish(stopReason??(options.signal?.aborted?new Error('任务已取消'):code===0?undefined:new Error(error.trim()||`媒体工具退出 (${code})`))));
  });
}
export async function probeMedia(file:string,kind:'image'|'video',binaries:Binaries,signal?:AbortSignal):Promise<Probe> {
  if(kind==='image') {
    try {
      const meta=await (await isHeif(file)?await heifImage(file):sharp(file,{animated:false,failOn:'none',limitInputPixels:268402689})).metadata();
      const swap=(meta.orientation??0)>=5;
      return {width:(swap?meta.height:meta.width)??1,height:(swap?meta.width:meta.height)??1,duration:null,takenAt:await imageTakenAt(file)};
    } catch(error) {
      if(path.extname(file).toLowerCase()!=='.bmp') throw error;
    }
  }
  const output=await execute(binaries.ffprobe,['-v','error','-show_streams','-show_format','-of','json',file],{signal,timeout:30000});
  const info=JSON.parse(output);
  const stream=info.streams?.find((item:any)=>item.codec_type==='video');
  if(!stream?.width||!stream?.height) throw new Error('无法读取画面尺寸');
  const rotation=Number(stream.tags?.rotate??stream.side_data_list?.find((item:any)=>item.rotation!==undefined)?.rotation??0);
  const swap=Math.abs(rotation)%180===90;
  const duration=Number(info.format?.duration??stream.duration);
  return {width:swap?stream.height:stream.width,height:swap?stream.width:stream.height,duration:kind==='video'&&Number.isFinite(duration)?duration:null,takenAt:timestamp(stream.tags?.creation_time)??timestamp(info.format?.tags?.creation_time)};
}
export async function makeThumbnail(file:string,kind:'image'|'video',target:string,size:number,binaries:Binaries,duration:number|null,signal?:AbortSignal):Promise<void> {
  await fs.mkdir(path.dirname(target),{recursive:true});
  const temp=target+'.tmp.webp';
  activeTemporaryFiles.add(temp);
  try {
    if(kind==='image'&&path.extname(file).toLowerCase()!=='.bmp') {
      await (await decodedImage(file)).resize(size,size,{fit:'inside',withoutEnlargement:true}).webp({quality:82}).toFile(temp);
    } else {
      const seek=kind==='video'?Math.min(3,Math.max(0,(duration??0)*.1)):0;
      await execute(binaries.ffmpeg,['-hide_banner','-loglevel','error','-y',...(seek?['-ss',String(seek)]:[]),'-i',file,'-frames:v','1','-vf',`scale=${size}:${size}:force_original_aspect_ratio=decrease`,'-c:v','libwebp','-quality','82',temp],{signal,timeout:45000});
    }
    if(signal?.aborted)throw new Error('任务已取消');
    await publishDerivedFile(temp,target);
  } finally {await removeTemporary(temp).catch(()=>{});activeTemporaryFiles.delete(temp);}
}
export async function makeVideoProxy(file:string,target:string,binaries:Binaries,duration:number|null,signal:AbortSignal,progress:(seconds:number)=>void):Promise<void> {
  await fs.mkdir(path.dirname(target),{recursive:true});
  const temp=target+'.partial.mp4';
  activeTemporaryFiles.add(temp);
  let pending='';
  try {
    await execute(binaries.ffmpeg,['-hide_banner','-loglevel','error','-y','-i',file,'-map','0:v:0','-map','0:a:0?','-vf',"scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",'-c:v','libx264','-preset','veryfast','-crf','24','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart','-progress','pipe:1','-nostats',temp],{signal,timeout:Math.max(1800000,(duration??0)*10000),onStdout:text=>{pending+=text;const lines=pending.split('\n');pending=lines.pop()??'';for(const line of lines){const m=/^out_time_us=(\d+)/.exec(line);if(m)progress(Number(m[1])/1e6);}}});
    await publishDerivedFile(temp,target);
  } finally {await removeTemporary(temp).catch(()=>{});activeTemporaryFiles.delete(temp);}
}
export function mimeFor(file:string):string {
  const ext=path.extname(file).toLowerCase();
  return ({'.jpg':'image/jpeg','.jpeg':'image/jpeg','.jfif':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.avif':'image/avif','.bmp':'image/bmp','.tif':'image/tiff','.tiff':'image/tiff','.mp4':'video/mp4','.m4v':'video/mp4','.mov':'video/quicktime','.mkv':'video/x-matroska','.webm':'video/webm','.avi':'video/x-msvideo'} as Record<string,string>)[ext]??'application/octet-stream';
}
