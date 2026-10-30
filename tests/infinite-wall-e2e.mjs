import { _electron } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const cwd=process.cwd(),root=path.join(cwd,'tests','.runtime',`infinite-${Date.now()}`),out=path.join(cwd,'docs','acceptance');
const prefix=process.env.SHIGUANG_REPORT_PREFIX||'';
const mediaDir=path.join(root,'三张照片'),dataDir=path.join(root,'library');
await fs.mkdir(mediaDir,{recursive:true});await fs.mkdir(out,{recursive:true});
for(const name of ['构成-06.webp','构成-07.jpg','构成-08.png'])await fs.copyFile(path.join(cwd,'tests','.fixtures','混合尺寸素材',name),path.join(mediaDir,name));
let app,page;const report={checks:[],errors:[],started:new Date().toISOString()};
const check=(name,details=true)=>{report.checks.push({name,details});console.log('PASS',name,JSON.stringify(details));};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await pause(50);}throw new Error(`Timed out: ${label}`);}
const instance=id=>page.locator(`[data-instance-id="${id}"]`);
const snapshot=()=>page.evaluate(()=>window.album.getSnapshot());
const camera=()=>page.getByTestId('gallery-world').evaluate(el=>{const matrix=new DOMMatrix(getComputedStyle(el).transform);return{x:matrix.e,y:matrix.f,scale:matrix.a,animated:el.classList.contains('camera-animating')};});
const tiles=()=>page.getByTestId('media-tile').evaluateAll(els=>els.map(el=>{const b=el.getBoundingClientRect();return{id:el.getAttribute('data-instance-id'),mediaId:el.getAttribute('data-media-id'),focused:el.classList.contains('focused'),selected:el.classList.contains('selected'),x:b.x,y:b.y,width:b.width,height:b.height};}));
async function settled(){await until(async()=>!(await camera()).animated,'camera settles');await pause(70);}
async function coverage(){return page.evaluate(()=>{
  let total=0,missing=0;
  for(let y=70;y<840;y+=87)for(let x=25;x<1420;x+=93){total++;let covered=false;for(const dx of [0,-9,9])for(const dy of [0,-9,9])if(document.elementFromPoint(x+dx,y+dy)?.closest('[data-media-id]'))covered=true;if(!covered)missing++;}
  return{total,missing,count:document.querySelectorAll('[data-instance-id]').length};
});}
async function drag(dx,dy){await page.mouse.move(650,450);await page.mouse.down();await page.mouse.move(650+dx,450+dy,{steps:8});await page.mouse.up();await pause(240);}
function onscreen(tile){return tile.x>30&&tile.y>65&&tile.x+tile.width<1410&&tile.y+tile.height<850&&tile.width>25&&tile.height>25;}
async function focus(tile){await instance(tile.id).click();await until(async()=>await page.locator('.media-tile.focused').getAttribute('data-instance-id')===tile.id,'clicked instance focuses');await settled();return instance(tile.id).boundingBox();}
function centered(box){assert.ok(Math.abs(box.x+box.width/2-720)<3&&Math.abs(box.y+box.height/2-480)<3,`focus center ${JSON.stringify(box)}`);}
try{
  app=await _electron.launch({executablePath:process.env.SHIGUANG_EXECUTABLE||electronPath,args:process.env.SHIGUANG_EXECUTABLE?[]:[cwd],env:{...process.env,SHIGUANG_DATA_DIR:dataDir,SHIGUANG_TEST_MODE:'1'}});
  page=await app.firstWindow();page.on('pageerror',e=>report.errors.push(e.message));await page.setViewportSize({width:1440,height:960});
  await page.getByTestId('home-albums').waitFor();await page.evaluate(dir=>window.album.addSources([dir]),mediaDir);
  const library=await until(async()=>{const s=await snapshot();return s.media.length===3&&!s.jobs.some(j=>j.status==='running')?s:null;},'three actual media');
  await page.getByTestId('open-album').click();await page.getByTestId('home-albums').waitFor({state:'detached'});await pause(100);
  let cover=await coverage();assert.equal(cover.missing,0);assert.ok(cover.count>3&&cover.count<=400);assert.equal((await snapshot()).media.length,3);
  check('three real records form repeated distinct instances and cover the viewport',{...cover,records:3});

  for(let n=0;n<6;n++)await drag(580,330);
  let list=await tiles(),cam=await camera();assert.ok(list.some(t=>t.id.split(':').slice(0,2).some(n=>+n<0)));assert.ok(cam.x>3000&&cam.y>1500);
  cover=await coverage();assert.equal(cover.missing,0);assert.ok(cover.count<=400);check('dragging thousands of pixels into negative world coordinates never exposes an edge',{camera:cam,coverage:cover});
  await page.getByTestId('more-toggle').focus();await page.keyboard.press('ArrowRight');await settled();
  const keyboardSelection=await page.locator('.media-tile.selected').getAttribute('data-instance-id');assert.ok(keyboardSelection.split(':').slice(0,2).some(n=>+n!==0));
  const afterArrow=await camera();assert.ok(Math.abs(afterArrow.x-cam.x)<1440&&Math.abs(afterArrow.y-cam.y)<960);check('arrow selection uses nearby repeated instances and keeps the current neighborhood');
  await page.keyboard.press('Escape');await settled();

  list=await tiles();let selected=list.filter(onscreen).sort((a,b)=>a.width*a.height-b.width*b.height)[0];assert.ok(selected);
  const originalCamera=await camera(),firstArea=selected.width*selected.height;
  await instance(selected.id).click();await until(async()=>await page.locator('.media-tile.focused').count()===1,'single focus begins');
  const moving=await camera();assert.equal(moving.animated,true);assert.ok(Math.abs(moving.scale-originalCamera.scale)<.0001);
  const reserved=await tiles();assert.ok(reserved.some(t=>t.id===selected.id));
  await settled();let box=await instance(selected.id).boundingBox();centered(box);assert.ok(box.width*box.height>firstArea*1.4);assert.equal((await camera()).scale,originalCamera.scale);
  assert.equal(await page.locator('.media-tile.focused').count(),1);assert.equal(await page.locator(`[data-media-id="${selected.mediaId}"].focused`).count(),1);
  const image=library.media.find(i=>i.id===selected.mediaId),desiredHeight=Math.min(960*.64,1440*.68/(image.width/image.height));assert.ok(Math.abs(box.height-desiredHeight)<14);
  cover=await coverage();assert.equal(cover.missing,0);check('clicking a noncanonical instance grows only that focus and smoothly pans it to the center without zoom',{instance:selected.id,height:box.height,expectedHeight:desiredHeight,areaRatio:box.width*box.height/firstArea,cameraScale:originalCamera.scale,reservedTiles:reserved.length});
  await page.screenshot({path:path.join(out,`${prefix}infinite-focused.png`)});

  list=await tiles();const second=list.filter(t=>onscreen(t)&&t.mediaId!==selected.mediaId).sort((a,b)=>a.width*a.height-b.width*b.height)[0];assert.ok(second);
  box=await focus(second);centered(box);assert.equal(await page.locator('.media-tile.focused').getAttribute('data-instance-id'),second.id);assert.equal((await camera()).scale,originalCamera.scale);
  const beforeMulti=await camera();list=await tiles();const multi=list.find(t=>onscreen(t)&&t.mediaId!==second.mediaId);assert.ok(multi);
  await instance(multi.id).click({modifiers:['Control']});await pause(100);assert.deepEqual(await camera(),beforeMulti);check('switching photos centers the clicked copy; Ctrl multiselect never recenters or multiplies zoom');
  await page.keyboard.press('Escape');await settled();const restored=await camera();assert.ok(Math.abs(restored.x-originalCamera.x)<1&&Math.abs(restored.y-originalCamera.y)<1&&restored.scale===originalCamera.scale);check('Escape removes focus and restores the camera before the first focus');

  list=await tiles();selected=list.filter(onscreen).sort((a,b)=>a.width*a.height-b.width*b.height)[0];await instance(selected.id).click();await until(async()=>await page.locator('.media-tile.focused').count()===1,'interruptible focus');
  await page.evaluate(()=>document.addEventListener('pointerdown',()=>{
    const world=document.querySelector('[data-testid="gallery-world"]'),matrix=new DOMMatrix(getComputedStyle(world).transform);
    window.interruptPointerCamera={x:matrix.e,y:matrix.f,scale:matrix.a,animated:world.classList.contains('camera-animating')};
  },{once:true,capture:true}));
  await page.mouse.move(700,700);await page.mouse.down();
  const beforeInterrupt=await page.evaluate(()=>window.interruptPointerCamera),stopped=await camera();
  assert.equal(beforeInterrupt.animated,true);assert.equal(stopped.animated,false);
  assert.ok(Math.abs(stopped.x-beforeInterrupt.x)<2&&Math.abs(stopped.y-beforeInterrupt.y)<2,`pan stop jumped: ${JSON.stringify({beforeInterrupt,stopped})}`);
  await page.mouse.move(750,730,{steps:1});const interrupted=await camera();await page.mouse.up();
  assert.equal(interrupted.animated,false);assert.ok(Math.abs(interrupted.x-beforeInterrupt.x-50)<2&&Math.abs(interrupted.y-beforeInterrupt.y-30)<2,`drag delta: ${JSON.stringify({beforeInterrupt,interrupted})}`);check('drag interrupts an in-flight pan from its live position without jumping to its destination',{beforeInterrupt,stopped,interrupted});await pause(250);
  list=await tiles();const wheelTarget=list.filter(t=>onscreen(t)&&t.id!==selected.id).sort((a,b)=>a.width*a.height-b.width*b.height)[0];assert.ok(wheelTarget);
  await instance(wheelTarget.id).click();await until(async()=>await page.locator('.media-tile.focused').getAttribute('data-instance-id')===wheelTarget.id,'wheel-interruptible focus');
  const wheelBefore=await camera();await page.mouse.move(720,600);await page.mouse.wheel(0,130);await until(async()=>!(await camera()).animated,'wheel stops camera easing');const wheelAfter=await camera();assert.ok(wheelAfter.scale<wheelBefore.scale);check('wheel zoom responds immediately and cancels camera easing',{before:wheelBefore.scale,after:wheelAfter.scale});
  await page.keyboard.press('Escape');await settled();

  for(let n=0;n<12;n++)await drag(-580,-330);
  cover=await coverage();cam=await camera();assert.equal(cover.missing,0);assert.ok(cover.count<=400);assert.ok((await tiles()).some(t=>t.id.split(':').slice(0,2).some(n=>+n>0)));check('the opposite direction stays filled and bounded as well',{camera:cam,coverage:cover});

  list=await tiles();const a=list.filter(onscreen)[0];await instance(a.id).click({modifiers:['Control']});
  list=await tiles();const b=list.find(t=>onscreen(t)&&t.mediaId!==a.mediaId);assert.ok(b);
  const beforeOpen=(await snapshot()).media.map(i=>({id:i.id,count:i.openCount}));
  await instance(b.id).focus();await page.keyboard.press('Enter');await page.getByTestId('viewer').waitFor();assert.equal(await page.locator('.viewer-title strong').textContent(),library.media.find(i=>i.id===b.mediaId).fileName);
  await page.keyboard.press('Escape');await page.getByTestId('viewer').waitFor({state:'detached'});assert.equal(await instance(b.id).evaluate(el=>document.activeElement===el),true);
  const afterOpen=await snapshot();for(const before of beforeOpen)assert.equal(afterOpen.media.find(i=>i.id===before.id).openCount,before.count+(before.id===b.mediaId?1:0));
  const wasFavorite=afterOpen.media.find(i=>i.id===b.mediaId).favorite;await instance(b.id).locator('.tile-favorite').focus();await page.keyboard.press('Enter');await until(async()=>(await snapshot()).media.find(i=>i.id===b.mediaId).favorite!==wasFavorite,'keyboard favorite');assert.equal(await page.getByTestId('viewer').count(),0);
  check('Enter on focused B opens B once despite selected A, returns to that B copy; favorite Enter only favorites');
  const beforeDouble=(await snapshot()).media.find(i=>i.id===b.mediaId).openCount;await instance(b.id).dblclick();await page.getByTestId('viewer').waitFor();await until(async()=>(await snapshot()).media.find(i=>i.id===b.mediaId).openCount===beforeDouble+1,'one deliberate doubleclick opening');await page.keyboard.press('Escape');await page.getByTestId('viewer').waitFor({state:'detached'});
  assert.equal((await snapshot()).media.length,3);assert.equal((await snapshot()).media.find(i=>i.id===b.mediaId).openCount,beforeDouble+1);check('doubleclicking repeated B counts once and never duplicates library records');
  await page.screenshot({path:path.join(out,`${prefix}infinite-far-wall.png`)});assert.equal(report.errors.length,0);check('no renderer errors');report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack||String(error);console.error(report.failure);process.exitCode=1;if(page)await page.screenshot({path:path.join(out,`${prefix}infinite-failure.png`)}).catch(()=>{});}
finally{if(app)await app.close().catch(()=>{});report.finished=new Date().toISOString();await fs.writeFile(path.join(out,`${prefix}infinite-wall-e2e-report.json`),JSON.stringify(report,null,2));}
