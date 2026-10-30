import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { IntelligenceService, type AnalysisMedia } from '../electron/intelligence';

// This runs in a fresh Node process. The Python inference worker additionally
// blocks socket connections; no setup or model download is permitted here.
globalThis.fetch = async () => { throw new Error('Offline acceptance forbids network requests'); };
const root = path.resolve(process.env.SHIGUANG_AI_TEST_DIR || 'tests/.runtime/ai-real');
const files = [path.resolve('tests/.fixtures/ai-validation/文字识别测试.png'), path.resolve('tests/.fixtures/ai-validation/cat.jpg')];
const media: AnalysisMedia[] = await Promise.all(files.map(async (file, i) => ({ id: i ? 'cat' : 'ocr', path: file, fileName: path.basename(file), kind: 'image', size: (await fs.stat(file)).size, mtimeMs: 1, missing: false, tags: [] })));
const db = new DatabaseSync(path.join(root, 'smoke.sqlite'));
const service = new IntelligenceService({ dataDir: root, db, resourceDir: path.resolve('resources/ai'), getMedia: ids => media.filter(item => !ids || ids.includes(item.id)), getAnalysisImage: async id => media.find(item => item.id === id)!.path });
try {
  await service.initialize();
  assert.equal(service.getState().indexed, 2);
  const text = await service.search({ query: '身份证', mode: 'text' });
  const content = await service.search({ query: '猫', mode: 'content' });
  assert.equal(text.hits[0]?.id, 'ocr');
  assert.equal(content.hits[0]?.id, 'cat');
  assert.equal(content.semanticReady, true);
  console.log(JSON.stringify({ freshProcess: true, networkDisabled: true, text, content, modelState: service.getState().models }));
} finally { await service.close(); db.close(); }
