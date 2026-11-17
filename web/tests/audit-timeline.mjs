/**
 * 全天时间轴审计 —— 真的把 CLOCK 从 00:00 拖到 24:00，逐点核对
 * 「每个人 · 这一刻 · 做什么动作 · 站在哪个场景 · 渲染出来是什么」。
 *
 * 采样点 = 每 10 分钟 + 7 人 154 段的所有段边界。
 * 检查分四组：
 *   A 动作语义    clip / moving / kind / 睡觉 / 开车 / 室内姿势是否自洽
 *   B 场景归属    sceneId 是否存在、place 是否对应、室内外标记是否符合场景 kind
 *   C 三维坐标    楼层 y 是否与楼一致、赶路段有没有半空斜穿、有没有瞬移 / NaN
 *   D 社会层+渲染 24 路人的作息 / 场景 / 实际模型姿态与可见性
 * 报告写到 out/audit/timeline.json，控制台只打摘要 + 抽样示例。
 */
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 用脚本自身位置定位项目根，避免「从 web/ 目录跑」时拼成 web/web/...。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const story = JSON.parse(readFileSync(join(ROOT, 'web/assets/story/day_full.json'), 'utf8'));

const samples = [];
for (let m = 0; m < 1440; m += 10) samples.push(m);
for (const segs of Object.values(story.timeline)) {
  for (const s of segs) { samples.push(s.a, s.b - 1, s.b, s.a + 1); }
}
const minutes = [...new Set(samples.filter((m) => m >= 0 && m < 1440))].sort((a, b) => a - b);

mkdirSync(join(ROOT, 'out/audit'), { recursive: true });
const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await b.newPage();
await p.setViewport({ width: 900, height: 560 });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 120)); });
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
await p.evaluate(() => { window.__ready = false; });

