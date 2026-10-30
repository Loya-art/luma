import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createInfiniteWallLayout, getInfiniteInstance, queryInfiniteWall, type InfiniteInstance } from '../src/layout/infinite';
import type { Rect } from '../src/layout';

const inputs = (n:number) => Array.from({length:n},(_,i)=>({id:`photo-${i}`,width:[400,1600,800][i%3],height:[900,1000,600][i%3]}));
const area = (rect:Rect) => rect.width*rect.height;
function noOverlap(tiles:InfiniteInstance[]) {
  for(let i=0;i<tiles.length;i++)for(let j=i+1;j<tiles.length;j++) {
    const a=tiles[i],b=tiles[j];assert.ok(a.x+a.width<=b.x+.001||b.x+b.width<=a.x+.001||a.y+a.height<=b.y+.001||b.y+b.height<=a.y+.001,`overlap ${a.instanceId}/${b.instanceId}`);
  }
}
function covers(bounds:Rect,tiles:InfiniteInstance[]) {
  for(let y=bounds.y+3;y<bounds.y+bounds.height;y+=43)for(let x=bounds.x+3;x<bounds.x+bounds.width;x+=47)
    assert.ok(tiles.some(tile=>x>=tile.x-.001&&x<=tile.x+tile.width+.001&&y>=tile.y-.001&&y<=tile.y+tile.height+.001),`blank point ${x},${y}`);
}

test('one, three and ten photos repeat into a complete rectangular wall in every direction',()=>{
  for(const count of [1,3,10,26]) {
    const model=createInfiniteWallLayout(inputs(count),{seed:17,gap:0});
    assert.ok(model.slotCount>=9);assert.equal(model.mediaCount,count);
    assert.ok(Math.abs(model.slots.reduce((sum,tile)=>sum+area(tile),0)-model.width*model.height)<.01);
    assert.ok(Math.max(...model.slots.map(area))>Math.min(...model.slots.map(area))*2);
    for(const point of [{x:0,y:0},{x:-1700,y:-2000},{x:1_234_567,y:-8_765_432}]) {
      const bounds={...point,width:1440,height:960},tiles=queryInfiniteWall(model,bounds);
      assert.ok(tiles.length>count||count>20);assert.ok(tiles.length<=400);
      assert.equal(new Set(tiles.map(tile=>tile.instanceId)).size,tiles.length);
      assert.ok(tiles.every(tile=>inputs(count).some(item=>item.id===tile.mediaId)));
      noOverlap(tiles);covers(bounds,tiles);
      assert.deepEqual(queryInfiniteWall(model,bounds),tiles);
    }
  }
  assert.deepEqual(queryInfiniteWall(createInfiniteWallLayout([],{seed:0,gap:0}),{x:-100,y:-100,width:1000,height:700}),[]);
});

test('weighted infinite copies retain global photo area rules and fill their period',()=>{
  const now=Date.now();const items=inputs(24).map((item,index)=>({...item,openCount:index===0?100:0,size:index===0?200_000_000:50_000,takenAt:index===0?now:now-900*86_400_000}));
  for(const sizingMode of ['views','recent','bytes'] as const) {
    const model=createInfiniteWallLayout(items,{seed:7,gap:0,sizingMode});
    const high=model.slots.find(tile=>tile.mediaId===items[0].id)!;
    assert.ok(model.slots.filter(tile=>tile.mediaId!==items[0].id).every(tile=>area(high)>area(tile)*3));
    assert.ok(Math.abs(model.slots.reduce((sum,tile)=>sum+area(tile),0)-model.width*model.height)<.01);
    covers({x:-1100,y:3200,width:1500,height:1100},queryInfiniteWall(model,{x:-1100,y:3200,width:1500,height:1100}));
  }
});

test('focusing one instance repacks only its neighborhood without overlap or holes',()=>{
  for(const count of [1,3,10,80])for(const sizingMode of ['balanced','views'] as const) {
    const model=createInfiniteWallLayout(inputs(count).map((item,i)=>({...item,openCount:i})),{seed:17,gap:0,sizingMode});
    const id='-2:3:0',original=getInfiniteInstance(model,id)!;
    const options={focusInstanceId:id,focusSize:{width:640,height:800}};
    const focused=getInfiniteInstance(model,id,options)!;
    assert.equal(focused.instanceId,id);assert.ok(area(focused)>area(original));
    const farId='20:-20:0';assert.deepEqual(getInfiniteInstance(model,farId,options),getInfiniteInstance(model,farId));
    const bounds={x:focused.x-350,y:focused.y-350,width:1400,height:1450};
    const tiles=queryInfiniteWall(model,bounds,options);assert.equal(tiles.filter(tile=>tile.instanceId===id).length,1);
    if(count<=3)assert.ok(tiles.some(tile=>tile.mediaId===original.mediaId&&tile.instanceId!==id));
    noOverlap(tiles);covers(bounds,tiles);
    assert.equal(new Set(tiles.map(tile=>tile.instanceId)).size,tiles.length);
  }
});

test('viewport receives priority over overscan and all camera queries stay under 400 instances',()=>{
  const model=createInfiniteWallLayout(inputs(3),{seed:2,gap:0,unit:40});
  const priority={x:-1200,y:1600,width:1000,height:700};
  const tiles=queryInfiniteWall(model,{x:priority.x-15000,y:priority.y-15000,width:31000,height:30700},{priorityBounds:priority});
  assert.equal(tiles.length,400);covers(priority,tiles);
  assert.ok(queryInfiniteWall(model,{x:-1e12,y:1e12,width:1e9,height:1e9}).length<=400);
});

test('thirty thousand photos build once and camera movement queries only a bounded spatial index',()=>{
  const items=inputs(30_000).map((item,i)=>({...item,openCount:i%30}));
  for(const sizingMode of ['balanced','views'] as const) {
    const buildAt=performance.now(),model=createInfiniteWallLayout(items,{seed:2,gap:8,sizingMode});
    assert.equal(model.mediaCount,30_000);assert.ok(performance.now()-buildAt<3000);
    const start=performance.now();
    for(let i=0;i<100;i++) {
      const tiles=queryInfiniteWall(model,{x:-1_000_000+i*430,y:2_000_000-i*270,width:1500,height:1000});
      assert.ok(tiles.length>0&&tiles.length<=400);
    }
    const elapsed=performance.now()-start;assert.ok(elapsed<1500,`100 ${sizingMode} camera queries took ${elapsed.toFixed(0)}ms`);
    console.log(`30,000 ${sizingMode}: 100 indexed wall queries ${elapsed.toFixed(1)}ms`);
  }
});
