/**
 * 第八轮验收：实体碰撞 + 全员 brain + 全流程贯通。
 * 1) 碰撞层里到底收了多少实体、按类型分
 * 2) 抽查：人物的实际站位 / 随机点，有多少落在实体里（穿模率）
 * 3) 24 个人 + 7 个具名角色，一天里各产生多少次真实决策（Brain.decide）
 * 4) 全流程：剧本 → 时刻 → 3D 位置 → 动作 → 生理 → 决策，逐环有值
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await b.newPage();
await p.setViewport({ width: 1000, height: 640 });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 140)); });
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
u.searchParams.set('seed', '20261117');
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
await p.evaluate(() => { window.__ready = false; });

const checks = [];
const add = (n, ok, info = '') => checks.push([n, !!ok, info]);

// ---- 1) 碰撞层统计 ----
const col = await p.evaluate(() => {
  const C = window.__collide;
  if (!C) return null;
  return { ...C.stats(), nStreet: C.nStreet, nTree: C.nTree, nLot: C.nLot, nProp: C.nProp };
});
add('碰撞层已装配', !!col, col ? `boxes=${col.boxes} cells=${col.cells}` : 'null');
if (col) {
  add('家具 / 街具 / 树 / 停放车 / 建筑都进去了',
    col.byTag.prop > 100 && col.byTag.building > 100 && col.byTag.tree > 1000,
    JSON.stringify(col.byTag));
}

// ---- 2) 穿模抽查：人物 + 随机点 ----
const pen = await p.evaluate(() => {
  const C = window.__collide, D = window.__dayMotion, T = window.__THREE;
  const P = window.__people;
  const IGN = new Set(['building']);
  const out = { people: [], rand: { n: 0, hit: 0 } };
  for (const m of [20, 300, 600, 760, 900, 1260]) {
    for (const k of D.keys) {
      const q = D.at(k, m);
      if (!q || q.crisis || !q.indoor) continue;
      const hit = C.blockedCircle(q.x, q.z, 0.3, q.y + 0.1, q.y + 1.7, { ignoreTags: IGN });
      if (hit) out.people.push({ k, m, tag: hit.tag });
    }
  }
  // 人行道采样：chains 就是人行道折线，灯杆 / 停放车 / 行道树都长在这上面
  const G = window.__ped.graph;
  let rnd = 12345;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (const c of G.chains) {
    if (!c || !c.pts || c.pts.length < 2) continue;
    for (let k = 0; k < 2; k++) {
      const pt = c.pts[(rand() * c.pts.length) | 0];
      const gy = G.groundAt(pt.x, pt.z);
      out.rand.n++;
      if (C.blockedCircle(pt.x, pt.z, 0.3, gy + 0.2, gy + 1.7, { ignoreTags: IGN })) out.rand.hit++;
    }
  }
  return out;
});
add('室内人物的站位不再落在家具里', pen.people.length === 0,
  pen.people.slice(0, 5).map((q) => `${q.k}@${q.m}(${q.tag})`).join(',') || '0 处穿模');
add('人行道上采样会撞到实体（说明灯杆/树/停放车真有体积）', pen.rand.hit > 60,
  `${pen.rand.hit}/${pen.rand.n} 个随机点被实体挡住`);

// ---- 3) 全员 brain：一天里各产生多少次决策 ----
const brain = await p.evaluate(() => {
  const out = { named: {}, crowd: { persons: 0, decided: 0, total: 0 } };
  const P = window.__people, MK = window.__mark, CL = window.__crowdLife;
  const C = window.__clock;
  // 逐 20 分钟推一天（只推决策节流，不做渲染）
  for (let m = 0; m <= 1440; m += 20) {
    C.seek(m);
    // 具名：直接喂一次 applyDay 的节流判定（通过 advance(0) 不推进动画）
    if (P) P.advance(0);
    if (MK) MK.advance(0);
    if (CL) for (let i = 0; i < CL.persons.length; i++) {
      const q = CL.at(i, m);
      if (q && q.wantDecision) CL.decide(i, m, { x: q.x, y: q.y, z: q.z });
    }
  }
  if (P && P.actors) for (const a of P.actors) out.named[a.def.key] = (a.story.decisions || []).length;
  // 用「永不清零」的计数器：拖时间轴会 reset brain.decisions，看长度会失真
  const who = window.__thinkWho || {};
  for (const k of Object.keys(who)) out.named[k] = who[k];
  if (CL) {
    out.crowd.persons = CL.persons.length;
    for (const p2 of CL.persons) {
      const n = (p2.brain.decisions || []).length;
      out.crowd.total += n;
      if (n > 0) out.crowd.decided++;
    }
  }
  return out;
});
const namedKeys = Object.keys(brain.named);
add('7 个具名角色一天都有决策记录', namedKeys.length === 7 && namedKeys.every((k) => brain.named[k] > 0),
  namedKeys.map((k) => `${k}:${brain.named[k]}`).join(' '));
add('24 个随机行人一天都有决策记录', brain.crowd.decided === brain.crowd.persons,
  `${brain.crowd.decided}/${brain.crowd.persons} 人，共 ${brain.crowd.total} 次`);

// ---- 4) 全流程贯通 ----
const flow = await p.evaluate(() => {
  const C = window.__clock, D = window.__dayMotion;
  C.setPlaying(false); C.seek(760); window.__frame(0, 2);
  const q = D.at('mark', 760);
  const hud = window.__mark.hud();
  const P = window.__people.hud();
  const crowdRow = window.__crowdLife.at(0, 760);
  return {
    story: !!(window.__story && window.__story.ok),
    segs: D.keys.length,
    q: { place: q.place, floor: q.floor, clip: q.clip, kind: q.kind, x: +q.x.toFixed(0), z: +q.z.toFixed(0) },
    hudPlace: hud.placeName, hudAct: hud.stateText,
    people: P.length,
    crowd: { name: crowdRow.name, role: crowdRow.role, act: crowdRow.activity, scene: crowdRow.sceneId },
    phys: !!q.phys,
  };
});
add('剧本 → 轨迹：7 人 154 段编译成功', flow.story && flow.segs === 7, `keys=${flow.segs}`);
add('轨迹 → 3D：马克有地点/楼层/动作/坐标', !!flow.q.place && flow.q.floor > 0 && !!flow.q.clip,
  `${flow.q.place} ${flow.q.floor}F ${flow.q.kind} (${flow.q.x},${flow.q.z})`);
add('3D → HUD：面板与轨迹同源', !!flow.hudPlace, `${flow.hudPlace} / ${flow.hudAct}`);
add('行人社会层：身份 + 场景 + 动作', !!flow.crowd.name && !!flow.crowd.scene,
  `${flow.crowd.name}（${flow.crowd.role}）在 ${flow.crowd.scene}：${flow.crowd.act}`);
add('生理状态（饥饿/淋湿/体力）随轨迹推进', flow.phys === true);
add('页面无脚本错误', errs.length === 0, errs.slice(0, 2).join(' | ') || '0');

console.log('\n=== 碰撞层 ===');
console.log(JSON.stringify(col));
console.log('\n=== 穿模抽查 ===');
console.log('人物穿模', pen.people.length, '随机点命中', `${pen.rand.hit}/${pen.rand.n}`);
console.log('\n=== 决策 ===');
console.log(JSON.stringify(brain));
console.log('\n=== 全流程 ===');
console.log(JSON.stringify(flow));
console.log('\n=== 检查项 ===');
let fail = 0;
for (const [n, ok, info] of checks) {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? '  —  ' + info : ''}`);
}
console.log(`\n${checks.length - fail}/${checks.length} PASS`);
await b.close();