const R = await p.evaluate(({ minutes, places, scenes }) => {
  const C = window.__clock, D = window.__dayMotion, CL = window.__crowdLife;
  const LIFE = window.__life, PED = window.__ped, PEOPLE = window.__people;
  const THREE = window.__THREE;
  const fit = window.__placeFit || {};
  const groundAt = (x, z) => (PED && PED.graph && PED.graph.groundAt)
    ? PED.graph.groundAt(x, z) : 0;
  const anchors = {};
  for (const o of (LIFE ? LIFE.group.children : [])) {
    anchors[o.name] = { x: o.position.x, y: o.position.y, z: o.position.z };
  }
  const sceneMeta = {};
  for (const s of scenes) sceneMeta[s.id] = { kind: s.kind, place: s.place, name: s.name };
  const builtIds = LIFE ? LIFE.sceneIds : [];

  const issues = [];
  const rows = [];           // 具名角色逐点明细
  const crowdRows = [];      // 24 路人逐点聚合
  const byCode = {};
  function bad(code, m, who, info) {
    issues.push({ code, m, who, info });
    byCode[code] = (byCode[code] || 0) + 1;
  }
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const WALK = new Set(['walk', 'run']);
  const STILL_KIND = new Set(['meal', 'desk', 'medical', 'teach', 'serve', 'talk', 'drive', 'sleep', 'ride']);
  const prevPos = {};

  C.setPlaying(false);
  for (const m of minutes) {
    C.seek(m);
    // 每 120 分钟真的推两帧，验证渲染层跟着时刻重放（不每点都推，否则 SwiftShader 太慢）
    if (m % 120 === 0 && window.__frame) window.__frame(0, 1);

    // ---------------- 7 个具名角色 ----------------
    for (const key of D.keys) {
      const q = D.at(key, m);
      if (!q) { bad('NO_STATE', m, key, 'at() 返回 null'); continue; }
      if (q.crisis) { rows.push({ m, key, crisis: true }); continue; }
      const P = places[q.place] || {};
      const F = fit[q.place] || {};
      const fh = Number.isFinite(F.floorH) ? F.floorH : 3.6;
      const base = Number.isFinite(F.baseY) ? F.baseY : groundAt(P.x || 0, P.z || 0);
      const gy = groundAt(q.x, q.z);
      const floorY = base + (q.floor - 1) * fh;
      const A = anchors[q.sceneId];
      const meta = sceneMeta[q.sceneId];
      const distFoot = Math.max(
        Math.abs(q.x - (P.x || 0)) - (P.w || 20) / 2,
        Math.abs(q.z - (P.z || 0)) - (P.d || 20) / 2, 0);

      rows.push({
        m, t: hhmm(m), key, seg: `${q.a}-${q.b}`, clip: q.clip, clipLabel: q.clipLabel,
        moving: q.moving, drifting: !!q.drifting, kind: q.kind, indoor: q.indoor,
        travel: !!q.travel, inTransit: !!q.inTransit,
        inVehicle: q.inVehicle, place: q.place, floor: q.floor, scene: q.sceneId,
        x: +q.x.toFixed(1), y: +q.y.toFixed(1), z: +q.z.toFixed(1),
        gy: +gy.toFixed(1), floorY: +floorY.toFixed(1),
        spot: (q.spot || '').slice(0, 20), act: (q.activity || '').slice(0, 20),
        anchorDist: A ? +Math.hypot(q.x - A.x, q.z - A.z, q.y - A.y).toFixed(1) : null,
      });

      // --- A 动作语义 ---
      if (!Number.isFinite(q.x) || !Number.isFinite(q.y) || !Number.isFinite(q.z))
        bad('NAN_POS', m, key, JSON.stringify([q.x, q.y, q.z]));
      if (WALK.has(q.clip) !== !!q.moving && !q.inVehicle)
        bad('CLIP_MOVE_MISMATCH', m, key, `clip=${q.clip} moving=${q.moving} kind=${q.kind}`);
      if (q.inVehicle && q.clip !== 'sit' && q.clip !== 'idle')
        bad('CAR_BAD_CLIP', m, key, `inVehicle clip=${q.clip}`);
      if (STILL_KIND.has(q.kind) && WALK.has(q.clip) && !q.drifting)
        bad('STILL_KIND_WALKING', m, key, `${q.kind} 播 ${q.clip} · ${(q.activity || '').slice(0, 16)}`);
      if (m < 360 && q.kind === 'sleep' && (q.moving || q.drifting))
        bad('SLEEP_WALKING', m, key, `深夜睡觉却在动 clip=${q.clip}`);
      if (q.indoor === false && !q.inVehicle && (q.clip === 'sit')
        && !/sc_street|sc_road|sc_site/.test(q.sceneId || ''))
        bad('SIT_ON_STREET', m, key, `室外坐着 clip=sit · ${(q.spot || '').slice(0, 18)}`);

      // --- B 场景归属 ---
      if (q.sceneId && !anchors[q.sceneId])
        bad('SCENE_MISSING', m, key, `${q.sceneId} 没有 3D 锚点`);
      if (q.sceneId && meta && meta.place !== q.place)
        bad('SCENE_PLACE_MISMATCH', m, key, `place=${q.place} scene=${q.sceneId}(${meta.place})`);
      if (q.sceneId && meta && q.indoor && meta.kind === 'outdoor')
        bad('INDOOR_OUTDOOR_SCENE', m, key, `indoor=true 但 ${q.sceneId} 是 ${meta.kind}`);
      if (q.sceneId && meta && !q.indoor && meta.kind === 'indoor' && !q.inVehicle
        && !q.travel)
        bad('OUTDOOR_INDOOR_SCENE', m, key, `indoor=false 但 ${q.sceneId} 是室内`);
      // 赶路段被标成室内：会让剖切/室内灯以为楼里有人（电梯井除外）
      if (q.indoor && q.travel && !q.inTransit && q.place === 'street')
        bad('TRAVEL_MARKED_INDOOR', m, key, `赶路中却标 indoor=true · ${(q.spot || '').slice(0, 20)}`);
      // 人在房间里，却离房间锚点太远（电梯垂直过渡不在此列）。
      // 同层房间按网格排开后，「房间 → 本层电梯井」本来就有 30~40 m 走廊，
      // 阈值放到 46 m，只抓真正跑错楼的情况。
      if (q.indoor && !q.inTransit && A && Math.hypot(q.x - A.x, q.z - A.z, q.y - A.y) > 46)
        bad('FAR_FROM_ROOM', m, key, `离 ${q.sceneId} ${Math.hypot(q.x - A.x, q.z - A.z, q.y - A.y).toFixed(0)} m`);

      // --- C 三维坐标 ---
      if (q.indoor && !q.inVehicle && !q.inTransit && Math.abs(q.y - floorY) > 3.2)
        bad('FLOOR_Y_WRONG', m, key, `y=${q.y.toFixed(1)} 应为 ${floorY.toFixed(1)} (${q.floor}F)`);
      if (!q.indoor && !q.inVehicle && Math.abs(q.y - gy) > 4)
        bad('OUTDOOR_Y_FLOATING', m, key, `y-gy=${(q.y - gy).toFixed(1)} · ${(q.spot || '').slice(0, 18)}`);
      if (q.indoor && !q.inVehicle && !q.inTransit && distFoot > 14)
        bad('OUTSIDE_FOOTPRINT', m, key, `室内却离 ${q.place} 轮廓 ${distFoot.toFixed(0)} m`);
      // 半空斜穿：既不在任一建筑内、离地面又很高（电梯井除外）
      const inAnyFoot = Object.values(places).some((Q) =>
        Math.abs(q.x - Q.x) < Q.w / 2 + 10 && Math.abs(q.z - Q.z) < Q.d / 2 + 10);
      if (!q.inVehicle && !q.inTransit && (q.y - gy) > 6 && !inAnyFoot)
        bad('FLYING_ROUTE', m, key, `离地 ${(q.y - gy).toFixed(1)} m 且不在任何楼里 · ${(q.spot || '').slice(0, 18)}`);
      const pv = prevPos[key];
      if (pv && pv.m < m && Math.hypot(q.x - pv.x, q.z - pv.z) > 900)
        bad('TELEPORT', m, key, `${pv.m}→${m} 跳了 ${Math.hypot(q.x - pv.x, q.z - pv.z).toFixed(0)} m`);
      prevPos[key] = { m, x: q.x, z: q.z };
    }

    // ---------------- 24 个路人 ----------------
    let indoorN = 0, outdoorN = 0, clipBad = 0, sceneBad = 0, nan = 0;
    const detail = [];
    for (let i = 0; i < CL.persons.length; i++) {
      const q = CL.at(i, m);
      if (!q) continue;
      if (!Number.isFinite(q.x) || !Number.isFinite(q.y) || !Number.isFinite(q.z)) { nan++; bad('CROWD_NAN', m, q.key, ''); }
      if (q.indoor) indoorN++; else outdoorN++;
      const meta = sceneMeta[q.sceneId];
      if (q.indoor && (q.clip === 'walk' || q.clip === 'run')) { clipBad++; bad('CROWD_INDOOR_WALK', m, q.key, `${q.segment} ${q.clip}`); }
      if (!q.indoor && q.clip === 'idle') { clipBad++; bad('CROWD_OUTDOOR_IDLE', m, q.key, `${q.segment} ${q.clip}`); }
      if (meta && meta.kind === 'indoor' && !q.indoor && q.segment !== 'crisis' && q.segment !== 'postRain') {
        sceneBad++; bad('CROWD_STREET_IN_ROOM', m, q.key, `街上却挂在 ${q.sceneId}`);
      }
      if (meta && meta.kind === 'outdoor' && q.indoor) {
        sceneBad++; bad('CROWD_INDOOR_OUTSIDE', m, q.key, `室内却有 ${q.sceneId}`);
      }
      if (m % 120 === 0) {
        const ped = PED && PED.peds ? PED.peds.find((pp) => pp.i === i) : null;
        detail.push({ i, name: q.name, seg: q.segment, place: q.place, scene: q.sceneId,
          indoor: q.indoor, clip: q.clip, act: q.activity,
          pVisible: ped ? !!ped.obj.visible : null,
          pClip: ped && ped.cur ? String(ped.cur.getClip().name) : null,
          pState: ped ? ped.state : null,
          px: ped ? +ped.obj.position.x.toFixed(0) : null,
          pz: ped ? +ped.obj.position.z.toFixed(0) : null,
          tx: +q.x.toFixed(0), tz: +q.z.toFixed(0) });
      }
    }
    crowdRows.push({ m, t: hhmm(m), indoorN, outdoorN, clipBad, sceneBad, nan,
      detail: detail.length ? detail : undefined });
  }

  // 灯光现状（用于灯网改造前基线）
  const lights = [];
  const scene = window.__scene;
  if (scene) scene.traverse((o) => {
    if (o.isPointLight) lights.push({ type: 'point', vis: o.visible,
      i: +o.intensity.toFixed(1), y: +o.position.y.toFixed(1),
      place: o.userData ? o.userData.place : null });
  });
  const byHH = {};
  for (const r of rows) {
    if (r.crisis) continue;
    const h = Math.floor(r.m / 60);
    (byHH[h] || (byHH[h] = { n: 0, indoor: 0, moving: 0, clips: {} })).n++;
    if (r.indoor) byHH[h].indoor++;
    if (r.moving) byHH[h].moving++;
    byHH[h].clips[r.clip] = (byHH[h].clips[r.clip] || 0) + 1;
  }
  return {
    sampleCount: minutes.length, keys: D.keys, anchors: Object.keys(anchors),
    builtIds, issues, byCode, rows, crowdRows, byHH,
    lights, errs: [], collide: window.__collide ? window.__collide.stats() : null,
  };
}, { minutes, places: story.places, scenes: story.scenes });

