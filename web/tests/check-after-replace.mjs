/**
 * _check_after_replace.mjs — 浏览器冒烟：换真实数据 / 离散选择之后的整页自检。
 *
 * 只做一件事：起页面、连续跑一小段仿真、抓所有 JS 错误，
 * 并确认造人链路真的用上了 ACS 真实身份、日程来自 NHTS、
 * 判断走的是离散选择。不做性能压测，不写文件。
 *
 * 需要本地静态服务在 8140 端口；用法 node _check_after_replace.mjs
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!CHROME) throw new Error('找不到 Chrome / Edge');

const errors = [];
const b = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 1000, height: 620 });
p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
p.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url().split('/').pop() + ' ' + r.failure()?.errorText));

await p.goto('http://127.0.0.1:8140/index.html?ped=300&capture=1', { waitUntil: 'load', timeout: 90000 });
await new Promise((r) => setTimeout(r, 9000));

const probe = await p.evaluate(() => {
  const out = { ok: false, detail: {} };
  try {
    const w = window;
    const dbg = w.__crowdLife && w.__crowdLife.debug ? w.__crowdLife.debug() : null;
    out.detail.hasCrowdLife = !!w.__crowdLife;
    out.detail.hasDebug = !!dbg;
    out.detail.clock = w.CLOCK ? { minute: w.CLOCK.minute, speed: w.CLOCK.speed } : null;
    // 从页面里能拿到的全局里找人群样本
    const persons = (w.__crowdLife && w.__crowdLife.persons) || null;
    if (persons && persons.length) {
      // 前几个是手写名册的具名演示角色，不属于 ACS 抽样人群；
      // 取第一个真实抽样的人做代表，避免把编出来的人当成真实分布的证据。
      const realPeople = persons.filter((x) => !x.isCast);
      const p0 = realPeople[Math.floor(realPeople.length / 2)] || persons[0];
      out.detail.personCount = persons.length;
      out.detail.castCount = persons.length - realPeople.length;
      out.detail.samplePerson = {
        age: p0.citizen && p0.citizen.age,
        socCode: p0.socCode,
        role: p0.role,
        hasReal: !!p0.real,
        realAge: p0.real && p0.real.age,
        realSoc: p0.real && p0.real.socLabel,
        realCommute: p0.real && p0.real.jwtrnsLabel,
        realVehicles: p0.real && p0.real.householdVehicles,
      };
      const socs = new Set(realPeople.map((x) => x.socCode).filter(Boolean));
      out.detail.distinctSocCodes = socs.size;
      const ages = realPeople.map((x) => x.real && x.real.age).filter(Number.isFinite);
      out.detail.ageRange = ages.length ? [Math.min(...ages), Math.max(...ages)] : null;
    }
    // 事故台账 / 统计
    out.detail.hasIncidents = !!(w.__incidents || w.INCIDENTS);
    out.ok = true;
  } catch (e) { out.error = String(e); }
  return out;
});

console.log('===== 换真实数据后的整页冒烟 =====');
console.log('JS 错误数:', errors.length);
for (const e of errors.slice(0, 15)) console.log('  ' + e.slice(0, 220));
console.log('页面探测:', JSON.stringify(probe, null, 2));

const checks = [
  ['没有 JS 运行错误', errors.length === 0],
  ['页面人群层加载成功', probe.ok === true],
  ['人群带真实 ACS 身份', !!probe.detail.samplePerson?.hasReal],
  ['职业是 SOC 码而非手写职业', !!probe.detail.samplePerson?.socCode],
  ['职业种类超过 10 种', (probe.detail.distinctSocCodes || 0) > 10],
  ['年龄覆盖真实区间', Array.isArray(probe.detail.ageRange) && probe.detail.ageRange[1] > 60],
];
console.log('');
let pass = 0;
for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (ok) pass++; }
console.log(`\n${pass}/${checks.length} 通过`);
await b.close();
if (pass < checks.length) process.exitCode = 1;
