import { computeWallLayout, type LayoutInput, type Rect, type WallOptions } from './index';

export interface InfiniteInstance extends Rect {
  instanceId: string; mediaId: string; aspectRatio: number;
  groupId: string; groupBounds: Rect; repeatX: number; repeatY: number;
}
interface Node { bounds: Rect; start: number; end: number; parent?: Node }
interface Slot extends Rect { mediaId: string; aspectRatio: number; node: Node; group: Node }
interface FocusPlan { instances: InfiniteInstance[]; ids: Set<string>; byId: Map<string, InfiniteInstance>; buckets: Map<string, number[]> }
export interface InfiniteWallModel {
  width: number; height: number; averageTileArea: number; slotCount: number; mediaCount: number;
  /** Geometry and its index are created once; camera queries touch only intersecting buckets. */
  readonly slots: Slot[]; readonly bucketSize: number; readonly buckets: Map<string, number[]>;
  readonly root?: Node; readonly gap: number;
  focusCache?: { key: string; plan: FocusPlan };
}
export interface InfiniteQueryOptions {
  focusInstanceId?: string | null; focusSize?: { width: number; height: number };
  limit?: number; priorityBounds?: Rect;
}
const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const shifted = (rect: Rect, x: number, y: number): Rect => ({ x: rect.x + x, y: rect.y + y, width: rect.width, height: rect.height });
const hash = (input: number) => { let n = Math.imul(input ^ (input >>> 16), 0x45d9f3b); n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); return (n ^ (n >>> 16)) >>> 0; };
const positive = (value: number | undefined, fallback: number) => Number.isFinite(value) && value! > 0 ? value! : fallback;

/** A complete rectangular partition, including the padded slots of very small collections. */
function partition(weights: number[], bounds: Rect, seed: number, place: (index: number, rect: Rect, node: Node) => void): Node {
  const prefix = [0]; for (const weight of weights) prefix.push(prefix[prefix.length - 1] + weight);
  function divide(start: number, end: number, rect: Rect, parent?: Node): Node {
    const node: Node = { bounds: rect, start, end, parent };
    if (end - start === 1) { place(start, rect, node); return node; }
    const middle = (start + end) >>> 1, share = (prefix[middle] - prefix[start]) / (prefix[end] - prefix[start]);
    const across = rect.width === rect.height ? (hash(seed + start + end) & 1) === 0 : rect.width > rect.height;
    const first = across ? { ...rect, width: rect.width * share } : { ...rect, height: rect.height * share };
    const second = across ? { ...rect, x: rect.x + first.width, width: rect.width - first.width } : { ...rect, y: rect.y + first.height, height: rect.height - first.height };
    divide(start, middle, first, node); divide(middle, end, second, node); return node;
  }
  return divide(0, weights.length, bounds);
}
function inset(rect: Rect, gap: number): Rect {
  const g = Math.min(gap / 2, rect.width / 4, rect.height / 4);
  return { x: rect.x + g, y: rect.y + g, width: rect.width - g * 2, height: rect.height - g * 2 };
}
function spatialIndex(tiles: Rect[], size: number): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  tiles.forEach((tile, index) => {
    for (let y = Math.floor(tile.y / size); y <= Math.floor((tile.y + tile.height) / size); y++)
      for (let x = Math.floor(tile.x / size); x <= Math.floor((tile.x + tile.width) / size); x++) {
        const key = `${x},${y}`, values = buckets.get(key); if (values) values.push(index); else buckets.set(key, [index]);
      }
  });
  return buckets;
}

export function createInfiniteWallLayout(input: LayoutInput[], options: WallOptions): InfiniteWallModel {
  const items = [...new Map(input.map(item => [item.id, item])).values()];
  const unit = Math.max(32, positive(options.unit, 120)), gap = Math.min(Math.max(0, options.gap || 0), unit / 3);
  if (!items.length) return { width: 0, height: 0, averageTileArea: unit * unit * 5.2, slotCount: 0, mediaCount: 0, slots: [], bucketSize: unit * 4, buckets: new Map(), gap };
  const count = Math.max(9, items.length), area = count * unit * unit * 5.2;
  const width = Math.sqrt(area * 1.5), height = area / width;
  let importance: Map<string, number> | undefined;
  if (options.sizingMode && options.sizingMode !== 'balanced') {
    // Reuse our finite layout's global area budgets, rather than normalising separate groups.
    const weighted = computeWallLayout(items, { ...options, gap: 0 });
    const minimum = Math.min(...weighted.tiles.map(tile => tile.width * tile.height));
    importance = new Map(weighted.tiles.map(tile => [tile.id, tile.width * tile.height / minimum]));
  }
  const source = Array.from({ length: count }, (_, index) => items[index % items.length]);
  const pattern = [4, 1.2, 2.4, 1, 3.2, 1.6, 2, 1.1, 2.8];
  const weights = source.map((item, index) => importance?.get(item.id) ?? pattern[(index + hash(options.seed)) % pattern.length]);
  const slots: Slot[] = [];
  const root = partition(weights, { x: 0, y: 0, width, height }, options.seed, (index, rect, node) => {
    let group = node; while (group.parent && group.parent.end - group.parent.start <= 12) group = group.parent;
    const item = source[index]; slots[index] = { ...inset(rect, gap), mediaId: item.id, aspectRatio: Math.max(.01, Math.min(100, (item.width || 1) / (item.height || 1))), node, group };
  });
  return { width, height, averageTileArea: area / count, slotCount: count, mediaCount: items.length, slots, root, gap, bucketSize: unit * 4, buckets: spatialIndex(slots, unit * 4) };
}