R.errs = errs;
writeFileSync(join(ROOT, 'out/audit/timeline.json'), JSON.stringify(R, null, 1));

console.log(`采样 ${R.sampleCount} 个时刻 / 具名 ${R.rows.length} 行 / 场景锚点 ${R.anchors.length} 个`);
console.log('\n=== 问题分类 ===');
for (const [code, n] of Object.entries(R.byCode).sort((a, b) => b[1] - a[1]))
  console.log(`${String(n).padStart(5)}  ${code}`);
console.log('\n=== 每类前 4 条 ===');
const seen = {};
for (const it of R.issues) {
  seen[it.code] = seen[it.code] || 0;
  if (seen[it.code]++ < 4) console.log(`  ${it.code}  ${String(Math.floor(it.m / 60)).padStart(2, '0')}:${String(it.m % 60).padStart(2, '0')} ${it.who.padEnd(10)} ${it.info}`);
}
console.log('\n=== 逐小时：室内 / 移动 / 动作分布（具名 7 人） ===');
for (let h = 0; h < 24; h++) {
  const v = R.byHH[h] || { n: 0 };
  console.log(`${String(h).padStart(2, '0')}:00  n=${v.n} indoor=${v.indoor} moving=${v.moving}  ${JSON.stringify(v.clips || {})}`);
}
console.log('\n=== 灯光基线 ===');
console.log(JSON.stringify(R.lights));
console.log('\n页面错误:', errs.length, errs.slice(0, 3).join(' | '));
console.log('\n完整报告: out/audit/timeline.json');
await b.close();
