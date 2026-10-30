import { _electron, chromium } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const root=path.resolve('tests/.runtime/receive-'+Date.now()),profile=path.join(root,'profile'),destination=path.join(root,'电脑照片'),out=path.resolve('docs/acceptance');
await fs.mkdir(root,{recursive:true});await fs.mkdir(out,{recursive:true});
const fixture=path.join(root,'手机上的中文照片.png');await sharp({create:{width:640,height:900,channels:3,background:'#ccc'}}).png().toFile(fixture);
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
const report={startedAt:new Date().toISOString(),checks:[],errors:[],packaged:Boolean(process.env.SHIGUANG_EXECUTABLE),executable:process.env.SHIGUANG_EXECUTABLE||electronPath,packageKind:process.env.SHIGUANG_EXECUTABLE?(process.env.SHIGUANG_EXECUTABLE.includes('win-unpacked')?'packaged-unpacked':'installed-or-custom'):'development',profile};let app,browser;
const until=async(fn,label)=>{const deadline=Date.now()+30000;while(Date.now()<deadline){const result=await fn();if(result)return result;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timed out '+label);};
try{
  app=await _electron.launch({executablePath:process.env.SHIGUANG_EXECUTABLE||electronPath,args:process.env.SHIGUANG_EXECUTABLE?[]:[process.cwd()],env:{...process.env,SHIGUANG_DATA_DIR:profile,SHIGUANG_TEST_MODE:'1'},timeout:60000});
  const page=await app.firstWindow();await page.setViewportSize({width:1440,height:960});page.on('pageerror',error=>report.errors.push(error.message));await page.getByTestId('home-albums').waitFor();
  await app.evaluate(({dialog},dir)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[dir]});},destination);
  await page.getByTestId('import-folder').click();await page.getByTestId('import-phone-receive').click();await page.getByRole('dialog',{name:'手机无线传入'}).waitFor();
  await page.getByRole('button',{name:'选择照片保存文件夹，建议 E 盘'}).click();await page.getByLabel('无线传入相册名称').fill('手机测试相簿');await page.getByRole('button',{name:'开始接收',exact:true}).click();
  await page.getByAltText('手机扫码打开照片发送页面').waitFor();
  const state=await page.evaluate(()=>window.album.phoneReceiveState());const url=state.addresses[0].url;assert.equal(new URL(url).hostname,'127.0.0.1');assert.ok(state.addresses[0].qrCode.startsWith('data:image/png;base64,'));report.checks.push('Explicit desktop action opens loopback-only session and locally-generated QR.');
  await page.screenshot({path:path.join(out,'1.2-phone-receive-desktop.png')});
  browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const mobile=await context.newPage();mobile.on('pageerror',error=>report.errors.push(error.message));await mobile.goto(url);await mobile.getByText('已连接 · 保存到相册「手机测试相簿」',{exact:true}).waitFor();
  await mobile.locator('#photos').setInputFiles(fixture);await mobile.getByRole('button',{name:'开始发送',exact:true}).click();await mobile.getByText('发送完成 · 1 项，电脑相册里已经可以查看。',{exact:true}).waitFor();
  const received=path.join(destination,'手机测试相簿',path.basename(fixture));assert.equal(hash(await fs.readFile(received)),hash(await fs.readFile(fixture)));report.checks.push('Mobile browser File picker + real XHR raw upload preserves original SHA-256 and Chinese filename.');
  const snapshot=await until(async()=>{const value=await page.evaluate(()=>window.album.getSnapshot());return value.media.length===1?value:null;},'desktop indexes received image');assert.ok(snapshot.media[0].phoneFolders.some(folder=>folder.name==='手机测试相簿'));const bitmap=await page.evaluate(async url=>{const response=await fetch(url);const bitmap=await createImageBitmap(await response.blob());return{width:bitmap.width,height:bitmap.height};},snapshot.media[0].thumbnailUrl);assert.ok(bitmap.width>0&&bitmap.height>0);report.checks.push('Desktop library indexes complete upload and displays album association + decoded thumbnail.');
  await mobile.locator('#photos').setInputFiles(fixture);await mobile.getByRole('button',{name:'开始发送',exact:true}).click();await mobile.getByText('已在电脑上 · '+path.basename(fixture),{exact:true}).waitFor();assert.equal((await page.evaluate(()=>window.album.phoneReceiveState())).skipped,1);report.checks.push('Browser can select next batch; duplicate content is skipped.');
  assert.equal(await mobile.locator('#cancel').isVisible(),false);assert.equal(await mobile.locator('#retry').isVisible(),false);await mobile.screenshot({path:path.join(out,'1.2-phone-receive-mobile.png')});
  await page.getByRole('button',{name:'停止接收',exact:true}).click();await until(async()=>!(await page.evaluate(()=>window.album.phoneReceiveState())).active,'receiver closes');await assert.rejects(fetch(url.split('#')[0]+'status'));report.checks.push('Stop closes HTTP listener; completed originals remain.');
  assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.error=String(error);process.exitCode=1;}finally{await browser?.close().catch(()=>{});await app?.close().catch(()=>{});report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(out,'1.2-phone-receive-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
