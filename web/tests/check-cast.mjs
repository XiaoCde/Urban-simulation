import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
u.searchParams.set('seed', '20261117');
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });
console.log(JSON.stringify(await p.evaluate(async () => {
  const C = window.__clock, F = window.__flood;
  C.setPlaying(false); C.seek(1100);
  let t0 = performance.now();
  while (performance.now() - t0 < 20000 && F.frameIndex !== 5) await new Promise(r => setTimeout(r, 200));
  await new Promise(r => setTimeout(r, 400));
  // 6 个具名角色在各自的 depthAt 里怎么算 vs 绝对时刻怎么算
  const P = window.__people || null;
  const rows = [];
  const cast = window.__cast || null;
  const src = (cast && cast.stories) || (P && P.stories) || null;
  // 直接拿最深的一格比对「故事分钟」与「绝对分钟」两条路径
  const g = F.depthGrid, man = F.manifest;
  let mx = 0, ami = 0;
  for (let i = 0; i < g.data.length; i++) if (g.data[i] > mx) { mx = g.data[i]; ami = i; }
  const px = man.x0 + ((ami % man.cols) + 0.5) * man.step_m, pz = man.z0 + ((((ami / man.cols) | 0)) + 0.5) * man.step_m;
  const anyStory = src ? Object.values(src)[0] : null;
  const probe = anyStory ? {
    at: [+px.toFixed(0), +pz.toFixed(0), mx],
    story60: +Number(anyStory.depthAt(px, pz, 60) || 0).toFixed(3),
    abs1080: +Number(F.depthAt(px, pz, 1080) || 0).toFixed(3),
    story80: +Number(anyStory.depthAt(px, pz, 80) || 0).toFixed(3),
    abs1100: +Number(F.depthAt(px, pz, 1100) || 0).toFixed(3),
    story140: +Number(anyStory.depthAt(px, pz, 140) || 0).toFixed(3),
    abs1160: +Number(F.depthAt(px, pz, 1160) || 0).toFixed(3),
  } : null;
  if (!src) return { probe, note: '没有暴露故事对象', keys: Object.keys(window).filter(k => /people|cast|story/i.test(k)) };
  for (const [k, st] of Object.entries(src)) {
    const x = st.position ? st.position.x : null, z = st.position ? st.position.z : null;
    if (x === null) continue;
    rows.push({
      k, tMin: +st.tMin.toFixed(2),
      viaStory: +Number(st.depthAt(x, z, st.tMin) || 0).toFixed(3),
      viaAbs: +Number(F.depthAt(x, z, 1020 + st.tMin) || 0).toFixed(3),
      noT: +Number(F.depthAt(x, z) || 0).toFixed(3),
    });
  }
  return { probe, rows };
}), null, 1));
await b.close();
