/** Independent geometry for the album. No UI or media decoding occurs here. */
export type SizingMode = 'balanced' | 'views' | 'recent' | 'bytes';
export interface LayoutInput {
  id: string;
  width: number;
  height: number;
  openCount?: number;
  lastOpenedAt?: number | null;
  takenAt?: number | null;
  mtimeMs?: number;
  size?: number;
}
export interface Rect { x: number; y: number; width: number; height: number }
export interface LayoutTile extends Rect { id: string; groupId: string; groupBounds: Rect; aspectRatio: number }
export interface LayoutResult { tiles: LayoutTile[]; width: number; height: number }
export interface WallOptions { seed: number; gap: number; unit?: number; sizingMode?: SizingMode }
export interface GridOptions { width: number; gap: number; targetHeight: number; fit: 'contain' | 'cover'; seed: number; sizingMode?: SizingMode }
const ratio = (item: LayoutInput) => Math.max(0.01, Math.min(100, (item.width || 1) / (item.height || 1)));
const finite = (value: number, fallback: number, minimum = 0) => Number.isFinite(value) ? Math.max(minimum, value) : fallback;
const hash = (n: number) => { n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); return (n ^ (n >>> 16)) >>> 0; };
const templates: number[][][] = [
  [[0,0,6,6],[6,0,4,3],[6,3,2,3],[8,3,2,3],[0,6,3,4],[3,6,3,2],[3,8,3,2],[6,6,4,2],[6,8,4,2]],
  [[0,0,6,5],[6,0,4,5],[0,5,2,5],[2,5,4,3],[2,8,2,2],[4,8,2,2],[6,5,4,2],[6,7,2,3],[8,7,2,3]],
  [[0,0,4,7],[4,0,3,3],[7,0,3,3],[4,3,6,4],[0,7,2,3],[2,7,2,3],[4,7,2,3],[6,7,2,3],[8,7,2,3]],
];
function normalizedSlots(count: number, seed: number): Rect[] {
  let slots: Rect[];
  if (count === 9) slots = templates[hash(seed) % templates.length].map(([x,y,width,height]) => ({x:x/10,y:y/10,width:width/10,height:height/10}));
  else {
    slots = [{ x: 0, y: 0, width: 1, height: 1 }];
    while (slots.length < count) {
      let chosen = 0;
      for (let i=1;i<slots.length;i++) if (slots[i].width*slots[i].height > slots[chosen].width*slots[chosen].height) chosen = i;
      const rect = slots[chosen];
      const cut = [0.4,0.5,0.6][hash(seed+slots.length*37)%3];
      const horizontal = rect.width > rect.height || (rect.width === rect.height && (hash(seed+slots.length)&1)===0);
      const first = horizontal ? {...rect,width:rect.width*cut} : {...rect,height:rect.height*cut};
      const second = horizontal ? {...rect,x:rect.x+first.width,width:rect.width-first.width} : {...rect,y:rect.y+first.height,height:rect.height-first.height};
      slots.splice(chosen,1,first,second);
    }
  }
  const orientation = hash(seed+107) % 8;
  return slots.map(rect => {
    let {x,y,width,height}=rect;
    if (orientation&1) x=1-x-width;
    if (orientation&2) y=1-y-height;
    if (orientation&4) [x,y,width,height]=[y,x,height,width];
    return {x,y,width,height};
  });
}
function placeGroup(items: LayoutInput[], bounds: Rect, gap: number, seed: number, groupId: string): LayoutTile[] {
  if (!items.length) return [];
  const slots = normalizedSlots(items.length,seed).map(s => ({
    x: bounds.x+s.x*bounds.width+gap/2, y:bounds.y+s.y*bounds.height+gap/2,
    width:Math.max(1,s.width*bounds.width-gap),height:Math.max(1,s.height*bounds.height-gap),
  }));
  // Choose the image that needs the least aspect-ratio crop for each slot, largest first.
  const free = items.map((item,index)=>({item,index}));
  const result: LayoutTile[]=[];
  slots.sort((a,b)=>b.width*b.height-a.width*a.height);
  for (const slot of slots) {
    let best=0, cost=Infinity;
    for (let i=0;i<free.length;i++) {
      const score=Math.abs(Math.log(ratio(free[i].item)/(slot.width/slot.height))) + (hash(seed+free[i].index*47)%100)*0.00005;
      if(score<cost){cost=score;best=i;}
    }
    const {item}=free.splice(best,1)[0];
    result.push({...slot,id:item.id,groupId,groupBounds:bounds,aspectRatio:ratio(item)});
  }
  return result;
}
/** Expanding square shells preserve every existing group coordinate as new items arrive. */
function groupPosition(index: number): {x:number;y:number} {
  const side=Math.floor(Math.sqrt(index));
  const offset=index-side*side;
  return offset<=side ? {x:side,y:offset} : {x:2*side-offset,y:side};
}

