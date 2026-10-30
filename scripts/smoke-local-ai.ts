import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { ManagedLocalEngine } from '../electron/ai-runtime';
import { IntelligenceService, type AnalysisMedia } from '../electron/intelligence';

const root = path.resolve(process.env.SHIGUANG_AI_TEST_DIR || 'tests/.runtime/ai-real');
const engine = new ManagedLocalEngine(path.resolve('resources/ai'));
const report: Record<string, any> = { startedAt: new Date().toISOString(), directory: root, checks: [] };
const controller = new AbortController();
await fs.mkdir(root, { recursive: true });
try {
  if (!(await engine.ready(root))) await engine.setup(root, message => console.log(message), controller.signal);
  const ocrFile = path.resolve('tests/.fixtures/ai-validation/文字识别测试.png'), catFile = path.resolve('tests/.fixtures/ai-validation/cat.jpg');
  const ocr = await engine.analyze(root, ocrFile, '文字识别测试.png');
  assert.match(ocr.text, /身份证/); assert.match(ocr.text, /福州大学/); assert.ok(ocr.tags.includes('证件')); assert.equal(ocr.vector.length, 512); report.ocr = { text: ocr.text, tags: ocr.tags, dimensions: ocr.vector.length }; console.log('OCR', ocr.text);
  report.checks.push('Real local OCR recognizes the Chinese ID-card and university sample text and classifies it as a credential.');
  const cat = await engine.analyze(root, catFile, 'cat.jpg');
  const scores: Record<string, number> = {};
  for (const label of ['猫', '汽车', '人物', '海边']) { const vector = await engine.embed(root, label); scores[label] = vector.reduce((sum, value, index) => sum + value * cat.vector[index], 0); }
  assert.ok(scores['猫'] > scores['汽车'] && scores['猫'] > scores['人物'] && scores['猫'] > scores['海边']);
  assert.ok(cat.tags.includes('动物'));
  report.semantic = { scores, tags: cat.tags }; console.log('SEMANTIC', scores);
  report.checks.push('Real Chinese-CLIP ranks the cat above car, people and seaside and classifies the image as an animal.');
  await engine.close();
  const db = new DatabaseSync(path.join(root, 'smoke.sqlite'));
  const media: AnalysisMedia[] = [{ id: 'ocr', path: ocrFile, fileName: '文字识别测试.png', kind: 'image', size: (await fs.stat(ocrFile)).size, mtimeMs: 1, missing: false, tags: [] }, { id: 'cat', path: catFile, fileName: 'cat.jpg', kind: 'image', size: (await fs.stat(catFile)).size, mtimeMs: 1, missing: false, tags: [] }];
  const makeService = () => new IntelligenceService({ dataDir: root, db, resourceDir: path.resolve('resources/ai'), getMedia: ids => media.filter(item => !ids || ids.includes(item.id)), getAnalysisImage: async id => media.find(item => item.id === id)!.path });
  const service = makeService(); await service.initialize(); await service.setupModels({ directory: root }); await service.waitForIdle();
  assert.equal(service.getState().indexed, 2); const textResult = await service.search({ query: '身份证', mode: 'text' }); assert.equal(textResult.hits[0]?.id, 'ocr');
  await service.close();
  const reopened = makeService(); await reopened.initialize();
  const contentResult = await reopened.search({ query: '猫', mode: 'content' }); assert.equal(contentResult.hits[0]?.id, 'cat');
  report.restartedSearch = { text: textResult, content: contentResult, modelState: reopened.getState().models }; await reopened.close(); db.close();
  report.checks.push('SQLite-backed OCR and image-content search survive an intelligence-service restart.');
  report.freshProcess = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('scripts/smoke-local-ai-offline.ts')], { windowsHide: true, env: { ...process.env, SHIGUANG_AI_TEST_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data.toString(); }); child.stderr.on('data', data => { errors += data.toString(); });
    child.on('error', reject); child.on('close', code => { if (code !== 0) reject(new Error(errors || output || `Offline child exited ${code}`)); else { try { resolve(JSON.parse(output.trim())); } catch (error) { reject(error); } } });
  });
  report.checks.push('A fresh Node process searches both OCR text and image content with network requests disabled.');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error); process.exitCode = 1; console.error(error); }
finally { await engine.close(); report.finishedAt = new Date().toISOString(); await fs.mkdir('docs/acceptance', { recursive: true }); await fs.writeFile('docs/acceptance/local-ai-real-report.json', JSON.stringify(report, null, 2)); }
