import { _electron } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const cwd=process.cwd(), runRoot=path.join(cwd,'tests','.runtime',`final-capture-${Date.now()}`), dataDir=path.join(runRoot,'library'), mediaDir=path.join(runRoot,'影像集'), out=path.join(cwd,'docs','acceptance');
await fs.mkdir(dataDir,{recursive:true});await fs.mkdir(out,{recursive:true});await fs.cp(path.join(cwd,'tests','.fixtures','混合尺寸素材'),mediaDir,{recursive:true});await fs.mkdir(path.join(mediaDir,'色彩札记'));
for(const name of ['构成-01.jpg','构成-02.png','构成-03.webp'])await fs.rename(path.join(mediaDir,name),path.join(mediaDir,'色彩札记',name));
let app;
try{
 app=await _electron.launch({executablePath:electronPath,args:[cwd],env:{...process.env,SHIGUANG_DATA_DIR:dataDir,SHIGUANG_TEST_MODE:'1'},timeout:45000});const page=await app.firstWindow();await page.setViewportSize({width:1440,height:960});
 page.on('pageerror',error=>console.log('PAGEERROR',error.message));await page.getByTestId('home-albums').waitFor();await page.screenshot({path:path.join(out,'empty-final.png')});
 await page.evaluate(dir=>window.album.addSources([dir]),mediaDir);
 await page.waitForFunction(async()=>{const s=await window.album.getSnapshot();return s.media.length===44&&!s.jobs.some(j=>j.status==='running');},null,{timeout:90000});
 await page.getByTestId('album-card').nth(2).waitFor();await page.getByTestId('album-card').nth(1).click();await page.waitForTimeout(700);await page.screenshot({path:path.join(out,'home.png')});console.log('SCREENSHOT home.png');
 await page.locator('.home-tabs').getByRole('button',{name:'全部',exact:true}).click();await page.getByTestId('gallery-viewport').waitFor();
 await page.getByTestId('more-toggle').click();await page.getByRole('combobox',{name:'素材类型'}).selectOption('image');await page.getByTestId('more-toggle').click();await page.waitForTimeout(650);await page.screenshot({path:path.join(out,'wall-immersive.png')});console.log('SCREENSHOT wall-immersive.png');
 await page.getByTestId('media-tile').first().click();await page.waitForTimeout(500);await page.getByTestId('more-toggle').click();await page.getByRole('button',{name:'关灯',exact:true}).click();await page.getByTestId('wall-help-toggle').click();await page.locator('.wall-shortcuts').scrollIntoViewIfNeeded();await page.waitForTimeout(400);await page.screenshot({path:path.join(out,'wall-help.png')});console.log('SCREENSHOT wall-help.png');
 assert.equal(await page.locator('.floating-dock>button').count(),4);await fs.writeFile(path.join(out,'capture-data.json'),JSON.stringify({dataDir,mediaDir,runRoot}));
}finally{await app?.close();}
