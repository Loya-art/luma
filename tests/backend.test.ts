import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { Library, pathKey } from '../electron/library';
import { parseRange } from '../electron/range';
import { cleanOrphanMediaTemps, execute, isHeif, makeAnalysisImage } from '../electron/media';

// Avoid libvips retaining test-file handles during Windows temp-directory cleanup.
sharp.cache(false);

test('byte ranges support regular, suffix and open-ended requests and reject unsafe ranges',()=>{
  assert.equal(parseRange(null,100),null);
  assert.deepEqual(parseRange('bytes=5-19',100),{start:5,end:19});
  assert.deepEqual(parseRange('bytes=90-',100),{start:90,end:99});
  assert.deepEqual(parseRange('bytes=-20',100),{start:80,end:99});
  assert.deepEqual(parseRange('bytes=0-999',100),{start:0,end:99});
  for(const input of ['bytes=100-','bytes=8-2','bytes=-0','bytes=1-2,4-5','bytes=9007199254740992-','items=0-2','bytes=-'])assert.equal(parseRange(input,100),'invalid',input);
  assert.equal(parseRange('bytes=0-',0),'invalid');
});

test('canonical source root keeps its directory separator',()=>{
  const root=path.parse(process.cwd()).root;
  assert.equal(pathKey(root),process.platform==='win32'?root.toLowerCase():root);
});

