import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { IntelligenceService, type AnalysisMedia } from '../electron/intelligence';
import { ANALYSIS_VERSION, type LocalEngine } from '../electron/ai-runtime';

const vector = (index = 0) => Array.from({ length: 512 }, (_, i) => i === index ? 1 : 0);
class ControlledEngine implements LocalEngine {
  calls = 0; installed = false; fail = false;
  gate: Promise<void> | null = null;
  async setup(_directory: string, progress: (message: string) => void) { this.installed = true; progress('测试模型就绪'); }
  async ready() { return this.installed; }
  async analyze(_directory: string, _file: string, fileName: string) { this.calls++; if (this.gate) await this.gate; if (this.fail) throw new Error('模型解码失败'); return { text: fileName.startsWith('文字') ? '中华人民共和国居民身份证\n学校：福州大学\n海边合照\n20261028 TestInvoice' : '', tags: fileName.startsWith('文字') ? ['证件', '文档'] : ['动物'], vector: vector(fileName.startsWith('文字') ? 1 : 0), version: ANALYSIS_VERSION }; }
  async embed(_directory: string, query: string) { return vector(query.includes('猫') ? 0 : 1); }
  async close() {}
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiguang-ai-'));
  const file = path.join(root, 'image.png'); await sharp({ create: { width: 100, height: 100, channels: 3, background: 'white' } }).png().toFile(file);
  const rows: AnalysisMedia[] = [{ id: 'text', path: file, fileName: '文字.png', kind: 'image', mtimeMs: 1000, size: 100, missing: false, tags: ['我的笔记'] }, { id: 'cat', path: file, fileName: '动物.png', kind: 'image', mtimeMs: 1000, size: 100, missing: false, tags: [] }];
  const db = new DatabaseSync(':memory:'), engine = new ControlledEngine();
  let cloudCalls = 0;
  const options = { dataDir: root, db, engine, getMedia: (ids?: string[]) => rows.filter(item => !ids || ids.includes(item.id)), getAnalysisImage: async () => file, cloudFetch: (async (_url: any, init: any) => { cloudCalls++; const body = JSON.parse(init.body); assert.equal(body.model, 'deepseek-flash'); assert.match(body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ description: '一只猫的照片', tags: ['宠物', '动物'] }) } }] }), { status: 200 }); }) as typeof fetch };
  const service = new IntelligenceService(options); await service.initialize();
  return { root, db, rows, engine, options, service, cloudCalls: () => cloudCalls, close: async () => { await service.close(); db.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('local analysis is opt-in; Chinese OCR, tags, semantic search and paging use backend index', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.service.enqueue(), null); assert.equal(f.engine.calls, 0);
    assert.equal((await f.service.search({ query: '身份证', mode: 'text' })).total, 0);
    await f.service.setupModels({ directory: path.join(f.root, 'models') }); await f.service.waitForIdle();
    assert.equal(f.engine.calls, 2); assert.equal(f.service.getState().indexed, 2);
    const text = await f.service.search({ query: '身份证', mode: 'text' }); assert.deepEqual(text.hits.map(hit => hit.id), ['text']); assert.equal(text.hits[0].matchedBy, 'text');
    assert.equal((await f.service.search({ query: '福州大学', mode: 'text' })).hits[0].id, 'text');
    assert.equal((await f.service.search({ query: '2026', mode: 'text' })).hits[0].id, 'text');
    assert.equal((await f.service.search({ query: 'Invoice', mode: 'text' })).hits[0].id, 'text');
    assert.equal((await f.service.search({ query: '猫', mode: 'content' })).hits[0].id, 'cat');
    assert.equal((await f.service.search({ query: '我的笔记', mode: 'all' })).hits[0].matchedBy, 'tag');
    const page = await f.service.search({ query: '', limit: 1, offset: 1 }); assert.equal(page.total, 2); assert.equal(page.hits.length, 1);
    assert.deepEqual(Object.keys(f.service.summaries().get('text')!).sort(), ['status', 'tags']);
    assert.equal(f.cloudCalls(), 0);
  } finally { await f.close(); }
});

test('manual AI corrections survive re-analysis; changed files invalidate OCR and vectors', async () => {
  const f = await fixture();
  try {
    await f.service.setupModels({ directory: path.join(f.root, 'models') }); await f.service.waitForIdle();
    f.service.setTagOverride('text', '证件', false); f.service.setTagOverride('text', '学习', true);
    f.rows[0].mtimeMs++;
    assert.equal(f.service.detail('text').status, 'stale'); assert.equal((await f.service.search({ query: '身份证', mode: 'text' })).total, 0);
    assert.ok(!f.service.summaries().get('text')!.tags.includes('证件'));
    await f.service.enqueue(); await f.service.waitForIdle();
    assert.ok(!f.service.detail('text').tags.includes('证件')); assert.ok(f.service.detail('text').tags.includes('学习')); assert.deepEqual(f.service.detail('text').suppressedTags, ['证件']);
    assert.equal(f.cloudCalls(), 0);
  } finally { await f.close(); }
});

test('explicit cloud jobs upload only selected images, cache results and do not prevent later local OCR', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.startCloud(['cat'], '', ''), /密钥/);
    await f.service.startCloud(['cat'], '宠物分类', 'test-not-a-real-key'); await f.service.waitForIdle();
    assert.equal(f.cloudCalls(), 1); assert.equal(f.service.detail('text').status, 'missing'); assert.match(f.service.detail('cat').description, /猫/);
    await f.service.startCloud(['cat'], '宠物分类', 'test-not-a-real-key'); await f.service.waitForIdle(); assert.equal(f.cloudCalls(), 1);
    await f.service.setupModels({ directory: path.join(f.root, 'models') }); await f.service.waitForIdle(); assert.equal(f.engine.calls, 2); assert.match(f.service.detail('cat').description, /猫/);
  } finally { await f.close(); }
});

test('paused work persists across restart, queue serialization terminates, failed files retry', async () => {
  const f = await fixture();
  try {
    await f.service.setupModels({ directory: path.join(f.root, 'models') }); await f.service.waitForIdle();
    f.rows.forEach(item => item.mtimeMs++); f.engine.fail = true;
    const first = await f.service.enqueue(['text']); const second = await f.service.enqueue(['cat']); assert.ok(first && second); await f.service.waitForIdle();
    assert.equal(f.service.getState().jobs.filter(job => job.status === 'error').length, 2);
    f.engine.fail = false; await f.service.resume(first!); await f.service.resume(second!); await f.service.waitForIdle(); assert.equal(f.service.getState().indexed, 2);
    f.rows[0].mtimeMs++; let release!: () => void; f.engine.gate = new Promise<void>(resolve => { release = resolve; });
    const paused = await f.service.enqueue(['text']); f.service.pause(paused!); release(); await f.service.waitForIdle(); await f.service.close();
    const reopened = new IntelligenceService(f.options); await reopened.initialize(); assert.equal(reopened.getState().jobs.find(job => job.id === paused)?.status, 'paused');
    f.engine.gate = null; await reopened.resume(paused!); await reopened.waitForIdle(); assert.equal(reopened.getState().jobs.find(job => job.id === paused)?.status, 'complete'); await reopened.close();
  } finally { await f.close(); }
});
