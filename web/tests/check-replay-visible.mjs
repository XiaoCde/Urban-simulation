/**
 * 阶段1 浏览器验收：事故回放人偶可见 + 定位到历史帧 + 水显示阈值。
 * 用户 2026-11-16 反馈「定位不到人、看不到人在哪、全城都要被淹」。
 *
 * 验四件事：
 *  ① 拖帧后人偶 visible=true 且摆到那一帧的 x/z；
 *  ② 人偶 y 贴真实地形（= __terrY(x,z)），不埋进地形或飘空；
 *  ③ 人偶颜色随状态取值（dead 红 / stranded 橙 / 其余青黄绿）；
 *  ④ 回放人偶接口存在、无脚本错误、水显示阈值已抬到 3 cm。
 *
 * 需要本地静态服务在 8140 端口；只做短时连续推进，不做 24h 压测。
 */
import puppeteer from 'puppeteer-core';
import { existsSync, readFileSync } from 'node:fs';

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

const p = await b.newPage();
await p.setViewport({ width: 1000, height: 620 });
const errors = [];
p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1');
u.searchParams.set('ped', '300');
u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });

// 接口存在
const hasApi = await p.evaluate(() => typeof window.__replayView === 'function');
check('回放人偶调试接口已暴露', hasApi);

// 连续推进到降雨出事
await p.evaluate(() => {
  const C = window.__clock, PED = window.__ped, F = window.__flood;
  window.__manualDrive = true;
  C.setPlaying(false);
  C.setSpeed(24);
  C.seek(1140);                       // 19:00
  if (PED.live) PED.live.reset(1140, PED.peds);
  if (F && F.fb) F.fb.reset();
  C.setPlaying(true);
});
await p.evaluate(() => window.__frame(0.1, 2400, true));

// 选第一个个案，拖到中间帧，点定位
const view = await p.evaluate(() => {
  const INC = window.__ped.incidents;
  const list = INC.cases(100);
  const pick = document.getElementById('casePick');
  const frame = document.getElementById('caseFrame');
  const go = document.getElementById('caseGo');
  if (!list.length) return { noCase: true };
  pick.value = String(list[0].i);
  pick.dispatchEvent(new Event('change'));
  const n = Number(frame.max);
  frame.value = String(Math.floor(n / 2));
  frame.dispatchEvent(new Event('input'));
  go.click();
  const v = window.__replayView();
  const gy = window.__terrY ? window.__terrY(v.x, v.z) : null;
  return {
    noCase: false,
    visible: v.visible,
    x: v.x, z: v.z, y: v.y,
    frameX: v.frame ? v.frame.x : null,
    frameZ: v.frame ? v.frame.z : null,
    frameState: v.frame ? v.frame.st : null,
    // 【2026-11-17】室内帧的人偶会摆在楼层高度（含地下层夹到地面），
    // 所以"贴地形"只对室外帧成立；室内帧改为"不埋地、不飘到离谱高处"。
    frameIndoor: !!(v.frame && v.frame.indoor),
    frameFl: v.frame ? v.frame.fl : null,
    color: v.color,
    groundY: gy,
    n,
  };
});

if (view.noCase) {
  console.log('     （本场短时未出事故，跳转下一段由纯 Node 个案验收覆盖）');
  check('个案清单至少有一条（本场）', false);
} else {
  check('拖帧+定位后人偶可见', view.visible === true);
  check('人偶摆到历史帧 x/z',
    Math.abs(view.x - view.frameX) < 0.15 && Math.abs(view.z - view.frameZ) < 0.15,
    `人偶(${view.x},${view.z}) 帧(${view.frameX},${view.frameZ})`);
  if (view.frameIndoor) {
    // 室内：y 应在地形之上（不埋），且不超过该层合理高度（住宅层高 2.7 m）
    const rel = view.groundY == null ? 0 : view.y - view.groundY;
    check('室内帧人偶摆在该层高度（不埋地、不飘到楼顶以上）',
      view.groundY == null || (rel > -0.05 && rel < 3.0 * 6),
      `人偶y=${view.y} 地形=${view.groundY} 相对=${rel.toFixed(2)} m 第 ${view.frameFl} 层`);
  } else {
    check('人偶 y 贴真实地形（不埋地/不飘空）',
      view.groundY == null || Math.abs(view.y - view.groundY) < 0.2,
      `人偶y=${view.y} 地形=${view.groundY}`);
  }
  const st = view.frameState;
  const expectRed = st === 'dead', expectOrange = st === 'stranded';
  const colorOk = expectRed ? view.color === 0xff2020
    : expectOrange ? view.color === 0xff6a00
    : [0xffc400, 0x2ee66b, 0xffe14d, 0x00e5ff].includes(view.color);
  check('人偶颜色随状态取值', colorOk, `st=${st} color=0x${view.color.toString(16)}`);
}

// 定位按钮：相机目标精确对上个案坐标（用户抱怨的「定位不到」回归点）
const cam = await p.evaluate(() => {
  document.getElementById('caseGo').click();
  // 对准的是「当前选中帧」，即 __replayView 里人偶所在帧，不是台账第一例。
  const v = window.__replayView();
  return {
    hasFrame: !!v.frame,
    fx: v.frame ? v.frame.x : null, fz: v.frame ? v.frame.z : null,
    tgtX: window.__controls.target.x, tgtZ: window.__controls.target.z,
  };
});
if (cam.hasFrame) {
  check('点定位后相机目标对准个案坐标',
    Math.abs(cam.tgtX - cam.fx) < 1 && Math.abs(cam.tgtZ - cam.fz) < 1,
    `相机目标(${cam.tgtX.toFixed(1)},${cam.tgtZ.toFixed(1)}) 个案(${cam.fx},${cam.fz})`);
}

// 水显示阈值源码检查（着色器已抬到 3 cm）
const src = readFileSync(new URL('../src/flood.js', import.meta.url), 'utf8');
check('积水显示阈值已抬到 3 cm（只改观感不改数值）',
  src.includes('if (d < 0.03) discard;') && !src.includes('if (d < 0.01) discard;'));

check('回放页无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
await p.close();
await b.close();
const failed = ok.filter((x) => !x).length;
console.log(`\n${ok.length - failed}/${ok.length} 通过`);
process.exit(failed ? 1 : 0);
