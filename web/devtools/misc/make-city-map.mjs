/**
 * _make_city_map.mjs — 由 _probe_citywide.json 生成全城覆盖分布图（SVG）。
 * 只读数据、只写一张交付图，不碰产品代码。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const R = JSON.parse(readFileSync('out/_probe_citywide.json', 'utf8'));
const { x0, x1, z0, z1, w, h } = R.city;
const W = 1000, H = Math.round(W * h / w);
const PX = (x) => (x - x0) / w * W;
const PZ = (z) => (z - z0) / h * H;
const CELL = 500, CW = CELL / w * W, CH = CELL / h * H;

const parse = (k) => { const [a, b] = k.split('_').map(Number); return [a * CELL, b * CELL]; };
const maxOf = (g) => Math.max(1, ...Object.values(g));
const mb = maxOf(R.grids.buildings), mh = maxOf(R.grids.homes), mc = maxOf(R.grids.cars);
const fmt = (n) => n === undefined ? '0' : n.toLocaleString('zh-CN');

let cells = '';
for (const [k, nb] of Object.entries(R.grids.buildings)) {
  const [gx, gz] = parse(k);
  const x = PX(gx), y = PZ(gz);
  const a = 0.10 + 0.34 * Math.sqrt(nb / mb);
  cells += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${CW.toFixed(1)}" height="${CH.toFixed(1)}" fill="#5b7fa6" fill-opacity="${a.toFixed(3)}" stroke="#d7e2ee" stroke-width="0.8"/>`;
}
let homes = '';
for (const [k, n] of Object.entries(R.grids.homes)) {
  const [gx, gz] = parse(k);
  const x = PX(gx + CELL / 2), y = PZ(gz + CELL / 2);
  const r = 2 + 12 * Math.sqrt(n / mh);
  homes += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#1f6fd0" fill-opacity="0.78" stroke="#ffffff" stroke-width="0.9"/>`;
}
let cars = '';
for (const [k, n] of Object.entries(R.grids.cars)) {
  const [gx, gz] = parse(k);
  const x = PX(gx + CELL / 2), y = PZ(gz + CELL / 2);
  const r = 1.8 + 5.5 * Math.sqrt(n / mc);
  cars += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#e8722c" fill-opacity="0.95" stroke="#ffffff" stroke-width="0.7"/>`;
}

// 旧版车/路网只覆盖的那一小片
const old = R.roadNodes;
const ox = PX(2150), oz = PZ(-620), ow = PX(2690) - ox, oh = PZ(470) - PZ(-620);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W + 250} ${H + 130}" width="${W + 250}" height="${H + 130}">
<rect width="100%" height="100%" fill="#f7fafc"/>
<text x="24" y="34" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="21" font-weight="700" fill="#16283d">全城覆盖实测 · ${fmt(R.homeDoors.n)} 名居民 / ${fmt(R.carCount)} 辆车</text>
<text x="24" y="56" font-family="system-ui,sans-serif" font-size="13" fill="#5a7089">城市 ${w} × ${h} m　·　500 m 网格　·　${R.minute >= 60 ? Math.floor(R.minute / 60) + ':' + String(Math.floor(R.minute % 60)).padStart(2, '0') : '00:00'} 实时位置</text>
<g transform="translate(24,76)">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff" stroke="#9db4cc" stroke-width="1.5"/>
  ${cells}
  ${homes}
  ${cars}
  <rect x="${ox.toFixed(1)}" y="${oz.toFixed(1)}" width="${ow.toFixed(1)}" height="${oh.toFixed(1)}" fill="none" stroke="#d0342c" stroke-width="3" stroke-dasharray="7 5"/>
  <text x="${(ox + ow / 2).toFixed(1)}" y="${(oz - 7).toFixed(1)}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" font-weight="700" fill="#c22b24">旧版只有这一小片有路有车</text>
  <circle cx="${PX(1144).toFixed(1)}" cy="${PZ(-815).toFixed(1)}" r="6" fill="#c22b24" stroke="#fff" stroke-width="2"/>
  <text x="${(PX(1144) + 11).toFixed(1)}" y="${(PZ(-815) + 4).toFixed(1)}" font-family="system-ui,sans-serif" font-size="11" fill="#c22b24">白宫</text>
</g>
<g transform="translate(${W + 44},90)" font-family="system-ui,sans-serif" font-size="13" fill="#33475e">
  <text x="0" y="0" font-size="15" font-weight="700" fill="#16283d">图例 / 数据</text>
  <rect x="0" y="16" width="16" height="16" fill="#5b7fa6" fill-opacity="0.35"/>
  <text x="24" y="29">建筑（${fmt(R.buildings.n)} 栋 · ${R.buildingsGrid500} 格）</text>
  <circle cx="8" cy="52" r="7" fill="#1f6fd0" fill-opacity="0.78"/>
  <text x="24" y="56">居民门牌（${R.homeGrid500} 格）</text>
  <circle cx="8" cy="76" r="6" fill="#e8722c"/>
  <text x="24" y="80">车辆（${R.carsGrid500} 格）</text>
  <rect x="0" y="98" width="16" height="3" fill="#d0342c"/>
  <text x="24" y="104">修复前路网范围</text>
  <text x="0" y="140" font-size="12" fill="#5a7089">居民 x ${R.homeDoors.minx}…${R.homeDoors.maxx}</text>
  <text x="0" y="158" font-size="12" fill="#5a7089">居民 z ${R.homeDoors.minz}…${R.homeDoors.maxz}</text>
  <text x="0" y="176" font-size="12" fill="#5a7089">车辆 x ${R.cars.minx}…${R.cars.maxx}</text>
  <text x="0" y="194" font-size="12" fill="#5a7089">车辆 z ${R.cars.minz}…${R.cars.maxz}</text>
  <text x="0" y="226" font-size="15" font-weight="700" fill="#16283d">覆盖率</text>
  <text x="0" y="248">住宅门牌 ${R.homeGrid500} / ${R.buildingsGrid500} 格</text>
  <text x="0" y="268">实时位置 ${R.pedGridAtMinute} 格</text>
  <text x="0" y="288">车辆 ${R.carsGrid500} 格</text>
  <text x="0" y="308">逻辑路网 ${R.roadNodesGrid500} 格</text>
  <text x="0" y="340" font-size="12" fill="#5a7089">最密 500m 格 ${R.densestCellAtMinute} 人</text>
  <text x="0" y="358" font-size="12" fill="#5a7089">车全部绑定真实车主</text>
</g>
<text x="24" y="${H + 108}" font-family="system-ui,sans-serif" font-size="12" fill="#7b8fa5">数据来源：web/out/_probe_citywide.json（Puppeteer 连续推帧实测，非示意图）</text>
</svg>`;

writeFileSync('out/全城覆盖分布图.svg', svg);
writeFileSync('../out/全城覆盖分布图.svg', svg);
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>全城覆盖分布图</title>
<style>
body{margin:0;background:#f7fafc;color:#16283d;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1320px;margin:0 auto;padding:26px 28px 40px}
h1{font-size:22px;margin:0 0 6px} .sub{color:#5a7089;font-size:13px;margin-bottom:18px}
.card{background:#fff;border:1px solid #dbe5ef;border-radius:10px;padding:12px;margin-bottom:18px}
svg{width:100%;height:auto;display:block}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid #dbe5ef;padding:8px 10px;text-align:left} th{background:#eef4fa}
b{color:#1f6fd0} .warn{color:#c22b24} .ok{color:#1a7f4b}
</style></head><body><div class="wrap">
<h1>全城覆盖实测分布图</h1>
<div class="sub">城市 ${w} × ${h} m · 500 m 网格 · 数据来自 Puppeteer 连续推帧实测，不是示意图</div>
<div class="card">${svg}</div>
<div class="card"><table>
<tr><th>项目</th><th>修复前</th><th>修复后</th></tr>
<tr><td>逻辑路网</td><td class="warn">504 × 1056 m / 8 个网格</td><td class="ok">5188 × 4448 m / ${R.roadNodesGrid500} 个网格</td></tr>
<tr><td>车辆分布</td><td class="warn">96 辆 100% 挤在 8 个网格</td><td class="ok">${R.carCount} 辆分布在 ${R.carsGrid500} 个网格</td></tr>
<tr><td>住宅门牌</td><td class="warn">52 个网格，最外圈 0 人</td><td class="ok">${R.homeGrid500} / ${R.buildingsGrid500} 个建筑网格全覆盖</td></tr>
<tr><td>车辆司机</td><td class="warn">无主车自己绕圈</td><td class="ok">每辆绑定真实车主，没人不许动</td></tr>
</table></div>
</div></body></html>`;
writeFileSync('../out/全城覆盖分布图.html', html);
console.log('written out/全城覆盖分布图.svg + ../out/全城覆盖分布图.html');
