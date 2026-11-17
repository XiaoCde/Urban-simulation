/**
 * _probe_base.mjs — 决策 / 全城分布 / 人口结构 / 状态值 / 伞 / 动作 一致性基线探针
 * 用法: node _probe_base.mjs [人数=1000]
 * 只读，不改任何项目文件。输出 JSON 到 stdout。
 */
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME = [
  'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(fs.existsSync);
const N = Number(process.argv[2] || 1000);

const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 900000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await b.newPage();
await page.setViewport({ width: 900, height: 560 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1');
u.searchParams.set('ped', String(N));
u.searchParams.set('v', String(Date.now()));
await page.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, { timeout: 600000, polling: 300 });

const out = await page.evaluate(() => {
  const C = window.__clock, PED = window.__ped, CL = window.__crowdLife, F = window.__flood;
  const R = {};
  R.defaultMinute = +C.minute.toFixed(2);
  R.pedCount = PED.peds.length;
  R.social = CL.stats();

  // ---- 年龄细分布 / 职业 × 年龄 交叉
  const ages = {}, cross = {};
  for (const p of CL.persons) {
    const a = p.citizen.age;
    const bk = a < 6 ? '0-5' : a < 13 ? '6-12' : a < 18 ? '13-17' : a < 25 ? '18-24'
      : a < 40 ? '25-39' : a < 56 ? '40-55' : a < 65 ? '56-64' : a < 75 ? '65-74' : '75+';
    ages[bk] = (ages[bk] || 0) + 1;
    const k = `${p.role}|${p.citizen.ageGroup}`;
    cross[k] = (cross[k] || 0) + 1;
  }
  R.ageBuckets = ages;
  R.roleAge = cross;

  // ---- 群体内核覆盖（有没有大量落到默认组）
  const cohorts = {}, roles = {};
  for (let i = 0; i < PED.peds.length; i++) {
    const d = PED.live.debug(i);
    if (!d) continue;
    cohorts[d.cohort] = (cohorts[d.cohort] || 0) + 1;
    roles[d.role] = (roles[d.role] || 0) + 1;
  }
  R.cohorts = cohorts;
  R.roles = roles;

  // ---- 伞：两个字段是否一致 / 是否有 3D 伞
  let umbMismatch = 0, own = 0, umbOpen = 0;
  for (const p of CL.persons) {
    if (p.hasUmbrella !== p.phys.hasUmbrella) umbMismatch++;
    if (p.hasUmbrella) own++;
    if (p.phys.umbrella === 'open') umbOpen++;
  }
  R.umbrella = { own, mismatch: umbMismatch, openNow: umbOpen,
    personField: CL.persons[3].hasUmbrella, physField: CL.persons[3].phys.hasUmbrella };

  // ---- 门牌/住宅聚集：同一门牌挂多少人
  const workLoad = {}, homeLoad = {};
  for (const p of CL.persons) {
    workLoad[p.workDoor.id] = (workLoad[p.workDoor.id] || 0) + 1;
    homeLoad[p.homeDoor.id] = (homeLoad[p.homeDoor.id] || 0) + 1;
  }
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 6);
  R.doors = {
    workUnique: Object.keys(workLoad).length, workMax: Math.max(...Object.values(workLoad)),
    workTop: top(workLoad), homeUnique: Object.keys(homeLoad).length,
    homeMax: Math.max(...Object.values(homeLoad)), homeTop: top(homeLoad),
  };

  // ---- 全城分布：多个时刻的室外人员网格
  const rows = [];
  C.setPlaying(false);
  for (const m of [0, 420, 600, 1080, 1300]) {
    C.seek(m); window.__frame(0, 2);
    const cells = {};
    let outN = 0, inN = 0, air = 0;
    for (let i = 1; i < PED.peds.length; i++) {
      const q = CL.at(i), pp = PED.peds[i];
      if (q.indoor) { inN++; continue; }
      outN++;
      const k = Math.floor(pp.obj.position.x / 120) + ',' + Math.floor(pp.obj.position.z / 120);
      cells[k] = (cells[k] || 0) + 1;
      const gy = PED.graph.groundAt(pp.obj.position.x, pp.obj.position.z);
      if (pp.obj.position.y - gy > 1.2) air++;
    }
    const v = Object.values(cells).sort((a, b) => b - a);
    rows.push({ m, outN, inN, air, cells: v.length,
      maxCell: v[0] || 0, p95: v[Math.floor(v.length * 0.05)] || 0,
      top5: v.slice(0, 5) });
  }
  R.distribution = rows;

  // ---- 状态值：连续播放前后，生理量是否真的随真实运动累积
  C.seek(400); window.__frame(0, 2);
  const sample = [3, 17, 51, 97, 211].filter((i) => i < CL.persons.length);
  const snap = () => sample.map((i) => {
    const ph = CL.at(i).phys;
    return { i, hunger: ph.hunger, wetness: ph.wetness, stamina: ph.stamina,
      trapped: ph.trappedMin, umbrella: ph.umbrella };
  });
  const before = snap();
  C.setSpeed(12); C.setPlaying(true);
  for (let f = 0; f < 90; f++) window.__frame(0.05, 1, true);
  const after = snap();
  R.physBefore = before; R.physAfter = after;
  R.physChanged = before.map((b, k) => ({
    i: b.i, dHunger: after[k].hunger - b.hunger, dWet: after[k].wetness - b.wetness,
    dStam: after[k].stamina - b.stamina,
  }));

  // ---- 决策覆盖：每人是否都在判断；动作与动画是否一致
  const st = PED.live.stats();
  let judgedAgents = 0, idleAgents = 0;
  const actClip = {};
  for (let i = 0; i < PED.peds.length; i++) {
    const a = PED.live.agent(i);
    if (!a) continue;
    if (a.recent && a.recent.length > 0) judgedAgents++; else idleAgents++;
    const clip = PED.peds[i].cur ? String(PED.peds[i].cur.getClip().name) : 'none';
    const key = `${a.lastAction}|${clip}`;
    actClip[key] = (actClip[key] || 0) + 1;
  }
  R.live = { stats: st, judgedAgents, idleAgents, actClip,
    minute: +C.minute.toFixed(2), rainMMH: F.rainRate ? +F.rainRate().toFixed(1) : -1 };
  C.setPlaying(false);
  return R;
});

console.log(JSON.stringify({ out, errs }, null, 1));
await b.close();
