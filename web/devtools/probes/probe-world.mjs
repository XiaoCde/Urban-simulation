// 城市一致性探针：默认时刻、0点室内外、马克公寓占用、住所分布、具名角色同源。
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME = [
  'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(fs.existsSync);

const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await b.newPage();
await p.setViewport({ width: 1000, height: 600 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1');
u.searchParams.set('ped', process.argv[2] || '1000');
u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });

const out = await p.evaluate(() => {
  const C = window.__clock, PED = window.__ped, CL = window.__crowdLife;
  const rows = [];
  const inspect = (m) => {
    C.setPlaying(false);
    C.seek(m);
    window.__frame(0, 2);
    let outN = 0, inN = 0, air = 0, homeless = 0, markHome = 0, nightOut = 0;
    const homes = new Map(), scenes = new Map();
    const groundAt = PED.graph.groundAt;
    for (let i = 1; i < PED.peds.length; i++) {
      const p = PED.peds[i], q = CL.at(i);
      if (!q) continue;
      if (q.indoor) inN++; else outN++;
      if (!q.homeBuilding) homeless++;
      if (q.homeBuilding === '565Penn') markHome++;
      homes.set(q.homeBuilding, (homes.get(q.homeBuilding) || 0) + 1);
      scenes.set(q.sceneId, (scenes.get(q.sceneId) || 0) + 1);
      const dy = p.obj.position.y - groundAt(p.obj.position.x, p.obj.position.z);
      if (!q.indoor && dy > 0.4) air++;
      if (q.segment === 'night' && !q.indoor) nightOut++;
    }
    const topHomes = [...homes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    return { m, outN, inN, air, homeless, markHome, nightOut,
      distinctHomes: homes.size, topHomes, topScenes: [...scenes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5) };
  };
  rows.push({ defaultMinute: +C.minute.toFixed(1) });
  for (const m of [0, 200, 415, 600, 720, 1030, 1080, 1300]) rows.push(inspect(m));
  // 具名角色与第 0~6 个实时居民是否同一个位置
  const same = [];
  if (window.__mark) {
    const q = PED.peds[0].obj.position, h = window.__mark.hud();
    same.push({ who: 'mark', dx: +Math.hypot(q.x - h.x, q.z - h.z).toFixed(3) });
  }
  if (window.__people) {
    for (let k = 0; k < window.__people.actors.length; k++) {
      const a = window.__people.actors[k], q = PED.peds[k + 1].obj.position;
      same.push({ who: window.__people.actors[k].def.key,
        dx: +Math.hypot(a.root.position.x - q.x, a.root.position.z - q.z).toFixed(3) });
    }
  }
  const st = CL.stats();
  return { rows, same, crowd: { count: st.count, doors: st.doors, destCap: st.destCap,
    maxDoorLoad: st.maxDoorLoad, anchors: st.anchors }, live: PED.live.stats() };
});
console.log(JSON.stringify({ out, errs }, null, 1));
await b.close();
