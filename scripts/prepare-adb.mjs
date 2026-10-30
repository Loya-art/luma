import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const root = path.resolve('resources/binaries');
const names = ['adb.exe','AdbWinApi.dll','AdbWinUsbApi.dll'];
await fs.mkdir(root,{recursive:true});
const ready = (await Promise.all(names.map(name=>fs.stat(path.join(root,name)).then(s=>s.size>0,()=>false)))).every(Boolean);
if (!ready) {
  // Official standalone distribution: https://developer.android.com/tools/releases/platform-tools
  const url='https://dl.google.com/android/repository/platform-tools-latest-windows.zip';
  const temporary=await fs.mkdtemp(path.join(root,'.adb-download-'));
  try {
    const response=await fetch(url,{signal:AbortSignal.timeout(180000)});
    if(!response.ok)throw new Error(`Android platform-tools download failed: HTTP ${response.status}`);
    const archive=Buffer.from(await response.arrayBuffer());
    if(archive.length<1024*1024||archive[0]!==0x50||archive[1]!==0x4b)throw new Error('Invalid Android platform-tools archive');
    const archivePath=path.join(temporary,'platform-tools.zip');await fs.writeFile(archivePath,archive);
    const escape=value=>`'${value.replace(/'/g,"''")}'`;
    await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Expand-Archive -LiteralPath ${escape(archivePath)} -DestinationPath ${escape(temporary)}`],{windowsHide:true});
    for(const name of names)await fs.copyFile(path.join(temporary,'platform-tools',name),path.join(root,name));
    await fs.copyFile(path.join(temporary,'platform-tools','NOTICE.txt'),path.join(root,'ADB-LICENSE.txt'));
    await fs.writeFile(path.join(root,'ADB-DOWNLOAD.json'),JSON.stringify({url,sha256:createHash('sha256').update(archive).digest('hex'),downloadedAt:new Date().toISOString()},null,2));
  } finally {
    // The resolved path comes directly from mkdtemp within resources/binaries.
    if(!temporary.startsWith(root+path.sep))throw new Error('Unexpected download path');
    await fs.rm(temporary,{recursive:true,force:true});
  }
}
const {stdout}=await execute(path.join(root,'adb.exe'),['version'],{windowsHide:true});
if(!stdout.includes('Android Debug Bridge'))throw new Error('ADB executable verification failed');
const versionLines=stdout.split(/\r?\n/).slice(0,2).join('\n');
await fs.writeFile(path.join(root,'ADB-NOTICE.txt'),`Android Debug Bridge is invoked as a separate local process.\nOfficial distribution: https://developer.android.com/tools/releases/platform-tools\nUsage: https://developer.android.com/tools/adb\nSee ADB-LICENSE.txt for notices.\n\n${versionLines}\n`);
console.log(stdout.trim());