function originalInstance(model: InfiniteWallModel, id: string): InfiniteInstance | undefined {
  const match = /^(-?\d+):(-?\d+):(\d+)$/.exec(id); if (!match) return;
  const repeatX = Number(match[1]), repeatY = Number(match[2]), index = Number(match[3]);
  if (![repeatX, repeatY, index].every(Number.isSafeInteger)) return;
  const slot = model.slots[index]; if (!slot) return;
  const dx = repeatX * model.width, dy = repeatY * model.height;
  return { ...shifted(slot, dx, dy), mediaId: slot.mediaId, aspectRatio: slot.aspectRatio, instanceId: id, repeatX, repeatY, groupId: `${repeatX}:${repeatY}:g${slot.group.start}-${slot.group.end}`, groupBounds: shifted(slot.group.bounds, dx, dy) };
}
function makeFocusPlan(model: InfiniteWallModel, id: string, size?: { width: number; height: number }): FocusPlan | undefined {
  const active = originalInstance(model, id); if (!active || !model.root) return;
  const wanted = { width: positive(size?.width, active.width * 1.9), height: positive(size?.height, active.height * 1.9) };
  const key = `${id}|${wanted.width}|${wanted.height}`; if (model.focusCache?.key === key) return model.focusCache.plan;
  const slot = model.slots[Number(id.split(':')[2])];
  let region = slot.node;
  while (region.parent && (region.end - region.start < 5 || region.bounds.width < wanted.width + model.gap * 2 + 80 || region.bounds.height < wanted.height + model.gap * 2 + 80)) region = region.parent;
  let bounds = shifted(region.bounds, active.repeatX * model.width, active.repeatY * model.height);
  const originals: InfiniteInstance[] = [];
  if (bounds.width >= wanted.width + 80 && bounds.height >= wanted.height + 80) {
    for (let index = region.start; index < region.end; index++) originals.push(originalInstance(model, `${active.repeatX}:${active.repeatY}:${index}`)!);
  } else {
    // A small album may need neighboring periods for a large focused image. The border of
    // this rectangle stays fixed, so the rest of the infinite wall remains unchanged.
    const rx = Math.max(1, Math.ceil(wanted.width / model.width / 2)), ry = Math.max(1, Math.ceil(wanted.height / model.height / 2));
    bounds = { x: (active.repeatX - rx) * model.width, y: (active.repeatY - ry) * model.height, width: (rx * 2 + 1) * model.width, height: (ry * 2 + 1) * model.height };
    for (let y = active.repeatY - ry; y <= active.repeatY + ry; y++) for (let x = active.repeatX - rx; x <= active.repeatX + rx; x++)
      for (let index = 0; index < model.slotCount; index++) originals.push(originalInstance(model, `${x}:${y}:${index}`)!);
  }
  const focus: Rect = { x: bounds.x + (bounds.width - wanted.width) / 2, y: bounds.y + (bounds.height - wanted.height) / 2, ...wanted };
  const left = focus.x - bounds.x, top = focus.y - bounds.y;
  const regions: Rect[] = [
    { x: bounds.x, y: bounds.y, width: bounds.width, height: top },
    { x: bounds.x, y: focus.y + focus.height, width: bounds.width, height: top },
    { x: bounds.x, y: focus.y, width: left, height: focus.height },
    { x: focus.x + focus.width, y: focus.y, width: left, height: focus.height },
  ].sort((a, b) => b.width * b.height - a.width * a.height);
  const others = originals.filter(instance => instance.instanceId !== id), instances: InfiniteInstance[] = [];
  const total = regions.reduce((sum, rect) => sum + rect.width * rect.height, 0);
  let cursor = 0;
  regions.forEach((rect, index) => {
    const remaining = others.length - cursor, count = index === regions.length - 1 ? remaining : Math.max(1, Math.min(remaining - (regions.length - index - 1), Math.round(others.length * rect.width * rect.height / total)));
    const batch = others.slice(cursor, cursor + count); cursor += count;
    if (!batch.length) return;
    partition(batch.map(item => item.width * item.height), rect, index, (i, placed) => instances.push({ ...batch[i], ...inset(placed, model.gap), groupId: `focus-${id}`, groupBounds: bounds }));
  });
  instances.push({ ...active, ...inset(focus, model.gap), groupId: `focus-${id}`, groupBounds: bounds });
  const plan = { instances, ids: new Set(originals.map(instance => instance.instanceId)), byId: new Map(instances.map(instance => [instance.instanceId, instance])), buckets: spatialIndex(instances, model.bucketSize) };
  model.focusCache = { key, plan }; return plan;
}

