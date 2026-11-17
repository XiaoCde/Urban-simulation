/** 全城 240 市民的一组实拍：用页面自带的官方机位看真实人群。 */
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
mkdirSync('../out/ui', { recursive: true });
const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--window-size=1600,960'],
});
const p = await b.newPage();
await p.setViewport({ width: 1600, height: 960 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
await p.evaluate(() => { window.__ready = false; window.__clock.setPlaying(false); });

const shot = async (name) => {
  try {
    await p.screenshot({ path: `../out/ui/${name}.jpg`, type: 'jpeg', quality: 86,
      captureBeyondViewport: false, timeout: 200000 });
    console.log('[shot]', name);
  } catch (e) { console.log('[shot] fail', name, String(e.message).slice(0, 70)); }
};

/** 用官方机位：crowd = 行人近景（街面眼高），crowdTop = 30m 俯视人流。
 *  这两个机位自带地形高程补偿，比手写相机坐标可靠得多。 */
const at = async (minute, view, name) => {
  const n = await p.evaluate(({ minute, view }) => {
    const C = window.__clock, PED = window.__ped, CROWD = window.__crowdLife;
    C.seek(minute); window.__frame(0, 3);
    if (window.__setView) window.__setView(view);
    window.__frame(0, 10);
    let vis = 0, near = 0;
    const cam = window.__camera;
    for (let i = 1; i < PED.peds.length; i++) {
      const q = CROWD.at(i, C.minute);
      if (!q.indoor && PED.peds[i].obj.visible) {
        vis++;
        if (PED.peds[i].obj.position.distanceTo(cam.position) < 80) near++;
      }
    }
    return { vis, near };
  }, { minute, view });
  console.log(`  ${name}: 街上可见 ${n.vis} 人 / 镜头 80m 内 ${n.near} 人`);
  await shot(name);
};

/** 贴身跟拍一个真实在走的行人：验证人物动作、落地、不穿模。 */
const closeUp = async (minute, name) => {
  const ok = await p.evaluate(({ minute }) => {
    const C = window.__clock, PED = window.__ped, CROWD = window.__crowdLife;
    const cam = window.__camera, ctl = window.__controls;
    C.seek(minute); window.__frame(0, 3);
    let best = -1;
    for (let i = 1; i < PED.peds.length; i++) {
      const q = CROWD.at(i, minute);
      if (!q.indoor && PED.peds[i].obj.visible && PED.peds[i].mode === 'net') { best = i; break; }
    }
    if (best < 0) return false;
    const pd = PED.peds[best], a = pd.obj.position, yaw = pd.yaw;
    const dx = Math.sin(yaw), dz = Math.cos(yaw);
    cam.position.set(a.x - dx * 6, a.y + 2.4, a.z - dz * 6);
    if (ctl) { ctl.target.set(a.x + dx * 10, a.y + 1.3, a.z + dz * 10); ctl.update(); }
    window.__frame(0, 8);
    return true;
  }, { minute });
  console.log(`  ${name}: 贴身跟拍 ${ok ? '成功' : '没找到街上的人'}`);
  await shot(name);
};

await at(20, 'crowd', 'city_01_0020_night');        // 深夜：路灯 + 夜班/夜归人群
await at(500, 'crowd', 'city_02_0830_morning');    // 上午：通勤与在外的人
await at(760, 'crowd', 'city_03_1240_noon');       // 午间街面近景
await at(760, 'crowdTop', 'city_04_1240_top');     // 午间俯视人流
await at(1090, 'crowdTop', 'city_05_1810_storm');  // 暴雨：全员避险
await at(1320, 'crowd', 'city_06_2200_night');     // 夜里：灯网 + 晚归人群
await closeUp(760, 'city_07_1240_closeup');        // 贴身跟拍：人物动作与落地
await at(720, 'city', 'city_08_1200_overhead');    // 全城俯视

const info = await p.evaluate(() => ({ stats: window.__crowdLife.stats() }));
console.log('统计:', JSON.stringify({ count: info.stats.count, byAge: info.stats.byAge,
  veteran: info.stats.veteran, rookie: info.stats.rookie,
  doors: info.stats.doors, maxDoorLoad: info.stats.maxDoorLoad }));
console.log('页面错误:', errs.length, errs.slice(0, 3).join(' | '));
await b.close();