interface WeightedItem { item: LayoutInput; weight: number; order: number }
const DAY = 86_400_000;

/**
 * Positive area budgets, relative to the visible collection. Logs prevent huge files or very
 * frequently opened photos swallowing the wall. The 90th percentile supplies the ordinary
 * upper scale; an isolated outlier falls back to the maximum. Every budget stays in [1, 4].
 * Equal/missing values get equal budgets. Recent uses the capture date, falling back to the
 * file date, with a 180-day half-life. Quantising today keeps geometry stable within a day.
 */
function weightedItems(items: LayoutInput[], mode: Exclude<SizingMode, 'balanced'>, seed: number): WeightedItem[] {
  const today = Math.floor(Date.now() / DAY) * DAY;
  const values = items.map(item => {
    if (mode === 'views') return Math.log1p(finite(item.openCount ?? 0, 0));
    if (mode === 'bytes') return Math.log1p(finite(item.size ?? 0, 0) / 1024);
    const captured = item.takenAt && Number.isFinite(item.takenAt) && item.takenAt > 0 ? item.takenAt : item.mtimeMs;
    if (!captured || !Number.isFinite(captured) || captured <= 0) return 0;
    const age = Math.max(0, today - captured);
    return Math.pow(2, -age / (180 * DAY));
  });
  const ordered = [...values].sort((a, b) => a - b);
  const low = ordered[0] ?? 0;
  const high = ordered[Math.max(0, Math.ceil(ordered.length * .9) - 1)] ?? low;
  const maximum = ordered[ordered.length - 1] ?? low;
  const scale = high > low ? high - low : maximum > low ? maximum - low : 1;
  return items.map((item, index) => {
    let key = seed | 0;
    for (let i = 0; i < item.id.length; i++) key = Math.imul(key ^ item.id.charCodeAt(i), 0x01000193);
    return { item, weight: 1 + 3 * Math.min(1, Math.max(0, (values[index] - low) / scale)), order: hash(key) };
  }).sort((a, b) => a.order - b.order || a.item.id.localeCompare(b.item.id));
}

/**
 * Independently written weighted binary partition. Each split divides the available rectangle
 * by the children's total budgets, so weights change actual photo area across the entire
 * library, rather than only choosing between a fixed set of large and small slots.
 * Splitting the longer axis also turns a tall scrolling field into compact horizontal bands.
 */
function weightedLayout(items: WeightedItem[], bounds: Rect, gap: number, seed: number): LayoutResult {
  const tiles: LayoutTile[] = [];
  const total = items.reduce((sum, entry) => sum + entry.weight, 0);
  const prefix = [0];
  for (const entry of items) prefix.push(prefix[prefix.length - 1] + entry.weight);
  function divide(start: number, end: number, rect: Rect, branch: string, localGroup?: { id: string; bounds: Rect }) {
    const count = end - start;
    if (!count) return;
    const group = localGroup ?? (count <= 12 ? { id: `weighted-${branch}`, bounds: rect } : undefined);
    if (count === 1) {
      const entry = items[start];
      const inset = Math.min(gap / 2, rect.width / 4, rect.height / 4);
      tiles.push({
        id: entry.item.id, x: rect.x + inset, y: rect.y + inset,
        width: Math.max(.01, rect.width - inset * 2), height: Math.max(.01, rect.height - inset * 2),
        groupId: group!.id, groupBounds: group!.bounds, aspectRatio: ratio(entry.item),
      });
      return;
    }
    const sum = prefix[end] - prefix[start];
    const half = prefix[start] + sum / 2;
    let left = start + 1, right = end - 1;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (prefix[middle] < half) left = middle + 1;
      else right = middle;
    }
    let cut = left;
    if (cut > start + 1 && Math.abs(prefix[cut - 1] - half) < Math.abs(prefix[cut] - half)) cut--;
    const share = (prefix[cut] - prefix[start]) / sum;
    const across = rect.width === rect.height ? (hash(seed + start + end) & 1) === 0 : rect.width > rect.height;
    const first = across ? { ...rect, width: rect.width * share } : { ...rect, height: rect.height * share };
    const second = across
      ? { ...rect, x: rect.x + first.width, width: rect.width - first.width }
      : { ...rect, y: rect.y + first.height, height: rect.height - first.height };
    divide(start, cut, first, `${branch}0`, group);
    divide(cut, end, second, `${branch}1`, group);
  }
  if (total > 0) divide(0, items.length, bounds, 'r');
  return { tiles, width: bounds.width, height: items.length ? bounds.height : 0 };
}

