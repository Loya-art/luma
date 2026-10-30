import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PhoneReceiver } from '../electron/receive';

const original=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cGikAAAAASUVORK5CYII=','base64');
const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
async function fixture(options:{sessionMs?:number;maxFileBytes?:number}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-receive-')),destination=path.join(root,'照片');
  const db=new DatabaseSync(path.join(root,'library.sqlite'));let notifications=0;
  const service=new PhoneReceiver({db,bindAddress:'127.0.0.1',onImported:async()=>{notifications++;},...options});
  const start=async(albumName='手机原片')=>{const state=await service.start({destination,albumName});const address=new URL(state.addresses[0].url);return{url:address.origin,token:address.hash.slice(1),state};};
  return{root,destination,db,service,start,notifications:()=>notifications,cleanup:async()=>{await service.close();db.close();await fs.rm(root,{recursive:true,force:true});}};
}
const upload=(url:string,token:string,name:string,body=original,headers:Record<string,string>={})=>fetch(url+'/upload',{method:'POST',headers:{'X-Receive-Token':token,'X-File-Name':encodeURIComponent(name),'X-File-Modified':'1700000000123',...headers},body});

test('wireless original bytes, Unicode, timestamp, persistent dedup and album associations',async()=>{
  const f=await fixture();try{
    const first=await f.start();assert.match(first.state.addresses[0].qrCode,/^data:image\/png;base64,/);
    const response=await upload(first.url,first.token,'北京/海边合照.png');assert.equal(response.status,200);assert.deepEqual(await response.json(),{duplicate:false});
    const target=path.join(f.destination,'手机原片','北京','海边合照.png');assert.equal(sha(await fs.readFile(target)),sha(original));assert.ok(Math.abs((await fs.stat(target)).mtimeMs-1700000000123)<10);
    await f.service.stop();const second=await f.start('第二个相册');const duplicate=await upload(second.url,second.token,'另一个名字.png');assert.equal(duplicate.status,200);assert.deepEqual(await duplicate.json(),{duplicate:true});
    assert.equal(f.service.getState().skipped,1);assert.equal(f.db.prepare('SELECT COUNT(*) count FROM receive_files').get()!.count,1);assert.equal(f.service.getAliases().length,2);assert.equal(f.notifications(),2);
  }finally{await f.cleanup();}
});

test('wireless reuses verified ADB copy only inside selected destination',async()=>{
  const f=await fixture();try{
    await fs.mkdir(f.destination,{recursive:true});const previous=path.join(f.destination,'已有原片.png');await fs.writeFile(previous,original);
    f.db.exec('CREATE TABLE phone_manifest(sha256 TEXT,local_path TEXT,size INTEGER)');f.db.prepare('INSERT INTO phone_manifest VALUES(?,?,?)').run(sha(original),previous,original.length);
    const session=await f.start();const response=await upload(session.url,session.token,'手机.png');assert.deepEqual(await response.json(),{duplicate:true});assert.equal(f.service.getAliases()[0].localPath,previous);assert.equal(f.service.getState().received,0);
  }finally{await f.cleanup();}
});

test('wireless rejects unauthorized, foreign origin/host, unknown formats and traversal',async()=>{
  const f=await fixture({maxFileBytes:100});try{
    const session=await f.start();assert.equal((await fetch(session.url+'/status')).status,403);
    assert.equal((await upload(session.url,session.token,'照片.png',original,{Origin:'http://other.invalid'})).status,403);
    const invalidHost=await new Promise<number>(resolve=>{const req=http.request(session.url+'/status',{headers:{Host:'other.invalid','X-Receive-Token':session.token}},res=>{res.resume();resolve(res.statusCode!);});req.end();});assert.equal(invalidHost,403);
    for(const file of ['../outside.png','北京/../../outside.png','C:\\outside.png','测试.exe'])assert.equal((await upload(session.url,session.token,file)).status,400);
    assert.equal((await upload(session.url,session.token,'过大.png',Buffer.alloc(101))).status,413);
    assert.equal(f.service.getState().received,0);await assert.rejects(fs.stat(path.join(f.root,'outside.png')));
  }finally{await f.cleanup();}
});

test('wireless aborted upload removes partial file and leaves originals untouched',async()=>{
  const f=await fixture();try{
    const session=await f.start();
    await new Promise<void>(resolve=>{const req=http.request(session.url+'/upload',{method:'POST',headers:{'X-Receive-Token':session.token,'X-File-Name':encodeURIComponent('中断.png'),'Content-Length':'4096'}});req.on('error',()=>resolve());req.write(original);setTimeout(()=>req.destroy(),100);});
    const deadline=Date.now()+3000;while(f.service.getState().uploading&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(f.service.getState().received,0);assert.equal(f.service.getState().uploading,0);assert.equal(f.service.getState().failed,1);
    assert.deepEqual(await fs.readdir(path.join(f.destination,'.shiguang-staging','wireless')),[]);
    await assert.rejects(fs.stat(path.join(f.destination,'手机原片','中断.png')));
    assert.equal((await upload(session.url,session.token,'中断.png')).status,200);
  }finally{await f.cleanup();}
});

test('wireless never follows a destination directory link',async()=>{
  const f=await fixture();try{
    const session=await f.start();const outside=path.join(f.root,'其他目录');await fs.mkdir(outside);await fs.symlink(outside,path.join(f.destination,'手机原片','链接'),process.platform==='win32'?'junction':'dir');
    assert.equal((await upload(session.url,session.token,'链接/照片.png')).status,400);assert.deepEqual(await fs.readdir(outside),[]);
  }finally{await f.cleanup();}
});

test('wireless session expires and explicit stop closes listener',async()=>{
  const f=await fixture({sessionMs:350});try{
    const session=await f.start();assert.equal((await fetch(session.url+'/status',{headers:{'X-Receive-Token':session.token}})).status,200);
    await new Promise(resolve=>setTimeout(resolve,500));assert.equal(f.service.getState().active,false);await assert.rejects(fetch(session.url+'/status'));
    const next=await f.start();await f.service.stop();assert.equal(f.service.getState().active,false);await assert.rejects(fetch(next.url+'/status'));
  }finally{await f.cleanup();}
});

test('wireless start removes orphan receiver partials but keeps unrelated files and links',async()=>{
  const f=await fixture();try{
    const staging=path.join(f.destination,'.shiguang-staging','wireless');await fs.mkdir(staging,{recursive:true});
    const orphan=path.join(staging,'4992a4fd-41e6-45db-b14f-cd7b7c18eb45.partial'),unrelated=path.join(staging,'用户文件.partial'),folder=path.join(staging,'7523cce0-ecac-468e-8374-3e438b43a5f5.partial');
    await fs.writeFile(orphan,original);await fs.writeFile(unrelated,original);await fs.mkdir(folder);
    const link=path.join(staging,'2288796b-afdf-4a47-a180-6dfb89f6a976.partial');await fs.symlink(folder,link,process.platform==='win32'?'junction':'dir');
    await f.start();await assert.rejects(fs.stat(orphan));assert.deepEqual(await fs.readFile(unrelated),original);assert.equal((await fs.stat(folder)).isDirectory(),true);assert.equal((await fs.lstat(link)).isSymbolicLink(),true);
  }finally{await f.cleanup();}
});
