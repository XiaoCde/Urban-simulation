// trapped.js 单元测试：可涉水连通域 / 主城判定 / 被困分类
import { createTrappedIndex, WADE_MAX, STATE } from './src/trapped.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg); }
}

// 栅格：cols x rows，step 6 m，x0=z0=0，scale=4 m（u8 255 = 4 m）
const cols = 20, rows = 20, step = 6, scale = 4;
function makeGrid(fn) {
  const data = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) data[r * cols + c] = Math.round(fn(c, r) / scale * 255);
  }
  return { data, cols, rows, step, x0: 0, z0: 0, scale };
}
const at = (c, r) => ({ x: c * step + 1, z: r * step + 1 });

console.log('WADE_MAX =', WADE_MAX, '(should be 0.30)');
ok(Math.abs(WADE_MAX - 0.30) < 1e-9, 'WADE_MAX 是 0.30 m');

// ---- 1) 全干：只有一块，都是主城
{
  const refuges = [];
  const idx = createTrappedIndex(refuges);
  idx.setGeom({ cols, rows, step_m: step, x0: 0, z0: 0, scale });
  const st = idx.update(makeGrid(() => 0), 'k1');
  ok(st.comps === 1, '全干时只有 1 个连通域');
  ok(idx.query(...Object.values(at(10, 10))) === STATE.SAFE, '全干时任何点都安全');
  ok(st.mainlandPct > 0.999, '全干时主城占 100%');
}

// ---- 2) 一条横向深水带把图切成上下两块；上面一块大得多 = 主城
{
  const refuges = [];
  const idx = createTrappedIndex(refuges);
  idx.setGeom({ cols, rows, step_m: step, x0: 0, z0: 0, scale });
  // 第 15 行深 1 m，其余干 -> 上 15 行 vs 下 5 行
  const st = idx.update(makeGrid((c, r) => (r === 15 ? 1.0 : 0)), 'k2');
  ok(st.comps === 2, '深水带把图切成 2 块');
  ok(st.islets === 1, '其中 1 块是孤岛');
  const up = at(10, 5), down = at(10, 18);
  ok(idx.query(up.x, up.z) === STATE.SAFE, '大的一侧是主城 -> SAFE');
  ok(idx.query(down.x, down.z) === STATE.TRAPPED, '小的孤岛、无避难所 -> TRAPPED');
}

// ---- 3) 孤岛上有避难所 -> ISLET_SAFE（活着但出不去）
{
  const refuges = [at(10, 18)];   // 孤岛正中
  const idx = createTrappedIndex(refuges);
  idx.setGeom({ cols, rows, step_m: step, x0: 0, z0: 0, scale });
  idx.update(makeGrid((c, r) => (r === 15 ? 1.0 : 0)), 'k3');
  const down = at(10, 18);
  ok(idx.query(down.x, down.z) === STATE.ISLET_SAFE, '孤岛上有避难所 -> ISLET_SAFE');
}

// ---- 4) 人站在深水里、四周无干格 -> DROWNING
{
  const idx = createTrappedIndex([]);
  idx.setGeom({ cols, rows, step_m: step, x0: 0, z0: 0, scale });
  idx.update(makeGrid(() => 1.0), 'k4');   // 全图 1 m 深
  const p = at(10, 10);
  ok(idx.query(p.x, p.z) === STATE.DROWNING, '全图深水 -> DROWNING');
}

// ---- 5) 30 cm 边界：正好 0.30 m 仍可通行，0.36 m 不可通行
{
  const idx = createTrappedIndex([]);
  idx.setGeom({ cols, rows, step_m: step, x0: 0, z0: 0, scale });
  // 第 10 列 0.30 m（阈值内），其余干
  let st = idx.update(makeGrid((c) => (c === 10 ? 0.30 : 0)), 'k5a');
  ok(st.comps === 1, `0.30 m 深仍算可涉水（comps=${st.comps}）`);
  // 第 10 列 0.36 m
  st = idx.update(makeGrid((c) => (c === 10 ? 0.36 : 0)), 'k5b');
  ok(st.comps === 2, `0.36 m 深切断通行（comps=${st.comps}）`);
}

// ---- 6) 1~3 格的小水洼不算孤岛（噪声过滤）
{
  const idx = createTrappedIndex([]);
  idx.setGeom({ cols, rows, step_m: step, x0: 0, z0: 0, scale });
  // 只在 (0,0) 一个格周围围一圈深水 -> 1 格孤岛
  const st = idx.update(makeGrid((c, r) => ((r <= 1 && c <= 1) && !(r === 0 && c === 0) ? 1.0 : 0)), 'k6');
  ok(st.islets === 0, '1 格孤岛被当作噪声忽略');
  const p = at(0, 0);
  ok(idx.query(p.x, p.z) === STATE.SAFE, '1 格孤岛上的人按安全处理（栅格噪声）');
}

// ---- 7) 同一帧重复调用走缓存、统计不被写坏
{
  const idx = createTrappedIndex([]);
  idx.setGeom({ cols, rows, step_m: step, x0: 0, z0: 0, scale });
  const g = makeGrid((c, r) => (r === 15 ? 1.0 : 0));
  const a = idx.update(g, 'same');
  const b = idx.update(g, 'same');
  ok(a.comps === b.comps && a.islets === b.islets, '同 key 重复调用结果一致（缓存生效）');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