test('redirected profile EXDEV still imports complete thumbnails without changing source images',async context=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-redirected-'));
  const source=path.join(workspace,'photos'),data=path.join(workspace,'profile');await fs.mkdir(source);
  const file=path.join(source,'image.png');await sharp({create:{width:200,height:120,channels:4,background:'#72958baa'}}).png().toFile(file);
  const original=await fs.readFile(file),rename=fs.rename.bind(fs);let redirectedPublications=0;
  context.mock.method(fs,'rename',async(from:Parameters<typeof fs.rename>[0],to:Parameters<typeof fs.rename>[1])=>{
    if(String(from).endsWith('.tmp.webp')){redirectedPublications++;throw Object.assign(new Error('cross-device link not permitted'),{code:'EXDEV'});}
    return rename(from,to);
  });
  const library=new Library({dataDir:data,binaries:{ffmpeg:'ffmpeg',ffprobe:'ffprobe'},watch:false});
  try{
    await library.addSources([source]);await library.waitForIdle();const snapshot=library.getSnapshot();
    assert.equal(snapshot.media.length,1);assert.equal(snapshot.errors.length,0);
    for(const variant of ['thumbnail','preview'] as const){const result=await library.resolveMedia(snapshot.media[0].id,variant);assert.equal(path.basename(path.dirname(result.path)),'MediaCache');const metadata=await sharp(result.path).metadata();assert.equal(metadata.width,200);assert.equal(metadata.height,120);}
    assert.equal(redirectedPublications,2);assert.deepEqual(await fs.readFile(file),original);
    assert.equal((await fs.readdir(path.join(data,'MediaCache'))).some(name=>name.endsWith('.tmp.webp')),false);
  }finally{await library.close();context.mock.restoreAll();await fs.rm(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('failed cross-volume copy removes partial cache and a rescan can recover',async context=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-copy-retry-'));
  const source=path.join(workspace,'photos'),data=path.join(workspace,'profile');await fs.mkdir(source);
  const file=path.join(source,'image.png');await sharp({create:{width:80,height:60,channels:3,background:'#597768'}}).png().toFile(file);
  const original=await fs.readFile(file),rename=fs.rename.bind(fs),copy=fs.copyFile.bind(fs);let rejectCopy=true;
  context.mock.method(fs,'rename',async(from:Parameters<typeof fs.rename>[0],to:Parameters<typeof fs.rename>[1])=>{
    if(String(from).endsWith('.tmp.webp'))throw Object.assign(new Error('cross-device link not permitted'),{code:'EXDEV'});
    return rename(from,to);
  });
  context.mock.method(fs,'copyFile',async(from:Parameters<typeof fs.copyFile>[0],to:Parameters<typeof fs.copyFile>[1],mode?:number)=>{
    if(rejectCopy){await fs.writeFile(to,'partial');throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}
    return copy(from,to,mode);
  });
  const library=new Library({dataDir:data,binaries:{ffmpeg:'ffmpeg',ffprobe:'ffprobe'},watch:false});
  try{
    await library.addSources([source]);await library.waitForIdle();let snapshot=library.getSnapshot();
    assert.equal(snapshot.media.length,0);assert.equal(snapshot.jobs[0].status,'error');assert.match(snapshot.jobs[0].error!,/1 项素材无法读取/);
    assert.deepEqual(await fs.readdir(path.join(data,'MediaCache')),[]);
    rejectCopy=false;library.rescan();await library.waitForIdle();snapshot=library.getSnapshot();
    assert.equal(snapshot.media.length,1);const thumbnail=await library.resolveMedia(snapshot.media[0].id,'thumbnail');assert.equal((await sharp(thumbnail.path).metadata()).width,80);
    assert.deepEqual(await fs.readFile(file),original);
  }finally{await library.close();context.mock.restoreAll();await fs.rm(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('timed-out media child closes before rejection and aged orphan cleanup preserves fresh files',async()=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-timeout-'));
  let childClosed=false,started=false;
  try{
    const partial=path.join(workspace,'child.partial.mp4');
    const script="const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'w');fs.writeSync(fd,'partial');process.stdout.write('ready');setInterval(()=>{},1000)";
    await assert.rejects(execute(process.execPath,['-e',script,partial],{timeout:350,onStdout:text=>{if(text.includes('ready'))started=true;},onProcess:child=>child.once('close',()=>{childClosed=true;})}),/媒体处理超时/);
    assert.equal(started,true);assert.equal(childClosed,true);
    await fs.rm(partial);assert.equal(await fs.stat(partial).then(()=>true,()=>false),false);
    const old=path.join(workspace,'orphan.partial.mp4'),fresh=path.join(workspace,'fresh.tmp.webp'),regular=path.join(workspace,'kept.webp');
    await Promise.all([fs.writeFile(old,'old'),fs.writeFile(fresh,'fresh'),fs.writeFile(regular,'image')]);
    const yesterday=new Date(Date.now()-48*60*60*1000);await fs.utimes(old,yesterday,yesterday);await fs.utimes(regular,yesterday,yesterday);
    await cleanOrphanMediaTemps(workspace);
    assert.equal(await fs.stat(old).then(()=>true,()=>false),false);assert.equal(await fs.readFile(fresh,'utf8'),'fresh');assert.equal(await fs.readFile(regular,'utf8'),'image');
  }finally{await fs.rm(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('reference import, overlap ownership, metadata, missing files and exclusions survive restart',async()=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-backend-'));
  const source=path.join(workspace,'中文 素材');const child=path.join(source,'子目录');const data=path.join(workspace,'data');
  await fs.mkdir(child,{recursive:true});
  const first=path.join(source,'横图.jpg'),second=path.join(child,'透明图.png');
  await sharp({create:{width:320,height:180,channels:3,background:'#9f744c'}}).jpeg().toFile(first);
  await sharp({create:{width:120,height:240,channels:4,background:{r:20,g:180,b:200,alpha:.4}}}).png().toFile(second);
  await fs.writeFile(path.join(source,'损坏.jpg'),'not an image');
  const before=createHash('sha256').update(await fs.readFile(first)).digest('hex');
  let library=new Library({dataDir:data,binaries:{ffmpeg:'ffmpeg',ffprobe:'ffprobe'},watch:false});
  try{
    await library.addSources([source]);await library.waitForIdle();
    let snapshot=library.getSnapshot();assert.equal(snapshot.media.length,2);assert.equal(snapshot.errors.length,1);
    const original=snapshot.media.find(item=>item.path===first)!;const nested=snapshot.media.find(item=>item.path===second)!;
    assert.equal(original.width,320);assert.equal(original.height,180);assert.match(original.thumbnailUrl,/^app-media:\/\/asset\//);
    const thumbnail=await library.resolveMedia(nested.id,'thumbnail');assert.equal((await sharp(thumbnail.path).metadata()).hasAlpha,true);
    const album=library.createAlbum('旅行');library.updateMedia([nested.id],{favorite:true,addTags:['山海','山海'],addAlbumIds:[album.id]});
    library.setSettings({view:'grid',fit:'contain',camera:{x:88,y:99,scale:1.3}});
    await library.addSources([source,child]);await library.waitForIdle();snapshot=library.getSnapshot();assert.equal(snapshot.media.length,2);assert.equal(snapshot.sources.length,2);
    const parentSource=snapshot.sources.find(item=>item.path===source)!;
    await library.removeSource(parentSource.id);await library.waitForIdle();snapshot=library.getSnapshot();
    assert.equal(snapshot.media.length,1);assert.equal(snapshot.media[0].id,nested.id);assert.equal(snapshot.media[0].favorite,true);assert.deepEqual(snapshot.media[0].tags,['山海']);assert.deepEqual(snapshot.media[0].albumIds,[album.id]);
    await fs.rename(second,second+'.offline');library.rescan();await library.waitForIdle();assert.equal(library.getSnapshot().media[0].missing,true);
    await fs.rename(second+'.offline',second);library.rescan();await library.waitForIdle();assert.equal(library.getSnapshot().media[0].missing,false);
    await library.close();
    library=new Library({dataDir:data,binaries:{ffmpeg:'ffmpeg',ffprobe:'ffprobe'},watch:false});snapshot=library.getSnapshot();assert.equal(snapshot.media[0].id,nested.id);assert.equal(snapshot.settings.view,'grid');assert.equal(snapshot.settings.camera.x,88);assert.deepEqual(snapshot.media[0].tags,['山海']);
    library.removeMedia([nested.id]);library.rescan();await library.waitForIdle();assert.equal(library.getSnapshot().media.length,0);assert.equal(await fs.readFile(second).then(()=>true),true);
    assert.equal(createHash('sha256').update(await fs.readFile(first)).digest('hex'),before);
  }finally{await library.close();await fs.rm(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('offline source preserves indexed media and relinking preserves identity and tags',async()=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-offline-'));
  const original=path.join(workspace,'disk');const relocated=path.join(workspace,'returned disk');await fs.mkdir(original);
  await sharp({create:{width:80,height:100,channels:3,background:'red'}}).png().toFile(path.join(original,'image.png'));
  const library=new Library({dataDir:path.join(workspace,'data'),binaries:{ffmpeg:'ffmpeg',ffprobe:'ffprobe'},watch:false});
  try{
    await library.addSources([original]);await library.waitForIdle();const snapshot=library.getSnapshot(),item=snapshot.media[0],source=snapshot.sources[0];library.updateMedia([item.id],{addTags:['保留分类']});
    await fs.rename(original,relocated);library.rescan();await library.waitForIdle();let offline=library.getSnapshot();assert.equal(offline.sources[0].status,'offline');assert.equal(offline.media[0].missing,true);assert.deepEqual(offline.media[0].tags,['保留分类']);
    await library.relinkSource(source.id,relocated);await library.waitForIdle();const online=library.getSnapshot();assert.equal(online.media[0].id,item.id);assert.equal(online.media[0].missing,false);assert.deepEqual(online.media[0].tags,['保留分类']);assert.equal(online.media[0].path,path.join(relocated,'image.png'));
  }finally{await library.close();await fs.rm(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('bulk operations update all 30,017 selected media and incomplete camera input is ignored',async()=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-bulk-'));
  const data=path.join(workspace,'data');
  const library=new Library({dataDir:data,binaries:{ffmpeg:'ffmpeg',ffprobe:'ffprobe'},watch:false});
  try{
    // Seed indexed metadata to exercise bulk mutation independently of media decoding speed.
    const seed=new DatabaseSync(path.join(data,'library.sqlite'));
    seed.exec('PRAGMA foreign_keys=ON;BEGIN');
    seed.prepare('INSERT INTO sources(id,path,path_key,name) VALUES(?,?,?,?)').run('bulk-source',workspace,pathKey(workspace),'批量测试');
    const insert=seed.prepare('INSERT INTO media(id,source_id,path,path_key,file_name,kind,width,height,duration,size,mtime_ms,added_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    const ids=Array.from({length:30017},(_,index)=>`bulk-${index}`);
    for(const id of ids){const file=path.join(workspace,`${id}.jpg`);insert.run(id,'bulk-source',file,pathKey(file),`${id}.jpg`,'image',120,80,null,1000,1000,1000);}
    seed.exec('COMMIT');seed.close();
    const camera={...library.getSnapshot().settings.camera};
    library.setSettings({camera:{x:123} as any});
    assert.deepEqual(library.getSnapshot().settings.camera,camera);
    const album=library.createAlbum('全部素材');
    library.updateMedia(ids,{favorite:true,addTags:['批量'],addAlbumIds:[album.id]});
    const snapshot=library.getSnapshot();
    assert.equal(snapshot.media.length,ids.length);
    assert.equal(snapshot.media.filter(item=>item.favorite&&item.tags.includes('批量')&&item.albumIds.includes(album.id)).length,ids.length);
    assert.equal(snapshot.media.find(item=>item.id==='bulk-30016')?.favorite,true);
    library.removeMedia(ids);
    assert.equal(library.getSnapshot().media.length,0);
  }finally{await library.close();await fs.rm(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('schema v1 migrates without losing classifications, capture dates and explicit-open statistics persist',async()=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-migrate-'));
  const source=path.join(workspace,'photos'),data=path.join(workspace,'data');await fs.mkdir(source);await fs.mkdir(data);
  const file=path.join(source,'EXIF拍摄日期.jpg');
  await sharp({create:{width:200,height:120,channels:3,background:'#4a6977'}}).withExif({IFD2:{DateTimeOriginal:'2024:07:03 12:13:14'}}).jpeg().toFile(file);
  const stat=await fs.stat(file);
  const seed=new DatabaseSync(path.join(data,'library.sqlite'));
  seed.exec(`CREATE TABLE sources(id TEXT PRIMARY KEY,path TEXT NOT NULL,path_key TEXT UNIQUE NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'online');
    CREATE TABLE media(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,path TEXT NOT NULL,path_key TEXT UNIQUE NOT NULL,file_name TEXT NOT NULL,kind TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,duration REAL,size INTEGER NOT NULL,mtime_ms REAL NOT NULL,added_at REAL NOT NULL,favorite INTEGER NOT NULL DEFAULT 0,missing INTEGER NOT NULL DEFAULT 0,excluded INTEGER NOT NULL DEFAULT 0,tags TEXT NOT NULL DEFAULT '[]',albums TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE albums(id TEXT PRIMARY KEY,name TEXT NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);PRAGMA user_version=1;`);
  seed.prepare('INSERT INTO sources(id,path,path_key,name) VALUES(?,?,?,?)').run('old-source',source,pathKey(source),'既有图库');
  seed.prepare('INSERT INTO albums(id,name) VALUES(?,?)').run('old-album','旧相册');
  seed.prepare('INSERT INTO media(id,source_id,path,path_key,file_name,kind,width,height,size,mtime_ms,added_at,favorite,tags,albums) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('old-item','old-source',file,pathKey(file),path.basename(file),'image',200,120,stat.size,stat.mtimeMs,1234,1,'["保留标签"]','["old-album"]');
  seed.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('preferences',JSON.stringify({view:'grid',fit:'contain'}));seed.close();
  let library=new Library({dataDir:data,binaries:{ffmpeg:'ffmpeg',ffprobe:'ffprobe'},watch:false});
  try{
    let snapshot=library.getSnapshot();assert.equal(snapshot.media.length,1);assert.equal(snapshot.media[0].id,'old-item');assert.equal(snapshot.media[0].openCount,0);assert.equal(snapshot.media[0].lastOpenedAt,null);assert.equal(snapshot.media[0].takenAt,null);assert.deepEqual(snapshot.media[0].tags,['保留标签']);assert.deepEqual(snapshot.media[0].albumIds,['old-album']);assert.equal(snapshot.media[0].favorite,true);
    assert.equal(snapshot.settings.view,'grid');assert.equal(snapshot.settings.sizingMode,'balanced');assert.equal(snapshot.settings.focusTint,true);assert.equal(snapshot.settings.lighting,'light');
    library.rescan();await library.waitForIdle();snapshot=library.getSnapshot();
    assert.ok(snapshot.media[0].takenAt);const captured=new Date(snapshot.media[0].takenAt!);assert.equal(captured.getFullYear(),2024);assert.equal(captured.getMonth(),6);assert.equal(captured.getDate(),3);
    await library.resolveMedia('old-item','thumbnail');assert.equal(library.getSnapshot().media[0].openCount,0);
    const beforeOpen=Date.now();library.recordOpen('old-item');library.recordOpen('old-item');snapshot=library.getSnapshot();assert.equal(snapshot.media[0].openCount,2);assert.ok(snapshot.media[0].lastOpenedAt!>=beforeOpen);
    library.setSettings({sizingMode:'views',focusTint:false,lighting:'dim'});library.setSettings({sizingMode:'invalid',lighting:'invalid'} as any);
    await library.close();library=new Library({dataDir:data,binaries:{ffmpeg:'ffmpeg',ffprobe:'ffprobe'},watch:false});snapshot=library.getSnapshot();assert.equal(snapshot.media[0].openCount,2);assert.ok(snapshot.media[0].lastOpenedAt);assert.equal(snapshot.settings.sizingMode,'views');assert.equal(snapshot.settings.focusTint,false);assert.equal(snapshot.settings.lighting,'dim');assert.deepEqual(snapshot.media[0].tags,['保留标签']);
    const inspect=new DatabaseSync(path.join(data,'library.sqlite'));try{assert.equal((inspect.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,3);}finally{inspect.close();}assert.ok((await fs.readdir(path.join(data,'Backups'))).some(name=>name.startsWith('library-before-1.1.0-')));
  }finally{await library.close();await fs.rm(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('HEIC original stays byte-identical while thumbnail and full-resolution display decode',async()=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-heic-')),source=path.join(workspace,'手机照片');await fs.mkdir(source);const file=path.join(source,'中文原片.heic');await fs.copyFile(path.resolve('tests/.fixtures/compat/example.heic'),file);
  const hash=async()=>createHash('sha256').update(await fs.readFile(file)).digest('hex');const before=await hash();assert.equal(before,'7f8b363e4936c0666a25f64f3a92fda10bd8e5453be4592530b65a55dd98f3f2');
  const library=new Library({dataDir:path.join(workspace,'profile'),binaries:{ffmpeg:'ffmpeg',ffprobe:'ffprobe'},watch:false});
  try{await library.addSources([source]);await library.waitForIdle();const snapshot=library.getSnapshot();assert.equal(snapshot.errors.length,0);assert.equal(snapshot.media.length,1);const item=snapshot.media[0];assert.equal(item.width,1280);assert.equal(item.height,854);
    const thumb=await library.resolveMedia(item.id,'thumbnail'),preview=await library.resolveMedia(item.id,'preview'),original=await library.resolveMedia(item.id,'original');assert.equal((await sharp(thumb.path).metadata()).width,384);assert.equal((await sharp(preview.path).metadata()).width,1280);const decoded=await sharp(original.path).metadata();assert.equal(decoded.width,1280);assert.equal(decoded.height,854);assert.equal(original.mime,'image/webp');assert.equal(await hash(),before);
  }finally{await library.close();await fs.rm(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('HEIF bytes named PNG or JPEG decode across previews, analysis and original display without changing originals',async()=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-misnamed-heif-')),source=path.join(workspace,'手机图片');await fs.mkdir(source);
  const files=['手机原图.png','错误扩展名.jpg'].map(name=>path.join(source,name));
  for(const file of files)await fs.copyFile(path.resolve('tests/.fixtures/compat/example.heic'),file);
  const png=path.join(source,'实际PNG.png'),avif=path.join(source,'实际AVIF.avif'),jpeg=path.join(source,'实际JPEG.heic');
  for(const [file,format]of [[png,'png'],[avif,'avif'],[jpeg,'jpeg']]as const)await sharp({create:{width:96,height:64,channels:3,background:'#888'}}).toFormat(format).toFile(file);
  for(const file of files)assert.equal(await isHeif(file),true);
  for(const file of [png,avif,jpeg])assert.equal(await isHeif(file),false);
  const hash=async(file:string)=>createHash('sha256').update(await fs.readFile(file)).digest('hex');const hashes=await Promise.all(files.map(hash));
  const library=new Library({dataDir:path.join(workspace,'profile'),binaries:{ffmpeg:'ffmpeg',ffprobe:'ffprobe'},watch:false});
  try{
    await library.addSources([source]);await library.waitForIdle();const snapshot=library.getSnapshot();assert.equal(snapshot.errors.length,0);assert.equal(snapshot.media.length,5);
    for(const [index,file]of files.entries()){
      const item=snapshot.media.find(item=>item.path===file)!;assert.equal(item.width,1280);assert.equal(item.height,854);
      for(const variant of ['thumbnail','preview','original']as const){const result=await library.resolveMedia(item.id,variant);const metadata=await sharp(result.path).metadata();assert.equal(metadata.width,variant==='thumbnail'?384:1280);if(variant==='original')assert.equal(result.mime,'image/webp');}
      const analysis=await makeAnalysisImage(file,path.join(workspace,`analysis-${index}.webp`));assert.equal((await sharp(analysis).metadata()).width,1280);assert.equal(await hash(file),hashes[index]);
    }
  }finally{await library.close();await fs.rm(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('trash commits only successful originals and restoring the same file preserves identity and classifications',async()=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-trash-')),source=path.join(workspace,'照片'),moved=path.join(workspace,'simulated-recycle');await fs.mkdir(source);await fs.mkdir(moved);const first=path.join(source,'删除.png'),second=path.join(source,'无法删除.png');for(const file of [first,second])await sharp({create:{width:90,height:80,channels:3,background:'#8dada8'}}).png().toFile(file);
  const library=new Library({dataDir:path.join(workspace,'profile'),binaries:{ffmpeg:'ffmpeg',ffprobe:'ffprobe'},watch:false});
  try{await library.addSources([source]);await library.waitForIdle();const snapshot=library.getSnapshot(),item=snapshot.media.find(row=>row.path===first)!,other=snapshot.media.find(row=>row.path===second)!;const album=library.createAlbum('保留');library.updateMedia([item.id],{favorite:true,addTags:['手动分类'],addAlbumIds:[album.id]});
    const candidates=await library.beginTrash([item.id,other.id]);assert.equal(candidates.length,2);await fs.rename(first,path.join(moved,'删除.png'));library.finishTrash([item.id]);await library.waitForIdle();assert.deepEqual(library.getSnapshot().media.map(row=>row.id),[other.id]);assert.equal(await fs.stat(second).then(()=>true),true);
    await fs.rename(path.join(moved,'删除.png'),first);library.rescan();await library.waitForIdle();const restored=library.getSnapshot().media.find(row=>row.id===item.id)!;assert.ok(restored);assert.equal(restored.missing,false);assert.equal(restored.favorite,true);assert.deepEqual(restored.tags,['手动分类']);assert.deepEqual(restored.albumIds,[album.id]);await library.beginTrash([other.id]);library.finishTrash([]);await library.waitForIdle();assert.equal(library.getSnapshot().media.length,2);
  }finally{await library.close();await fs.rm(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
