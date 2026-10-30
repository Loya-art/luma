import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { computeWallLayout, computeGridLayout, focusWallLayout, type LayoutResult } from '../src/layout/index';
const items=(n:number)=>Array.from({length:n},(_,i)=>({id:String(i),width:[800,400,1600,200,1200][i%5],height:[600,900,400,1800,1200][i%5]}));
function validate(layout:LayoutResult,n:number){
  assert.equal(layout.tiles.length,n);assert.equal(new Set(layout.tiles.map(t=>t.id)).size,n);
  for(const t of layout.tiles){assert.ok(t.width>0&&t.height>0);assert.ok(t.x>=-0.001&&t.y>=-0.001);assert.ok(t.x+t.width<=layout.width+0.001);assert.ok(t.y+t.height<=layout.height+0.001);}
  for(let i=0;i<layout.tiles.length;i++)for(let j=i+1;j<layout.tiles.length;j++){
    const a=layout.tiles[i],b=layout.tiles[j];assert.ok(a.x+a.width<=b.x+0.001||b.x+b.width<=a.x+0.001||a.y+a.height<=b.y+0.001||b.y+b.height<=a.y+0.001,`overlap ${a.id} / ${b.id}`);
  }
}
test('wall and focus place every item exactly once without overlaps for small and partial groups',()=>{
  for(const n of [0,1,2,3,4,5,8,9,10,17,18,27,65])for(const seed of [0,17,1234]){
    const layout=computeWallLayout(items(n),{seed,gap:8});validate(layout,n);
    for(const id of ['0',String(n-1)])validate(focusWallLayout(layout,id),n);
  }
});
test('seed is deterministic and completed groups remain anchored when appending',()=>{
  const a=computeWallLayout(items(27),{seed:5,gap:8});assert.deepEqual(a,computeWallLayout(items(27),{seed:5,gap:8}));
  assert.notDeepEqual(a,computeWallLayout(items(27),{seed:11,gap:8}));
  assert.deepEqual(a.tiles,computeWallLayout(items(40),{seed:5,gap:8}).tiles.slice(0,27));
});
test('grid contains whole photos proportionally, and mosaic grid has no overlaps',()=>{
  for(const width of [340,800,1600])for(const n of [0,1,2,9,26])for(const fit of ['contain','cover'] as const){
    const input=items(n),layout=computeGridLayout(input,{width,gap:8,targetHeight:220,fit,seed:3});validate(layout,n);
    if(fit==='contain')for(const t of layout.tiles){const source=input.find(i=>i.id===t.id)!;assert.ok(Math.abs(t.width/t.height-source.width/source.height)<0.00001);}
  }
});
test('thirty thousand records have bounded computation time and unique IDs',()=>{
  const start=performance.now(),result=computeWallLayout(items(30_000),{seed:17,gap:8});const elapsed=performance.now()-start;
  assert.equal(result.tiles.length,30_000);assert.equal(new Set(result.tiles.map(t=>t.id)).size,30_000);assert.ok(elapsed<3000,`layout took ${elapsed.toFixed(0)} ms`);
  console.log(`30,000-item wall layout: ${elapsed.toFixed(1)} ms`);
});

test('weighted layouts change photo area for views, capture recency and file size', () => {
  const today = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const input = Array.from({ length: 24 }, (_, index) => ({
    id: String(index), width: 1000, height: 800,
    openCount: index === 0 ? 100 : 0,
    takenAt: index === 0 ? today : today - 86_400_000 * 720,
    mtimeMs: today - 86_400_000 * 900,
    size: index === 0 ? 200_000_000 : 50_000,
  }));
  for (const sizingMode of ['views', 'recent', 'bytes'] as const) {
    const wall = computeWallLayout(input, { seed: 17, gap: 8, sizingMode });
    const grid = computeGridLayout(input, { width: 1100, gap: 8, targetHeight: 220, fit: 'cover', seed: 17, sizingMode });
    for (const layout of [wall, grid]) {
      validate(layout, input.length);
      const high = layout.tiles.find(tile => tile.id === '0')!;
      const others = layout.tiles.filter(tile => tile.id !== '0');
      const minimumRatio = Math.min(...others.map(tile => high.width * high.height / (tile.width * tile.height)));
      assert.ok(minimumRatio > 3, `${sizingMode}: important photo should visibly grow (${minimumRatio})`);
      assert.deepEqual(layout === wall ? computeWallLayout(input, { seed: 17, gap: 8, sizingMode }) : computeGridLayout(input, { width: 1100, gap: 8, targetHeight: 220, fit: 'cover', seed: 17, sizingMode }), layout);
      validate(focusWallLayout(layout, '0'), input.length);
    }
    assert.notDeepEqual(wall, computeWallLayout(input, { seed: 18, gap: 8, sizingMode }));
  }
});

test('weighted budgets are global, monotonic and stable for equal or missing values', () => {
  const today = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const input = Array.from({ length: 36 }, (_, index) => ({
    id: String(index), width: 1200, height: 800,
    openCount: index, takenAt: today - (35 - index) * 86_400_000 * 20,
    mtimeMs: today - (35 - index) * 86_400_000 * 20,
    size: 10_000 * Math.pow(1.25, index),
  }));
  for (const sizingMode of ['views', 'recent', 'bytes'] as const) {
    for (const result of [computeWallLayout(input, { seed: 2, gap: 0, sizingMode }), computeGridLayout(input, { width: 1000, targetHeight: 200, fit: 'contain', gap: 0, seed: 2, sizingMode })]) {
      const areas = new Map(result.tiles.map(tile => [tile.id, tile.width * tile.height]));
      for (let index = 1; index < 32; index++) assert.ok(areas.get(String(index))! > areas.get(String(index - 1))!, `${sizingMode}: ${index} is larger than ${index - 1}`);
    }
    for (const count of [0, 1, 2, 5, 12, 13, 40]) {
      const equal = items(count).map(item => ({ ...item, openCount: 0, size: 1000, takenAt: today }));
      const result = computeWallLayout(equal, { seed: 2, gap: 0, sizingMode });
      validate(result, count);
      const areas = result.tiles.map(tile => tile.width * tile.height);
      if (areas.length) assert.ok(Math.max(...areas) - Math.min(...areas) < .001);
    }
  }
  const fallback = input.map(item => ({ ...item, takenAt: null }));
  assert.deepEqual(computeWallLayout(fallback, { seed: 2, gap: 0, sizingMode: 'recent' }), computeWallLayout(input.map(item => ({ ...item, takenAt: item.mtimeMs })), { seed: 2, gap: 0, sizingMode: 'recent' }));
});

test('weighted layouts handle thirty thousand records in each mode', () => {
  const input = items(30_000).map((item, index) => ({ ...item, openCount: index % 100, size: 10_000 + index * 1000, mtimeMs: 1_700_000_000_000 + index * 86_400_000 }));
  for (const sizingMode of ['views', 'recent', 'bytes'] as const) {
    const start = performance.now();
    const result = computeWallLayout(input, { seed: 17, gap: 8, sizingMode });
    const elapsed = performance.now() - start;
    assert.equal(result.tiles.length, input.length);
    assert.equal(new Set(result.tiles.map(tile => tile.id)).size, input.length);
    assert.ok(elapsed < 3000, `${sizingMode} took ${elapsed.toFixed(0)}ms`);
    console.log(`30,000-item ${sizingMode} layout: ${elapsed.toFixed(1)} ms`);
  }
});
