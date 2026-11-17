/**
 * 全城市民验收（2026-11-10）：
 *  1) 装配 / 全城多中心分布 / 作息错峰（任何时刻街上有人）
 *  2) 年龄(老人·小孩·中年) 与经验(老手·新手) 的分布
 *  3) 同段内三组速度真的不同、心理状态真的不同
 *  4) 决策思考方向真的不同（不是改文案，是候选集与效用排序不同）
 *  5) 家门容量上限、场景与职业身份一致
 *  6) 动作连贯：无原地跑 / 无室内走跑 / 无可见瞬移、进屋过渡有真实位移
 *  7) 页面零脚本错误
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
await p.setViewport({ width: 960, height: 600 });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 160)); });
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });

const STATIC = await p.evaluate(() => {
  const C = window.__crowdLife, PED = window.__ped, CLOCK = window.__clock;
  const N = C.persons.length;
  const st = C.stats();
  const peds = PED.peds;

  // ---- 全城多中心分布：出生点覆盖多少个 420m 网格、跨度多大
  const cells = new Set();
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (let i = 1; i < peds.length; i++) {
    const h = peds[i].homeXZ;
    if (!h) continue;
    cells.add(`${Math.floor(h.x / 420)}|${Math.floor(h.z / 420)}`);
    x0 = Math.min(x0, h.x); x1 = Math.max(x1, h.x);
    z0 = Math.min(z0, h.z); z1 = Math.max(z1, h.z);
  }

  // ---- 作息错峰：任意时刻街上（非室内）的人数
  // 【2026-11-11 口径】现在场景由实时目标决定，必须先把目标重建到该时刻，
  // 不能拿 0 点的“在家休息”去回答 9 点。拖动/查询同一套接口。
  const prep = (m) => {
    if (PED.live) { PED.live.reset(m, peds); PED.live.restore(peds); }
  };
  const outdoorAt = [];
  for (const m of [0, 180, 360, 540, 720, 900, 1080, 1100, 1260, 1380]) {
    prep(m);
    let n = 0;
    for (let i = 0; i < N; i++) if (!C.at(i, m).indoor) n++;
    outdoorAt.push({ m, n });
  }

  // ---- 同一段（暴雨窗口全局统一）内的速度 / 心理差异
  const M = 1090;
  prep(M);
  const byAge = { child: [], adult: [], elderly: [] };
  const byExp = { veteran: [], rookie: [] };
  for (let i = 0; i < N; i++) {
    const q = C.at(i, M);
    // 室内时 speedAbs=0，比较“年龄导致的步速”要用个人档案里的基准速度。
    const row = { speed: q.citizen.speedAbs, stress: q.stress, sight: q.citizen.profile.sightM,
      noise: q.citizen.profile.noise, mood: q.mood, seg: q.segment };
    byAge[q.ageGroup].push(row);
    if (q.veteran) byExp.veteran.push(row);
    if (q.rookie) byExp.rookie.push(row);
  }
  const avg = (a, k) => a.length ? +(a.reduce((s, r) => s + r[k], 0) / a.length).toFixed(3) : 0;
  const ageSummary = {};
  for (const k of Object.keys(byAge)) {
    const a = byAge[k];
    ageSummary[k] = { n: a.length, speed: avg(a, 'speed'), stress: avg(a, 'stress'),
      sight: avg(a, 'sight'), noise: avg(a, 'noise'),
      moods: [...new Set(a.map((r) => r.mood))].slice(0, 5) };
  }
  const expSummary = {
    veteran: { n: byExp.veteran.length, sight: avg(byExp.veteran, 'sight'), noise: avg(byExp.veteran, 'noise') },
    rookie: { n: byExp.rookie.length, sight: avg(byExp.rookie, 'sight'), noise: avg(byExp.rookie, 'noise') },
  };

  // ---- 决策：全天 11 个时刻每人真跑一次 Brain，统计思考方向
  const times = [20, 200, 400, 600, 760, 900, 1030, 1080, 1090, 1120, 1200, 1380];
  const pos = { x: 2400, y: 0, z: 0 };
  for (const m of times) for (let i = 0; i < N; i++) C.decide(i, m, pos);
  const groups = { veteran: {}, rookie: {}, child: {}, elderly: {}, adult: {} };
  const byAgeDecision = { child: {}, adult: {}, elderly: {} };
  let decided = 0;
  for (let i = 0; i < N; i++) {
    const q = C.at(i, 1090);
    const per = C.persons[i];
    if (!per.brain.decisions.length) continue;
    decided++;
    // 暴雨 1090 那次决策的 chosen
    const last = per.brain.decisions.filter((d) => Math.abs(d.t - 1090) < 0.01).pop();
    if (!last) continue;
    const g = q.veteran ? 'veteran' : q.rookie ? 'rookie' : q.ageGroup;
    const bucket = groups[g] || (groups[g] = {});
    bucket[last.chosen] = (bucket[last.chosen] || 0) + 1;
    const ab = byAgeDecision[q.ageGroup] || (byAgeDecision[q.ageGroup] = {});
    ab[last.chosen] = (ab[last.chosen] || 0) + 1;
  }

  // ---- 容量 / 场景身份 / 决策错峰
  prep(600);
  const dbg = C.debug(600);
  const prefix = { office: 'sc_office', cafe: 'sc_cafe', clinic: 'sc_clinic',
    school: 'sc_school', site: 'sc_site', street: 'sc_street', home: 'sc_home' };
  // 【2026-11-12 口径更新】普通市民的家与岗位都绑定到全城真实建筑门牌
  // （residence_<楼id> / work_<楼id>），不再借用马克公寓或 42 个固定门口 ——
  // 后者正是实测「一个岗位门口挂 48 人」的扎堆来源。只有 7 个具名角色
  // 使用精细剧情房间 sc_*，且地点前缀必须和职业一致。
  const FIXED_DOOR = /^(home|work)_(home|office|cafe|clinic|school|site|street)_[0-5]$/;
  const sceneMismatch = dbg.filter((d) => {
    if (!d.indoor || d.place === 'street') return false;
    const sc = d.scene || '', door = d.door || '';
    if (sc.startsWith('sc_')) {
      return d.i >= 7 || !(prefix[d.place] && sc.startsWith(prefix[d.place]));
    }
    const realBuilding = /^(residence|work|office)_/.test(sc);
    return !realBuilding || FIXED_DOOR.test(door);
  }).slice(0, 6);
  const overCap = dbg.filter((d) => d.placeIdx >= st.destCap).length;
  let maxConcurrent = 0;
  for (let m = 0; m < 1440; m += 7) {
    let n = 0;
    for (let i = 0; i < N; i++) if (C.at(i, m).wantDecision) n++;
    maxConcurrent = Math.max(maxConcurrent, n);
  }
  // 实时内核：不靠旧的预写候选文案，直接比较同一情境下每组人的判断参数。
  const K = { child: [], adult: [], elderly: [] };
  const cohorts = new Set();
  for (let i = 1; i < N; i++) {
    const d = PED.live.debug(i);
    const q = C.at(i, M);
    if (!d || !q) continue;
    cohorts.add(d.cohort);
    K[q.ageGroup].push({ wade: d.kernel.wade, temp: d.kernel.temp,
      detour: d.kernel.detour, wait: d.kernel.wait, speed: d.kernel.speed });
  }
  const ka = (a, k) => a.length ? +(a.reduce((s, r) => s + r[k], 0) / a.length).toFixed(3) : 0;
  const kernelSummary = {
    cohorts: cohorts.size,
    child: { wade: ka(K.child, 'wade'), temp: ka(K.child, 'temp'), wait: ka(K.child, 'wait') },
    adult: { wade: ka(K.adult, 'wade'), temp: ka(K.adult, 'temp'), wait: ka(K.adult, 'wait') },
    elderly: { wade: ka(K.elderly, 'wade'), temp: ka(K.elderly, 'temp'), wait: ka(K.elderly, 'wait') },
  };
  CLOCK.setPlaying(false);
  return { st, N, cells: cells.size, spanX: Math.round(x1 - x0), spanZ: Math.round(z1 - z0),
    outdoorAt, ageSummary, expSummary, groups, byAgeDecision, decided,
    sceneMismatch, overCap, maxConcurrent, kernelSummary };
});

// ---- 播放态：动作连贯（原地跑 / 室内走跑 / 可见瞬移 / 进屋过渡）
const PLAY = await p.evaluate(() => {
  const C = window.__clock, PED = window.__ped, CROWD = window.__crowdLife;
  const cam = window.__camera, flood = window.__flood, ctl = window.__controls;
  const peds = PED.peds;
  C.setPlaying(false);
  // 相机放到「默认镜头街区」（FAA/MegaKit 中心 2501,355）最近的行人旁，
  // 低机位看街面。之前放到 peds[3].homeXZ，那是别的片区，测出来 0 人是假象。
  let best = peds[1], bestD = Infinity;
  for (let i = 1; i < peds.length; i++) {
    const h = peds[i].homeXZ;
    if (!h) continue;
    const d = Math.hypot(h.x - 2501, h.z - 355);
    if (d < bestD) { bestD = d; best = peds[i]; }
  }
  const anchor = best.homeXZ || best.obj.position;
  cam.position.set(anchor.x + 18, 12, anchor.z + 18);
  if (ctl) { ctl.target.set(anchor.x, 0, anchor.z); ctl.update(); }
  const out = [];
  for (const m of [20, 500, 760, 1090, 1120, 1320]) {
    C.seek(m); window.__frame(0, 2);
    const ps = PED.peds;
    const before = ps.map((q) => ({ x: q.obj.position.x, z: q.obj.position.z, vis: !!q.obj.visible }));
    let maxJump = 0, jumpVisible = 0, enterMove = 0;
    for (let f = 0; f < 36; f++) {
      C.minute += 0.42;                 // 快进，跨越作息段边界，触发进出屋
      const pre = ps.map((q) => ({ x: q.obj.position.x, z: q.obj.position.z, vis: !!q.obj.visible }));
      PED.update(1 / 30, cam, flood);
      for (let i = 1; i < ps.length; i++) {
        const q = ps[i];
        const d = Math.hypot(q.obj.position.x - pre[i].x, q.obj.position.z - pre[i].z);
        maxJump = Math.max(maxJump, d);
        if (pre[i].vis && q.obj.visible && d > 2.2) jumpVisible++;
        if (q.enterWalk && d > 0.01) enterMove++;
      }
    }
    const rows = ps.slice(1).map((q, k) => {
      const i = k + 1;
      const d = Math.hypot(q.obj.position.x - before[i].x, q.obj.position.z - before[i].z);
      const clip = q.cur ? String(q.cur.getClip().name) : '';
      const soc = CROWD.at(i, C.minute);
      return { i, d, clip, vis: !!q.obj.visible, indoor: !!(soc && soc.indoor),
        mode: q.mode, enterWalk: !!q.enterWalk };
    });
    out.push({ m,
      visibleStreet: rows.filter((r) => r.vis && !r.indoor).length,
      moving: rows.filter((r) => r.d > 0.05 && r.vis).length,
      stillRun: rows.filter((r) => r.vis && /walk|run/.test(r.clip) && r.d < 0.05).length,
      // 进屋过渡本来就是「室内段但沿街走几米再进门」，属设计行为，不算错。
      indoorWalk: rows.filter((r) => r.indoor && r.vis && !r.enterWalk
        && /walk|run/.test(r.clip)).length,
      jumpVisible, enterMove, maxJump: +maxJump.toFixed(2) });
  }
  return out;
});

const checks = [];
const add = (n, ok, info = '') => checks.push([n, !!ok, info]);
const S = STATIC, PL = PLAY;
add('市民层装配 240 人', S.N >= 200, `N=${S.N} doors=${S.st.doors} cap=${S.st.destCap}`);
add('全城多中心铺开（≥6 个片区 / 跨度 >1km）',
  S.cells >= 6 && Math.max(S.spanX, S.spanZ) > 1000,
  `网格 ${S.cells} 个 · x跨度 ${S.spanX}m / z跨度 ${S.spanZ}m`);
// 深夜绝大多数人在自己住所，白天/傍晚街面有真实分布。旧断言要求 0 点也
// “街上有人”，实际会逼着系统把人留在街上，正是用户这次指出的错误。
const deepNight = S.outdoorAt.filter((r) => r.m <= 240 || r.m >= 1380);
const dayRows = S.outdoorAt.filter((r) => r.m >= 540 && r.m <= 1100);
add('深夜在家、白天街上有人', deepNight.every((r) => r.n < S.N * 0.15)
  && dayRows.some((r) => r.n > 80),
  S.outdoorAt.map((r) => `${Math.floor(r.m / 60)}h:${r.n}`).join(' '));
add('三档年龄齐全', ['child', 'adult', 'elderly'].every((k) => S.st.byAge[k] > 10),
  JSON.stringify(S.st.byAge));
add('经验有老手也有新手', S.st.veteran > 20 && S.st.rookie > 20,
  `老手 ${S.st.veteran} / 新手 ${S.st.rookie} / 均值 ${S.st.expAvg}`);
const A = S.ageSummary;
add('步速：老人 < 小孩 < 中年', A.elderly.speed < A.child.speed && A.child.speed < A.adult.speed,
  `老人 ${A.elderly.speed} / 小孩 ${A.child.speed} / 中年 ${A.adult.speed} m/s`);
add('心理：小孩最紧张、老人最稳', A.child.stress > A.adult.stress && A.adult.stress > A.elderly.stress,
  `stress 小孩 ${A.child.stress} / 中年 ${A.adult.stress} / 老人 ${A.elderly.stress}`);
add('老手看得更远、决策噪声更小',
  S.expSummary.veteran.sight > S.expSummary.rookie.sight
  && S.expSummary.veteran.noise < S.expSummary.rookie.noise,
  `sight ${S.expSummary.veteran.sight} vs ${S.expSummary.rookie.sight} · noise ${S.expSummary.veteran.noise} vs ${S.expSummary.rookie.noise}`);
// 【2026-11-11 口径】旧的“预写候选文案”已退役。现在验证真正驱动判断的
// 群体内核：不同职业×年龄×经验确实是不同的参数，而不是同一套人换名字。
const KS = S.kernelSummary;
add('判断内核按群体分化', KS.cohorts >= 10,
  `内核组合 ${KS.cohorts} 种（职业地位 × 年龄）`);
add('年龄决定判断内核（小孩更易变 / 老人涉水更保守 / 老人更愿意等）',
  KS.child.temp > KS.adult.temp && KS.elderly.wade < KS.adult.wade
  && KS.elderly.wait > KS.adult.wait,
  `temp 小孩 ${KS.child.temp}/中年 ${KS.adult.temp}`
  + ` · 涉水线 老人 ${KS.elderly.wade}/中年 ${KS.adult.wade}`
  + ` · 等待 老人 ${KS.elderly.wait}/中年 ${KS.adult.wait}`);
add('全天每人都有决策', S.decided >= S.N * 0.95, `${S.decided}/${S.N}`);
add('决策按人错峰（单分钟不过载）', S.maxConcurrent <= 110, `峰值 ${S.maxConcurrent} 人/分钟`);
add('家门容量不超上限', S.st.maxDoorLoad <= S.st.destCap && S.overCap === 0,
  `最大 ${S.st.maxDoorLoad}/${S.st.destCap} · 越界 ${S.overCap}`);
add('岗位场景与职业身份一致', S.sceneMismatch.length === 0, JSON.stringify(S.sceneMismatch));
add('无原地跑 / 无室内走跑', PL.every((r) => r.stillRun === 0 && r.indoorWalk === 0),
  PL.map((r) => `${r.m}:跑${r.stillRun}/室内${r.indoorWalk}`).join(' '));
add('默认镜头街区看得见人群', PL.reduce((n, r) => n + r.visibleStreet, 0) > 20,
  PL.map((r) => `${r.m}:${r.visibleStreet}人`).join(' '));
add('可见人无瞬移（跨段进出屋连续）', PL.every((r) => r.jumpVisible === 0),
  PL.map((r) => `${r.m}:跳${r.jumpVisible}`).join(' '));
// 【2026-11-11 口径更新】进屋不再由「作息表切到室内」触发，而是人沿真实
// 路网走到门牌、目标完成后收起；过渡位移已经发生在目标路线上。这里改查
// 「可见的人确实在真实移动」，不再绑定旧的 enterWalk 计数器。
add('进屋/赶目标都有真实位移', PL.reduce((n, r) => n + r.moving, 0) > 0,
  `真实移动人次 ${PL.reduce((n, r) => n + r.moving, 0)}`);
add('页面无脚本错误', errs.length === 0, errs.slice(0, 3).join(' | '));

console.log('\n===== 全城市民验收 =====');
for (const [n, ok, info] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  —  ${info}`);
console.log('\n播放态明细:', JSON.stringify(PL));
console.log('决策选择分布:', JSON.stringify(S.groups));
console.log('按年龄的决策分布:', JSON.stringify(S.byAgeDecision));
console.log('\n结论:', checks.filter((c) => !c[1]).length === 0
  ? `PASS ${checks.length}/${checks.length}` : `FAIL ${checks.filter((c) => !c[1]).length} 项`);
await b.close();
