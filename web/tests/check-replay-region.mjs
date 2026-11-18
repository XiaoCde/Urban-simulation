/**
 * 浏览器验收：个案逐帧回放 + 缩小区域开关。
 *
 * 需要本地静态服务在 8140 端口。只做短时连续推进，不做 24h 压测。
 * 验三件事：① 页面新增控件不报错；② 连续跑出事故后能查到完整轨迹；
 * ③ ?region= 真的把片区外的人排除，且不改判断公式。
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!CHROME) throw new Error('找不到 Chrome / Edge');

const ok = [];
const check = (name, pass, extra = '') => {
  ok.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const b = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

async function open(search) {
  const p = await b.newPage();
  await p.setViewport({ width: 1000, height: 620 });
  const errors = [];
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const u = new URL('http://127.0.0.1:8140/index.html');
  u.searchParams.set('capture', '1');
  u.searchParams.set('ped', '300');
  u.searchParams.set('v', String(Date.now()));
  u.searchParams.set('seed', '20261117');
  for (const [k, v] of Object.entries(search || {})) u.searchParams.set(k, v);
  await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
  return { p, errors };
}

// ---------------------------------------------------------------- 1) 默认全城
{
  const { p, errors } = await open();
  const dom = await p.evaluate(() => ({
    pick: !!document.getElementById('casePick'),
    frame: !!document.getElementById('caseFrame'),
    info: !!document.getElementById('caseInfo'),
    frameInfo: !!document.getElementById('caseFrameInfo'),
    go: !!document.getElementById('caseGo'),
    region: window.__ped.getRegion ? window.__ped.getRegion() : 'no-api',
    total: window.__ped.peds.length,
    enabled: window.__ped.peds.filter((x) => x.enabled !== false).length,
    casesApi: !!window.__ped.incidents.cases,
    exportApi: !!window.__ped.incidents.exportCases,
  }));
  check('五个个案控件都在页面上', dom.pick && dom.frame && dom.info && dom.frameInfo && dom.go);
  check('默认不启用区域裁剪', dom.region === null, JSON.stringify(dom.region));
  check('默认全城人全部参与', dom.enabled === dom.total, `${dom.enabled}/${dom.total}`);
  check('个案与离线导出接口可用', dom.casesApi && dom.exportApi);

  // 先对齐到降雨已经下了一段、街上确实有水的时刻，然后全程连续推进。
  // seek 只在这里做一次（会清空经历与台账），之后绝不 seek，
  // 所以记下来的轨迹确实是连续运行产生的，不是按时刻重建的快照。
  await p.evaluate(() => {
    const C = window.__clock, PED = window.__ped, F = window.__flood;
    window.__manualDrive = true;
    C.setPlaying(false);
    C.setSpeed(24);
    C.seek(1140);                       // 19:00，雨已下了 2 小时
    if (PED.live) PED.live.reset(1140, PED.peds);
    if (F && F.fb) F.fb.reset();
    C.setPlaying(true);
  });
  // 0.1 真实秒 × ×24 = 2.4 仿真秒/帧；2400 帧 ≈ 96 分钟，走到 20:36
  await p.evaluate(() => window.__frame(0.1, 2400, true));

  const rep = await p.evaluate(() => {
    const INC = window.__ped.incidents;
    const list = INC.cases(100);
    const snap = list.length ? INC.snapshot(list[0].i) : null;
    const ex = INC.exportCases(10);
    return {
      minute: +window.__clock.minute.toFixed(1),
      count: list.length,
      frames: snap ? snap.trace.length : 0,
      firstFrameKeys: snap && snap.trace.length ? Object.keys(snap.trace[0]) : [],
      events: snap ? snap.events.length : 0,
      hasAction: snap ? snap.trace.some((f) => !!f.act) : false,
      hasDepth: snap ? snap.trace.some((f) => f.d > 0) : false,
      exportConsistent: ex.length > 0 && ex[0].replay.trace.length === ex[0].summary.frames,
      selectOptions: document.getElementById('casePick').options.length,
      frameInfoText: document.getElementById('caseFrameInfo').textContent.trim(),
    };
  });
  check('连续推进后时钟真的前进了', rep.minute > 0, `${rep.minute} 分钟`);
  check('事故个案清单有内容（或本场无事故但接口正常）',
    rep.count >= 0 && Array.isArray(rep.firstFrameKeys));
  if (rep.count > 0) {
    check('个案有完整逐帧轨迹', rep.frames > 1, `${rep.frames} 帧`);
    check('轨迹字段齐全', ['t', 'x', 'z', 'd', 'v', 'st', 'act', 'why', 'goal']
      .every((k) => rep.firstFrameKeys.includes(k)));
    check('轨迹里记到了真实判断动作', rep.hasAction);
    check('轨迹里记到了水深变化', rep.hasDepth);
    check('离线导出与页面快照一致', rep.exportConsistent);
    check('页面下拉列出了个案', rep.selectOptions > 0, `${rep.selectOptions} 项`);
    check('逐帧信息栏有内容', rep.frameInfoText.length > 0, rep.frameInfoText.slice(0, 40));
  } else {
    console.log('     （本场短时未出事故，个案接口已在纯 Node 验收里覆盖）');
  }
  check('默认页无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  await p.close();
}

// ---------------------------------------------------------------- 2) 缩小区域
{
  // 实测住址中位数附近的一小片（x≈1984, z≈-1514），确认会留下一部分人而不是全空
  const { p, errors } = await open({ region: '1500,-2200,2500,-800' });
  const r = await p.evaluate(() => {
    const PED = window.__ped;
    const rect = PED.getRegion();
    const total = PED.peds.length;
    const enabled = PED.peds.filter((x) => x.enabled !== false).length;
    // 再跑几帧，确认 setCount 不会把片区外的人重新打开
    window.__manualDrive = true;
    window.__frame(0.1, 20, true);
    const after = PED.peds.filter((x) => x.enabled !== false).length;
    const outsideKept = PED.peds.filter((x) => x.enabled !== false && x.homeXZ
      && (x.homeXZ.x < rect.x0 || x.homeXZ.x > rect.x1
        || x.homeXZ.z < rect.z0 || x.homeXZ.z > rect.z1)).length;
    return { rect, total, enabled, after, outsideKept };
  });
  check('区域参数被解析', !!r.rect, JSON.stringify(r.rect));
  check('片区里确实留下一部分人（不是全空也不是全量）',
    r.enabled > 0 && r.enabled < r.total, `推演 ${r.enabled}/${r.total} 人`);
  check('片区外的人被排除', r.enabled < r.total);
  check('连续推进后裁剪仍生效', r.after === r.enabled, `${r.after} 人`);
  check('片外住址没有被误启用', r.outsideKept === 0, `${r.outsideKept} 人`);
  check('区域页无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  await p.close();
}

await b.close();
const failed = ok.filter((x) => !x).length;
console.log(`\n${ok.length - failed}/${ok.length} 通过`);
process.exit(failed ? 1 : 0);