export function getInfiniteInstance(model: InfiniteWallModel, id: string, options: InfiniteQueryOptions = {}): InfiniteInstance | undefined {
  const plan = options.focusInstanceId ? makeFocusPlan(model, options.focusInstanceId, options.focusSize) : undefined;
  return plan?.byId.get(id) ?? originalInstance(model, id);
}

/** Enumerate a bounded set of cells around the actual query coordinates, including negatives. */
function cells(bounds: Rect, width: number, height: number, budget: number, priority: Rect): { x: number; y: number }[] {
  let left = Math.floor(bounds.x / width), right = Math.floor((bounds.x + bounds.width) / width), top = Math.floor(bounds.y / height), bottom = Math.floor((bounds.y + bounds.height) / height);
  const cx = (priority.x + priority.width / 2) / width, cy = (priority.y + priority.height / 2) / height;
  const cols = right - left + 1, rows = bottom - top + 1;
  if (cols * rows > budget) {
    const ncols = Math.max(1, Math.min(cols, Math.floor(Math.sqrt(budget * cols / rows)))), nrows = Math.max(1, Math.min(rows, Math.floor(budget / ncols)));
    left = Math.max(left, Math.min(right - ncols + 1, Math.floor(cx - ncols / 2))); right = left + ncols - 1;
    top = Math.max(top, Math.min(bottom - nrows + 1, Math.floor(cy - nrows / 2))); bottom = top + nrows - 1;
  }
  const result = []; for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) result.push({ x, y });
  return result.sort((a, b) => (a.x + .5 - cx) ** 2 + (a.y + .5 - cy) ** 2 - (b.x + .5 - cx) ** 2 - (b.y + .5 - cy) ** 2);
}
function candidates(buckets: Map<string, number[]>, bounds: Rect, size: number, limit: number, priority: Rect): Set<number> {
  const indices = new Set<number>();
  for (const cell of cells(bounds, size, size, limit * 12, priority)) {
    for (const index of buckets.get(`${cell.x},${cell.y}`) ?? []) indices.add(index);
    if (indices.size >= limit * 5) break;
  }
  return indices;
}
export function queryInfiniteWall(model: InfiniteWallModel, bounds: Rect, options: InfiniteQueryOptions = {}): InfiniteInstance[] {
  if (!model.slotCount || bounds.width <= 0 || bounds.height <= 0 || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return [];
  const limit = Math.max(1, Math.min(400, Math.floor(options.limit ?? 400))), priority = options.priorityBounds ?? bounds;
  const plan = options.focusInstanceId ? makeFocusPlan(model, options.focusInstanceId, options.focusSize) : undefined;
  const result: InfiniteInstance[] = [];
  if (plan) for (const index of candidates(plan.buckets, bounds, model.bucketSize, limit, priority)) { const instance = plan.instances[index]; if (intersects(instance, bounds)) result.push(instance); }
  for (const repeat of cells(bounds, model.width, model.height, Math.max(9, limit), priority)) {
    const dx = repeat.x * model.width, dy = repeat.y * model.height;
    const local = { ...bounds, x: Math.max(0, bounds.x - dx), y: Math.max(0, bounds.y - dy), width: Math.min(model.width, bounds.x + bounds.width - dx) - Math.max(0, bounds.x - dx), height: Math.min(model.height, bounds.y + bounds.height - dy) - Math.max(0, bounds.y - dy) };
    const localPriority = shifted(priority, -dx, -dy);
    for (const index of candidates(model.buckets, local, model.bucketSize, limit, localPriority)) {
      const id = `${repeat.x}:${repeat.y}:${index}`; if (plan?.ids.has(id)) continue;
      const instance = originalInstance(model, id)!; if (intersects(instance, bounds)) result.push(instance);
    }
    if (result.length >= limit * 5) break;
  }
  const cx = priority.x + priority.width / 2, cy = priority.y + priority.height / 2;
  return result.sort((a, b) => Number(!intersects(a, priority)) - Number(!intersects(b, priority)) || ((a.x + a.width / 2 - cx) ** 2 + (a.y + a.height / 2 - cy) ** 2) - ((b.x + b.width / 2 - cx) ** 2 + (b.y + b.height / 2 - cy) ** 2)).slice(0, limit);
}
