import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PhoneService, phoneFolderRecommendation, phoneRelativePath, publishPhoneFile, quoteRemote, safePhoneSegment, type AdbTransport, type AdbResult } from '../electron/phone';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const execute = promisify(execFile);
type RemoteFile = { bytes: Buffer; mtime: number };
class FakeAdb implements AdbTransport {
  files = new Map<string, RemoteFile>();
  serial = '192.168.1.2:37123'; online = true; pulls: string[] = []; calls: string[][] = [];
  failOnce?: string; corruptOnce = false; afterPull?: (remote: string) => void;
  waitOnPull = false;
  nativeMetadata = false; streamScan = false;
  add(remote: string, value: string) { this.files.set(remote, { bytes: Buffer.from(value), mtime: 1730000000 }); return this; }
  async run(args: string[], options: { signal?: AbortSignal; onStdout?: (chunk: Buffer) => void } = {}): Promise<AdbResult> {
    this.calls.push(args);
    if (options.signal?.aborted) throw new Error('已暂停');
    const result = (text: string | Buffer, stderr = '') => ({ stdout: Buffer.isBuffer(text) ? text : Buffer.from(text), stderr });
    if (args[0] === 'devices') return result(`List of devices attached\n${this.online ? this.serial + ' device product:sample model:测试手机 transport_id:1\n' : ''}`);
    if (args[0] === 'pair') return result('Successfully paired');
    if (args[0] === 'connect') return result('connected to ' + args[1]);
    if (args[0] !== '-s' || args[1] !== this.serial || !this.online) throw new Error('device offline');
    if (args[2] === 'shell') {
      const script = args[3];
      if (script.startsWith('getprop')) return result('stable-phone-serial\nstable-boot-serial\nandroid-id\n示例品牌\n测试手机\n14\n');
      if (script.startsWith("printf '%s\\0'")) return result('/storage/emulated/0\0');
      if (script.startsWith('find /dev/null ')) { if(!this.nativeMetadata) throw new Error('find: unknown option -printf'); return result('/dev/null\0'+'0 100.123999999\0'); }
      if (script.startsWith('find ')) {
        const parts: string[] = [];
        for (const [remote, file] of this.files) parts.push(remote, `${file.bytes.length} ${file.mtime}${this.nativeMetadata?'.123999999':''}`);
        const output=Buffer.from(parts.join('\0')+'\0');
        if(this.streamScan)for(let offset=0;offset<output.length;offset+=7)options.onStdout?.(output.subarray(offset,offset+7));
        return result(output, 'find: /storage/emulated/0/受限目录: Permission denied\n');
      }
      const item = [...this.files.entries()].find(([remote]) => script.endsWith(quoteRemote(remote)));
      if (!item) throw new Error('No such file or directory');
      const [remote, file] = item;
      if (script.startsWith('stat ')) return result(`${file.bytes.length} ${file.mtime}\n`);
      if (script.startsWith('sha256sum ')) return result(`${remote.includes('\n') ? '\\' : ''}${sha(file.bytes)}  ${remote.replace(/\n/g, '\\n')}\n`);
    }
    if (args[2] === 'pull') {
      const remote = args[4], target = args[5];
      this.pulls.push(remote);
      if (this.waitOnPull) {
        await new Promise<void>((_resolve, reject) => { options.signal?.addEventListener('abort', () => reject(new Error('已暂停')), { once: true }); });
      }
      const file = this.files.get(remote); if (!file) throw new Error('No such file or directory');
      if (this.failOnce === remote) { this.failOnce = undefined; await fs.writeFile(target, 'incomplete'); this.online = false; throw new Error('device offline'); }
      await fs.writeFile(target, this.corruptOnce ? 'corrupt' : file.bytes); this.corruptOnce = false;
      this.afterPull?.(remote);
      return result('1 file pulled');
    }
    throw new Error('Unrecognized ADB operation: ' + JSON.stringify(args));
  }
}

