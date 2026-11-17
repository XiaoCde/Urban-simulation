/**
 * city-drive-net.js — 把「全城真实机动车道图」并入运行时 ROADNET。
 *
 * 中心 540×1090 m 的模块化瓦片路网负责视觉细节；外围没有瓦片，但旧 OSM
 * 路面带子仍在（clipOldRoads 只裁中心 R）。这里把离线烘焙的全城 OSM 车行
 * 节点/边补进 net.nodes / net.edges，于是：
 *   - traffic.js 的邻接表、BFS、nearestNode 自动覆盖全城
 *   - 车沿真实道路跑，不再全挤在中心 8 个 500m 网格
 *   - 不新增任何瓦片实例（6932 个节点只是逻辑点，不渲染）
 *
 * 中心瓦片图与全城图之间按最近距离补连接边，保证两套图互通。
 */
import * as THREE from 'three';

const URL = '/assets/roads/city_drive_net.json';
const LINK_R = 45;      // m，瓦片节点与全城节点的最大接续距离

/**
 * @param {object} net buildRoadNetwork 的返回值（会被就地扩展）
 * @param {object} o { terrain, world, draw=false }
 * @returns {Promise<{nodes:number,edges:number,bbox:object,links:number}>}
 */
export async function attachCityDriveNet(net, o = {}) {
  const { terrain = null, world = null, draw = false } = o;
  const res = await fetch(URL);
  if (!res.ok) throw new Error('city_drive_net.json 取回失败 ' + res.status);
  const data = await res.json();
  if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
    throw new Error('city_drive_net.json 结构异常');
  }

  const h = (x, z) => {
    if (terrain && typeof terrain.sampleHeight === 'function') {
      const y = terrain.sampleHeight(x, z);
      if (Number.isFinite(y)) return y;
    }
    return 0;
  };

  // ---- 全城节点：字段与 roadnet 的瓦片节点兼容 ----
  const cityNodes = data.nodes.map(([x, z], k) => {
    const y = h(x, z);
    return {
      i: 1000 + (k % 1000), j: 1000 + Math.floor(k / 1000),
      x, z, y, top: y, type: 'city', mask: 0,
      underBuilding: false, city: true,
    };
  });
  const cityEdges = data.edges.map(([a, b, bit]) => {
    const e = { a: cityNodes[a], b: cityNodes[b], bit: bit || 1, city: true };
    return e;
  }).filter((e) => e.a && e.b && e.a !== e.b);

  // ---- 与中心瓦片图接续：空间哈希找 <45m 的近邻，双向连边 ----
  const CELL = LINK_R;
  const cell = (x, z) => Math.floor(x / CELL) + ':' + Math.floor(z / CELL);
  const buckets = new Map();
  for (const n of net.nodes) {
    const k = cell(n.x, n.z);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(n);
  }
  const linkSeen = new Set();
  let links = 0;
  for (const cn of cityNodes) {
    const cx = Math.floor(cn.x / CELL), cz = Math.floor(cn.z / CELL);
    let best = null, bd = LINK_R * LINK_R;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const arr = buckets.get((cx + dx) + ':' + (cz + dz));
      if (!arr) continue;
      for (const tn of arr) {
        const d2 = (tn.x - cn.x) ** 2 + (tn.z - cn.z) ** 2;
        if (d2 < bd) { bd = d2; best = tn; }
      }
    }
    if (!best) continue;
    const key = best.i + '_' + best.j + '|' + cn.i + '_' + cn.j;
    if (linkSeen.has(key)) continue;
    linkSeen.add(key);
    cityEdges.push({ a: best, b: cn, bit: 8, city: true, link: true });
    links++;
  }

  // ---- 可选：把全城干道画成贴地细线，让「全城有路」在俯视时看得见 ----
  if (draw && world) {
    const pts = [];
    for (const e of cityEdges) {
      if (!e.city) continue;
      pts.push(e.a.x, e.a.top + 0.35, e.a.z, e.b.x, e.b.top + 0.35, e.b.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const m = new THREE.LineBasicMaterial({ color: 0x35506a, transparent: true, opacity: 0.42 });
    const lines = new THREE.LineSegments(g, m);
    lines.name = 'city_drive_net';
    lines.frustumCulled = false;
    world.add(lines);
  }

  // 就地扩展（traffic.js / drive-layer / route-brain 读的都是这几个数组引用）
  net.nodes.push(...cityNodes);
  net.edges.push(...cityEdges);
  if (Array.isArray(net.junctions)) {
    // 度数 >= 3 的全城节点也算路口（红绿灯相位用 i/j 区分）
    const deg = new Map();
    for (const e of cityEdges) {
      deg.set(e.a, (deg.get(e.a) || 0) + 1);
      deg.set(e.b, (deg.get(e.b) || 0) + 1);
    }
    for (const [n, d] of deg) if (d >= 3) net.junctions.push(n);
  }
  net.cityNet = {
    nodes: cityNodes.length, edges: cityEdges.length, links,
    bbox: data.meta && data.meta.bbox, source: data.meta && data.meta.source,
  };
  console.info(`[city-drive-net] 全城车行图已并入：${cityNodes.length} 节点 / `
    + `${cityEdges.length} 边 / ${links} 条接续边；总边数 ${net.edges.length}`);
  return net.cityNet;
}