export function computeWallLayout(items: LayoutInput[], options: WallOptions): LayoutResult {
  const unit=finite(options.unit??120,120,32), gap=Math.min(finite(options.gap,8),unit/3);
  if (options.sizingMode && options.sizingMode !== 'balanced') {
    if (!items.length) return { tiles: [], width: 0, height: 0 };
    const weighted = weightedItems(items, options.sizingMode, options.seed);
    const area = items.length * unit * unit * 5.2;
    const width = Math.sqrt(area * 1.5);
    return weightedLayout(weighted, { x: 0, y: 0, width, height: area / width }, gap, options.seed);
  }
  const groupWidth=unit*7.5,groupHeight=unit*6.25;
  const tiles:LayoutTile[]=[]; let width=0,height=0;
  for(let start=0;start<items.length;start+=9){
    const group=Math.floor(start/9), pos=groupPosition(group);
    const bounds={x:pos.x*groupWidth,y:pos.y*groupHeight,width:groupWidth,height:groupHeight};
    tiles.push(...placeGroup(items.slice(start,start+9),bounds,gap,options.seed+group*977,`wall-${group}`));
    width=Math.max(width,bounds.x+bounds.width);height=Math.max(height,bounds.y+bounds.height);
  }
  return {tiles,width,height};
}
export function computeGridLayout(items: LayoutInput[], options: GridOptions): LayoutResult {
  const width=finite(options.width,1000,100),gap=Math.min(finite(options.gap,8),24),target=finite(options.targetHeight,240,60);
  if (options.sizingMode && options.sizingMode !== 'balanced') {
    const weighted = weightedItems(items, options.sizingMode, options.seed);
    return weightedLayout(weighted, { x: 0, y: 0, width, height: items.length * target * target / width }, gap, options.seed);
  }
  const tiles:LayoutTile[]=[];
  if(options.fit==='cover'){
    let y=0;
    const count=width<650?4:9;
    for(let start=0;start<items.length;start+=count){
      const batch=items.slice(start,start+count), row=Math.floor(start/count);
      const h=width<650?target*1.5:target*2.5;
      tiles.push(...placeGroup(batch,{x:0,y,width,height:h},gap,options.seed+row*977,`grid-${row}`));y+=h;
    }
    return {tiles,width,height:items.length?y:0};
  }
  let y=gap/2,index=0,rowIndex=0;
  while(index<items.length){
    const row:LayoutInput[]=[];let aspectSum=0;
    while(index<items.length){
      const item=items[index],a=ratio(item);
      if(row.length){
        const prev=Math.abs((width-gap*(row.length+1))/aspectSum-target);
        const next=Math.abs((width-gap*(row.length+2))/(aspectSum+a)-target);
        if(next>prev)break;
      }
      row.push(item);aspectSum+=a;index++;
      if((width-gap*(row.length+1))/aspectSum<=target)break;
    }
    const available=Math.max(1,width-gap*(row.length+1));
    let h=available/aspectSum;
    if(index===items.length) h=Math.min(h,target);
    // A very long screenshot/panorama remains proportional and readable in its own row.
    const bounds={x:0,y,width,height:h+gap};let x=gap;
    for(const item of row){const w=h*ratio(item);tiles.push({id:item.id,x,y,width:w,height:h,groupId:`row-${rowIndex}`,groupBounds:bounds,aspectRatio:ratio(item)});x+=w+gap;}
    y+=h+gap;rowIndex++;
  }
  return {tiles,width,height:items.length?y:0};
}
export function focusWallLayout(layout:LayoutResult,id:string):LayoutResult {
  const active=layout.tiles.find(t=>t.id===id); if(!active)return layout;
  const members=layout.tiles.filter(t=>t.groupId===active.groupId);
  if(members.length<2)return layout;
  const bounds=active.groupBounds;
  const gap=Math.max(2,Math.min(active.x-bounds.x,active.y-bounds.y,8));
  const vertical=active.aspectRatio<0.85;
  const focusBounds:Rect=vertical?{...bounds,width:bounds.width*0.57}:{...bounds,height:bounds.height*0.68};
  const restBounds:Rect=vertical?{...bounds,x:bounds.x+focusBounds.width,width:bounds.width-focusBounds.width}:{...bounds,y:bounds.y+focusBounds.height,height:bounds.height-focusBounds.height};
  const others=members.filter(t=>t.id!==id).map(t=>({id:t.id,width:t.aspectRatio,height:1}));
  const changes=placeGroup(others,restBounds,gap,71,active.groupId);
  changes.push({...active,x:focusBounds.x+gap/2,y:focusBounds.y+gap/2,width:focusBounds.width-gap,height:focusBounds.height-gap,groupBounds:bounds});
  const mapping=new Map(changes.map(t=>[t.id,{...t,groupBounds:bounds}]));
  return {...layout,tiles:layout.tiles.map(t=>mapping.get(t.id)??t)};
}
