import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 760 });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
p.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || /\[day-motion\]|\[life-scenes\]|\[mark\]|\[people\]/.test(t)) {
    if (/Failed to load resource/.test(t) && /favicon/.test(t)) return;
    errs.push(t.slice(0, 220));
  }
});
const u = new URL('http://127.0.0.1:8140/index.html?ped=1');
u.searchParams.set('capture', '1');
u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });

const result = await p.evaluate(() => {
  const D = window.__dayMotion, C = window.__clock;
  const out = { ready: true, hasMotion: !!D, stats: D ? D.stats() : null, samples: {}, live: {}, checks: [] };
  if (!D) return out;
  const mins = [0, 60, 300, 420, 460, 500, 760, 900, 1090, 1170, 1320, 1400];
  const r1 = (v) => Math.round(v * 10) / 10;
  for (const m of mins) {
    C.setPlaying(false);
    C.seek(m);
    window.__frame(0, 1);
    const all = D.debug(m);
    out.samples[m] = Object.fromEntries(Object.entries(all).map(([k, q]) => [k, q.crisis
      ? { crisis: true }
      : {
        place: q.place, indoor: q.indoor, moving: q.moving, clip: q.clip,
        x: r1(q.x), y: r1(q.y), z: r1(q.z), floor: q.floor,
        speed: r1(q.speed), spot: (q.spot || '').slice(0, 16),
      }]));
    const mk = window.__ped && window.__ped.peds[0];
    const P = window.__people;
    out.live[m] = {
      mark: mk ? {
        x: r1(mk.obj.position.x), y: r1(mk.obj.position.y), z: r1(mk.obj.position.z),
        vis: mk.obj.visible, clip: mk.cur ? String(mk.cur.getClip().name) : null,
      } : null,
      cast: P ? P.actors.map((a) => ({
        k: a.def.key, x: r1(a.root.position.x), y: r1(a.root.position.y),
        z: r1(a.root.position.z), vis: a.model.visible,
        clip: a.cur ? String(a.cur.getClip().name) : null,
      })) : [],
    };
  }

  // 断言 1：0 点全员在家、室内
  const mid = D.debug(20);
  out.checks.push(['00:20 全员在家且室内',
    Object.values(mid).every((q) => q.place === 'home' && q.indoor && !q.crisis)]);
  // 断言 2：0 点没人播 walk/run（原地跑）
  out.checks.push(['00:20 无人播走跑动画',
    Object.values(mid).every((q) => q.clip !== 'walk' && q.clip !== 'run')]);
  // 断言 3：0 点马克 3D 真的在公寓 footprint 内（2642.79±41, -331.65±13.75）
  const mk0 = out.live[0].mark;
  out.checks.push(['00:00 马克 3D 在公寓楼内',
    !!mk0 && Math.abs(mk0.x - 2642.79) < 45 && Math.abs(mk0.z + 331.65) < 18]);
  // 断言 4：通勤 / 买早餐 / 晚餐，相邻分钟位置真的在变（不是钉死）
  // 【2026-11-07 第二轮】赶路/在家闲着应该动；吃饭/办公/看新闻/睡觉
  // 本来就该坐着不动（用户明确反对「莫名其妙的动作」）。按 kind 分别验。
  // drive / ride 不算静止：人虽坐着，车/电动车沿路网在走，位置一直在变
  const STATIC_KINDS = new Set(['sleep', 'meal', 'desk',
    'medical', 'teach', 'serve', 'talk']);
  for (const [label, a] of [['07:40 通勤', 460], ['12:20 去吃午饭', 740],
    ['19:40 晚餐', 1180], ['22:00 客厅', 1320]]) {
    const qa = D.at('mark', a), qb = D.at('mark', a + 10);
    const d = Math.hypot(qb.x - qa.x, qb.z - qa.z);
    if (STATIC_KINDS.has(qa.kind)) {
      out.checks.push([`${label} ${qa.kind} 静坐不动（clip=${qa.clip}）`,
        d < 0.5 && qa.clip !== 'walk' && qa.clip !== 'run']);
    } else {
      out.checks.push([`${label} 10 分钟内位移 ${r1(d)} m`, d > 0.3]);
    }
  }
  // 断言 5：全时刻「静止」时绝不播 walk/run
  let bad = 0;
  for (let m = 0; m < 1440; m += 2) {
    const q = D.at('mark', m);
    if (q && !q.crisis && !q.moving && (q.clip === 'walk' || q.clip === 'run')) bad++;
  }
  out.checks.push([`全天 720 采样：静止时原地跑 ${bad} 次`, bad === 0]);
  // 断言 6：3D 实际摆位与轨迹一致（不只是函数算得对）
  let off = 0;
  for (const m of mins) {
    const q = D.at('mark', m), l = out.live[m].mark;
    if (!q || q.crisis || !l) continue;
    if (Math.hypot(q.x - l.x, q.z - l.z) > 0.6) off++;
  }
  out.checks.push([`3D 摆位与轨迹偏差 >0.6m 的时刻 ${off} 个`, off === 0]);
  // 断言 7：0 点与 12:40 的 3D 位置不同（拖时间轴人真的换了地方）
  out.checks.push(['0 点 vs 12:40 马克 3D 位置不同',
    Math.hypot(out.live[0].mark.x - out.live[760].mark.x,
      out.live[0].mark.z - out.live[760].mark.z) > 30]);
  return out;
});

console.log('=== STATS ===', JSON.stringify(result.stats));
console.log('=== CHECKS ===');
for (const [name, ok] of result.checks) console.log(ok ? 'PASS ' : 'FAIL ', name);
console.log('=== MARK SAMPLES ===');
for (const m of [0, 300, 420, 460, 500, 760, 900, 1090, 1170, 1320, 1400]) {
  const q = result.samples[m].mark, l = result.live[m].mark;
  console.log(String(m).padStart(4), JSON.stringify(q), ' live=', JSON.stringify(l));
}
console.log('=== 00:20 ALL CAST ===');
console.log(JSON.stringify(Object.fromEntries(Object.entries(result.samples[60]).map(
  ([k, v]) => [k, `${v.place}/${v.floor}F ${v.clip} ${v.indoor ? 'in' : 'OUT'} (${v.x},${v.z})`])), null, 1));
console.log('=== CONSOLE ===');
console.log(errs.slice(0, 30).join('\n'));
await b.close();
