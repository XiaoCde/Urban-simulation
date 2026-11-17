/**
 * tools/build_city_drive_net.mjs — 从真实 OSM 道路烘焙「全城车行图」。
 *
 * 背景：运行时 roadnet 只铺了中心 540×1090 m 的模块化瓦片（main.js 的 R），
 * traffic.js 的 net.edges 就只有这 1120 条边 —— 96 辆车 100% 挤在 8 个
 * 500m 网格里，全城其它片区一辆车都没有。而 data/streets/dc_streets.json
 * 里的 24660 条 way 覆盖 x -882..4308 / planY -597..3853，正是全城路网。
 *
 * 这里离线把「机动车道」抽成节点/边图，运行时由 city-drive-net.js 载入并
 * 并入 ROADNET，车就能沿真实道路在全城跑，不用再渲染 5 万块瓦片。
 *
 * 输出：web/assets/roads/city_drive_net.json
 *   { meta, nodes: [[x,z],...], edges: [[a,b,bit],...] }
 *   bit: 1=东西向、8=南北向（与 roadnet.js 的 E/N/W/S 位、traffic.isRed 一致）
 *
 * 用法：node tools/build_city_drive_net.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname || dirname(new URL(import.meta.url).pathname), '..');
const SRC = resolve(ROOT, 'data/streets/dc_streets.json');
const OUT = resolve(ROOT, 'web/assets/roads/city_drive_net.json');

// 只取机动车道；service（小区内部路）按片区限量保留，让住宅区也有车能开进去。
const KEEP = /^profile_roads_(motorway|trunk|primary|secondary|tertiary|residential|unclassified)$/;
const SERVICE_KEEP_RATIO = 0.16;   // service 共 3086 条，只留 1/6 避免图爆炸
const MIN_SEG = 16;                // m，抽稀最小段长
const SNAP = 5;                    // m，节点量化合并网格
const MAX_EDGE = 140;              // m，超过就切段（长直路也要有中间节点）
const LINK = 30;                   // m，不同 way 的端点在此距离内视为同一路口

const d = JSON.parse(readFileSync(SRC, 'utf8'));
const keyOf = (x, y) => Math.round(x / SNAP) + ':' + Math.round(y / SNAP);
const nodeIdx = new Map();
const nodes = [];
const edges = [];
const endpoints = new Set();   // way 的首尾节点：只有它们参与「路口对齐」合并
const seenEdge = new Set();

function nodeAt(x, y) {
  // plan (x,y) -> three (x, z=-y)
  const k = keyOf(x, y);
  let i = nodeIdx.get(k);
  if (i !== undefined) return i;
  i = nodes.length;
  nodeIdx.set(k, i);
  nodes.push([+x.toFixed(1), +(-y).toFixed(1)]);
  return i;
}
function addEdge(a, b) {
  if (a === b) return;
  const k = a < b ? a + '_' + b : b + '_' + a;
  if (seenEdge.has(k)) return;
  seenEdge.add(k);
  const [ax, az] = nodes[a], [bx, bz] = nodes[b];
  const dx = Math.abs(bx - ax), dz = Math.abs(bz - az);
  if (Math.hypot(dx, dz) < 1) return;
  edges.push([a, b, dx >= dz ? 1 : 8]);
}

let waysUsed = 0, serviceUsed = 0, ptsUsed = 0;
for (let wi = 0; wi < d.ways.length; wi++) {
  const w = d.ways[wi];
  const prof = String(w.prof || '');
  let keep = KEEP.test(prof);
  if (!keep && prof === 'profile_roads_service') {
    // 均匀抽样：保证全城各片区都有支路，不是只留某一个角落
    if (((wi * 2654435761) >>> 0) / 4294967296 < SERVICE_KEEP_RATIO) {
      keep = true; serviceUsed++;
    }
  }
  if (!keep || !Array.isArray(w.pts) || w.pts.length < 2) continue;
  waysUsed++;
  // 抽稀 + 长边切段：保留折线形状，但别让一个边跨 300 m
  const chain = [];
  let last = null;
  for (const [px, py] of w.pts) {
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    ptsUsed++;
    if (last) {
      const L = Math.hypot(px - last[0], py - last[1]);
      if (L < MIN_SEG && chain.length) continue;
      if (L > MAX_EDGE) {
        const n = Math.ceil(L / MAX_EDGE);
        for (let s = 1; s <= n; s++) {
          const t = s / n;
          chain.push([last[0] + (px - last[0]) * t, last[1] + (py - last[1]) * t]);
        }
        last = [px, py];
        continue;
      }
    }
    chain.push([px, py]);
    last = [px, py];
  }
  if (chain.length < 2) continue;
  let prev = nodeAt(chain[0][0], chain[0][1]);
  endpoints.add(prev);
  for (let i = 1; i < chain.length; i++) {
    const cur = nodeAt(chain[i][0], chain[i][1]);
    addEdge(prev, cur);
    prev = cur;
  }
  endpoints.add(prev);
}

// ---- 路口对齐：OSM 相邻道路端点常差 5~25 m，不合并就是一堆断头路。
// 只在「端点」之间做近邻并查集，避免把两条平行主路的中段误焊成假路口。
const parent = new Int32Array(nodes.length);
for (let i = 0; i < parent.length; i++) parent[i] = i;
const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
const cellOf = (x, z) => Math.floor(x / LINK) + ':' + Math.floor(z / LINK);
const cells = new Map();
const ep = [...endpoints];
for (const i of ep) {
  const [x, z] = nodes[i];
  const k = cellOf(x, z);
  if (!cells.has(k)) cells.set(k, []);
  cells.get(k).push(i);
}
for (const i of ep) {
  const [x, z] = nodes[i];
  const cx = Math.floor(x / LINK), cz = Math.floor(z / LINK);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const arr = cells.get((cx + dx) + ':' + (cz + dz));
    if (!arr) continue;
    for (const j of arr) {
      if (j === i) continue;
      const [ox, oz] = nodes[j];
      if (Math.hypot(x - ox, z - oz) <= LINK) union(i, j);
    }
  }
}
// 用并查集根重建节点/边，去掉自环与重复边
const rootMap = new Map();
const finNodes = [];
for (const [a, b] of edges) {
  for (const u of [find(a), find(b)]) {
    if (!rootMap.has(u)) {
      rootMap.set(u, finNodes.length);
      finNodes.push(nodes[u]);
    }
  }
}
const finEdgeSet = new Set();
const finEdges = [];
for (const [a, b, bit] of edges) {
  const ra = rootMap.get(find(a)), rb = rootMap.get(find(b));
  if (ra === rb) continue;
  const k = ra < rb ? ra + '_' + rb : rb + '_' + ra;
  if (finEdgeSet.has(k)) continue;
  finEdgeSet.add(k);
  finEdges.push([ra, rb, bit]);
}

let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
for (const [x, z] of finNodes) {
  if (x < minx) minx = x; if (x > maxx) maxx = x;
  if (z < minz) minz = z; if (z > maxz) maxz = z;
}
const out = {
  meta: {
    source: 'data/streets/dc_streets.json',
    note: '真实 OSM 机动车道的节点/边图；plan(x,y) -> three(x,z=-y)',
    coord: 'three x,z (meters)',
    bit: { 1: 'EW', 8: 'NS' },
    waysUsed, serviceUsed, ptsUsed,
    nodes: finNodes.length, edges: finEdges.length,
    bbox: { minx: +minx.toFixed(0), maxx: +maxx.toFixed(0),
      minz: +minz.toFixed(0), maxz: +maxz.toFixed(0) },
  },
  nodes: finNodes,
  edges: finEdges,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.log('[city-drive-net]', JSON.stringify(out.meta, null, 2));
console.log('written', OUT);