async function fixture(fake = new FakeAdb()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiguang-phone-'));
  const database = path.join(root, 'phone.sqlite');
  const db = new DatabaseSync(database);
  const notified: string[] = [];
  const service = new PhoneService({ db, dataDir: root, adbPath: 'not-needed-in-transport-test', transport: fake, onImported: async value => { notified.push(value); } });
  await service.initialize();
  return { root, db, service, fake, notified, destination: path.join(root, '手机照片'), async cleanup() {
    await service.close(); db.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'shiguang-phone-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}
async function importAll(service: PhoneService, destination: string) {
  const devices = await service.listDevices(); assert.equal(devices.length, 1);
  const scan = await service.scan(devices[0].id);
  const id = await service.startImport({ scanId: scan.id, destination });
  await service.waitForIdle();
  return { id, scan, job: service.getState().jobs.find(job => job.id === id)! };
}
async function filesInside(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await filesInside(file)); else result.push(file);
  }
  return result;
}

test('phone paths remain contained and remote shell quoting preserves quotes/newlines without expansion', async () => {
  for (const unsafe of ['/data/private/a.jpg', '/storage/emulated/0/../secret.jpg', 'relative.jpg', '/storage/emulated/0/a\0.jpg']) assert.throws(() => phoneRelativePath(unsafe));
  assert.equal(safePhoneSegment('CON.jpg').startsWith('_CON~'), true);
  assert.notEqual(safePhoneSegment('a:b.jpg'), safePhoneSegment('a?b.jpg'));
  assert.equal(path.isAbsolute(phoneRelativePath('/storage/emulated/0/相机/测试.jpg')), false);
  const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
  const value = "中文 😀 '相机'\n$(printf INJECTED) `printf BAD` \\ end";
  const { stdout } = await execute(bash, ['--noprofile', '--norc', '-c', `printf '%s' ${quoteRemote(value)}`], { windowsHide: true });
  assert.equal(stdout, value);
});

test('native find metadata streams split UTF-8 safely with progress and fractional timestamp normalization', async () => {
  const fake=new FakeAdb().add("/storage/emulated/0/DCIM/中文😀 '照片\n一.jpg",'one-photo').add('/storage/emulated/0/DCIM/第二.jpg','second');fake.nativeMetadata=true;fake.streamScan=true;
  const f=await fixture(fake);
  try{
    const {job,scan}=await importAll(f.service,f.destination);assert.equal(scan.count,2);assert.equal(job.status,'complete');assert.equal(job.done,2);
    assert.equal(f.service.getState().scanProgress?.count,2);assert.equal(f.service.getState().scanProgress?.bytes,15);
    const script=fake.calls.find(args=>args[2]==='shell'&&args[3].startsWith("find '/storage/emulated/0'"))![3];assert.ok(script.includes("-printf '%p\\0%s %T@\\0'"));assert.ok(!script.includes('while IFS='));
  }finally{await f.cleanup();}
});

test('generated find shell preserves special filenames and excludes private/recycle/thumbnail files', async () => {
  const fake=new FakeAdb();fake.nativeMetadata=true;const f=await fixture(fake);
  try{
    const source=path.join(f.root,'remote-files');await fs.mkdir(path.join(source,'DCIM'),{recursive:true});await fs.mkdir(path.join(source,'Android','data'),{recursive:true});await fs.mkdir(path.join(source,'.thumbnails'),{recursive:true});await fs.mkdir(path.join(source,'.Trash-1000'),{recursive:true});
    const wanted="测试 ' 😀"+(process.platform==='win32'?' ':'\n')+'$(printf BAD).jpg';
    await fs.writeFile(path.join(source,'DCIM',wanted),'photo');
    for(const relative of ['Android/data/private.jpg','.thumbnails/thumb.jpg','.Trash-1000/deleted.jpg','DCIM/.trashed-123-a.jpg','DCIM/.pending-123-b.jpg','DCIM/note.txt'])await fs.writeFile(path.join(source,relative),'skip');
    const device=(await f.service.listDevices())[0];await f.service.scan(device.id);
    const remoteScript=fake.calls.find(args=>args[2]==='shell'&&args[3].startsWith("find '/storage/emulated/0'"))![3];
    const bash=process.platform==='win32'?'C:\\Program Files\\Git\\bin\\bash.exe':'/bin/bash';
    const unixRoot=process.platform==='win32'?(await execute(bash,['--noprofile','--norc','-c','cygpath -u "$1"','phone-test',source],{windowsHide:true})).stdout.trim():source;
    const {stdout}=await execute(bash,['--noprofile','--norc','-c',remoteScript.replaceAll('/storage/emulated/0',unixRoot)],{windowsHide:true});
    const entries=stdout.split('\0');assert.equal(entries.length,3);assert.equal(entries[0],unixRoot+'/DCIM/'+wanted);assert.match(entries[1],/^5 \d+\.\d+$/);
  }finally{await f.cleanup();}
});

test('recommendations keep real hidden photo folders while visible cache/resource rows default off', () => {
  for(const folder of ['/storage/emulated/0/.vivoNotes','/storage/emulated/0/Pictures/vivogallery/.third','/storage/emulated/0/Pictures/身份证','/storage/emulated/0/DCIM/Camera'])assert.equal(phoneFolderRecommendation(folder).recommended,true);
  for(const folder of ['/storage/emulated/0/.BBKAppStore/cache','/storage/emulated/0/.vivoBrowser/widget/abc','/storage/emulated/0/DCIM/Camera/.watermark','/storage/emulated/0/Pictures/.gs_fs0','/storage/emulated/0/Pictures/.gs/com.app/.gs_fs6/0']){const recommendation=phoneFolderRecommendation(folder);assert.equal(recommendation.recommended,false);assert.match(recommendation.exclusionReason!,/手动选择/);}
});

test('verified Unicode import deduplicates content, keeps aliases and preserves case-colliding originals', async () => {
  const f = await fixture(new FakeAdb()
    .add("/storage/emulated/0/DCIM/相机/小猫 ' 😀\n影像.jpg", 'cat-photo')
    .add('/storage/emulated/0/Pictures/重复.jpg', 'cat-photo')
    .add('/storage/emulated/0/Pictures/a.JPG', 'lower-case-photo')
    .add('/storage/emulated/0/Pictures/A.jpg', 'UPPER-CASE-PHOTO'));
  try {
    const first = await importAll(f.service, f.destination);
    assert.equal(first.scan.count, 4); assert.equal(first.scan.issues.length, 1); assert.match(first.scan.notes.join(''), /云相册/);
    assert.equal(first.job.status, 'complete'); assert.equal(first.job.done, 4); assert.equal(first.job.imported, 3); assert.equal(first.job.skipped, 1);
    const aliases = f.service.getAliases(); assert.equal(aliases.length, 4); assert.equal(new Set(aliases.map(alias => alias.localPath)).size, 3);
    for (const alias of aliases) {
      assert.ok(alias.localPath.startsWith(f.destination + path.sep));
      assert.equal(sha(await fs.readFile(alias.localPath)), sha(f.fake.files.get(alias.sourcePath)!.bytes));
      assert.equal(Math.floor((await fs.stat(alias.localPath)).mtimeMs / 1000), 1730000000);
    }
    const imported = await filesInside(f.destination); assert.equal(imported.filter(file => /\.jpg$/i.test(file)).length, 3); assert.equal(imported.some(file => file.endsWith('.partial')), false);
    const pulls = f.fake.pulls.length;
    const second = await importAll(f.service, f.destination);
    assert.equal(second.job.status, 'complete'); assert.equal(second.job.imported, 0); assert.equal(second.job.skipped, 4); assert.equal(f.fake.pulls.length, pulls);
    assert.ok(f.notified.every(root => root === f.destination));
    assert.ok(f.fake.calls.every(args => !args.includes('push') && !args.includes('rm')));
  } finally { await f.cleanup(); }
});

test('disconnect and restart resume remaining files using stable identity after Wi-Fi port changes', async () => {
  const fake = new FakeAdb().add('/storage/emulated/0/DCIM/1.jpg', 'one').add('/storage/emulated/0/DCIM/2.jpg', 'two');
  fake.failOnce = '/storage/emulated/0/DCIM/2.jpg';
  const f = await fixture(fake);
  let restarted: PhoneService | undefined;
  try {
    const first = await importAll(f.service, f.destination);
    assert.equal(first.job.status, 'paused'); assert.equal(first.job.done, 1); assert.match(first.job.error!, /offline/);
    assert.equal((await filesInside(f.destination)).some(file => file.endsWith('.partial')), false);
    await f.service.close();
    const stale = { ...first.job, status: 'running', done: 0, imported: 0, transferredBytes: 0 };
    f.db.prepare('UPDATE phone_jobs SET data=? WHERE id=?').run(JSON.stringify(stale), first.id);
    fake.online = true; fake.serial = '192.168.1.77:49999';
    restarted = new PhoneService({ db: f.db, dataDir: f.root, adbPath: 'fake', transport: fake });
    await restarted.initialize();
    const recovered = restarted.getState().jobs[0]; assert.equal(recovered.status, 'paused'); assert.equal(recovered.done, 1); assert.equal(recovered.imported, 1);
    await restarted.resume(first.id); await restarted.waitForIdle();
    const complete = restarted.getState().jobs[0]; assert.equal(complete.status, 'complete'); assert.equal(complete.done, 2); assert.equal(complete.imported, 2); assert.equal(complete.failed, 0);
    assert.equal(fake.pulls.filter(file => file.endsWith('/1.jpg')).length, 1);
  } finally { await restarted?.close(); await f.cleanup(); }
});

test('corrupt transfer stays out of the manifest and a retry publishes only verified bytes', async () => {
  const f = await fixture(new FakeAdb().add('/storage/emulated/0/DCIM/测试.jpg', 'original-photo'));
  f.fake.corruptOnce = true;
  try {
    const first = await importAll(f.service, f.destination);
    assert.equal(first.job.status, 'error'); assert.equal(first.job.done, 0); assert.equal(first.job.failed, 1); assert.equal(f.service.getAliases().length, 0);
    assert.equal((await filesInside(f.destination)).some(file => /\.jpg$/i.test(file)), false);
    await f.service.resume(first.id); await f.service.waitForIdle();
    const job = f.service.getState().jobs[0]; assert.equal(job.status, 'complete'); assert.equal(job.done, 1); assert.equal(job.failed, 0);
    assert.equal(await fs.readFile(f.service.getAliases()[0].localPath, 'utf8'), 'original-photo');
  } finally { await f.cleanup(); }
});

test('source mutation with unchanged file size and time is detected before publication', async () => {
  const remote = '/storage/emulated/0/DCIM/变化.jpg';
  const f = await fixture(new FakeAdb().add(remote, 'original'));
  f.fake.afterPull = name => { f.fake.files.get(name)!.bytes = Buffer.from('modified'); };
  try {
    const first = await importAll(f.service, f.destination);
    assert.equal(first.job.status, 'error'); assert.match(first.job.issues[0].message, /发生变化/); assert.equal(f.service.getAliases().length, 0);
    assert.equal((await filesInside(f.destination)).some(file => /\.jpg$/i.test(file)), false);
  } finally { await f.cleanup(); }
});

test('changing the chosen destination makes a verified copy there instead of reusing an external canonical path', async () => {
  const f = await fixture(new FakeAdb().add('/storage/emulated/0/DCIM/1.jpg', 'one-photo'));
  try {
    await importAll(f.service, f.destination); const original = f.service.getAliases()[0].localPath;
    const next = path.join(f.root, '另一个保存位置'); const second = await importAll(f.service, next);
    assert.equal(second.job.status, 'complete'); assert.equal(second.job.imported, 1); assert.equal(second.job.skipped, 0);
    assert.ok(f.service.getAliases()[0].localPath.startsWith(next + path.sep)); assert.equal(await fs.readFile(original, 'utf8'), 'one-photo');
  } finally { await f.cleanup(); }
});

test('photos are copied before large videos so the album becomes usable earlier', async () => {
  const f=await fixture(new FakeAdb().add('/storage/emulated/0/DCIM/001-video.mp4','video').add('/storage/emulated/0/DCIM/999-photo.jpg','photo'));
  try{const {job}=await importAll(f.service,f.destination);assert.equal(job.status,'complete');assert.deepEqual(f.fake.pulls,['/storage/emulated/0/DCIM/999-photo.jpg','/storage/emulated/0/DCIM/001-video.mp4']);}finally{await f.cleanup();}
});

test('incremental import can skip known originals on a full disk while new files fail the space preflight', async context => {
  const f = await fixture(new FakeAdb().add('/storage/emulated/0/DCIM/1.jpg', 'one-photo'));
  try {
    await importAll(f.service, f.destination);
    context.mock.method(fs, 'statfs', async () => ({ bavail: 0, bsize: 4096 }));
    const repeated = await importAll(f.service, f.destination); assert.equal(repeated.job.status, 'complete'); assert.equal(repeated.job.skipped, 1);
    f.fake.add('/storage/emulated/0/DCIM/2.jpg', 'second-photo');
    await assert.rejects(importAll(f.service, f.destination), /空间不足/);
  } finally { context.mock.restoreAll(); await f.cleanup(); }
});

test('pause interrupts an in-flight transfer and resumes it without losing the pending file', async () => {
  const f = await fixture(new FakeAdb().add('/storage/emulated/0/DCIM/1.jpg', 'one-photo'));
  try {
    const device = (await f.service.listDevices())[0], scan = await f.service.scan(device.id);
    f.fake.waitOnPull = true;
    const id = await f.service.startImport({ scanId: scan.id, destination: f.destination });
    for (let attempt = 0; !f.fake.pulls.length && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.fake.pulls.length, 1);
    f.service.pause(id); await f.service.waitForIdle();
    const paused = f.service.getState().jobs[0]; assert.equal(paused.status, 'paused'); assert.equal(paused.done, 0); assert.equal(paused.failed, 0);
    f.fake.waitOnPull = false; await f.service.resume(id); await f.service.waitForIdle(); assert.equal(f.service.getState().jobs[0].status, 'complete');
  } finally { await f.cleanup(); }
});

test('staging directory junction cannot create files outside the selected destination', async () => {
  const f = await fixture(new FakeAdb().add('/storage/emulated/0/DCIM/1.jpg', 'one-photo'));
  try {
    const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.mkdir(f.destination);
    await fs.symlink(outside, path.join(f.destination, '.shiguang-staging'), process.platform === 'win32' ? 'junction' : 'dir');
    const imported = await importAll(f.service, f.destination);
    assert.equal(imported.job.status, 'paused'); assert.match(imported.job.error!, /目录链接/); assert.deepEqual(await fs.readdir(outside), []); assert.equal(f.fake.pulls.length, 0);
  } finally { await f.cleanup(); }
});

test('Windows no-hardlink publication remains non-overwriting and leaves no partial final image', { skip: process.platform !== 'win32' }, async context => {
  const f = await fixture();
  try {
    const temporary = path.join(f.root, 'source.partial'), target = path.join(f.root, "中文 '封面'.jpg"); await fs.writeFile(temporary, 'verified-image');
    context.mock.method(fs, 'link', async () => { throw Object.assign(new Error('exFAT does not support hardlinks'), { code: 'EPERM' }); });
    await publishPhoneFile(temporary, target);
    assert.equal(await fs.readFile(target, 'utf8'), 'verified-image'); assert.equal(await fs.stat(temporary).then(() => true, () => false), false);
    await fs.writeFile(temporary, 'new-content'); await assert.rejects(publishPhoneFile(temporary, target)); assert.equal(await fs.readFile(target, 'utf8'), 'verified-image');
  } finally { context.mock.restoreAll(); await f.cleanup(); }
});
