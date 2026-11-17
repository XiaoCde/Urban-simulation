/**
 * control.js — 统一控制栏目（唯一的人机入口）
 *
 * 左：雨强档位 mm/h ／ 中：0:00–24:00 时间轴 ／ 右：河道增水 m。
 * 三项都作用在「同一个统一内核」预计算的 24h 帧序列上：
 *   · 档位 → FLOOD.setParams() 立刻换一套帧（不重算水动力，几十 ms）
 *   · 时间轴 → FLOOD 绑的 CLOCK.seek()，水 / 人 / 车一起重放
 *   · 下方曲线 = 这一档的 24h 积水涨退全过程，游标跟着时钟走
 *
 * 旧的两根滑块（#flRange 帧号、#mkRange 52–95 分钟）全部退役。
 */
import { dayClockText } from './clock.js';
import { crowdState } from './day-schedule.js';

export function createControl({ flood, clock, onWater, waterOn = true }) {
  const $ = (id) => document.getElementById(id);
  const rainBox = $('ctlRain'), surgeBox = $('ctlSurge');
  const curve = $('ctlCurve');
  if (!rainBox || !surgeBox) return null;

  let rainVal = 40, surgeVal = 2;
  let idx = null;
  let waterVisible = waterOn;
  const SPEEDS = [1, 2, 4, 6, 12, 24];

  function phaseText(min) {
    if (!flood.manifest) return '载入中';
    const a = flood.rainStart, b = flood.rainEnd;
    // 【全天雨】降雨窗口铺满 0–24 h 时，没有「起雨/雨停」两个时刻可报，
    // 改成报「已经下了几小时」，别再显示「降雨中 · 已下 80 分钟」这种
    // 从 17:00 起算的旧口径（用户反馈时间轴和文案对不上）。
    if (b - a >= 1439) return `全天降雨 · 已下 ${(min / 60).toFixed(1)} 小时`;
    if (min < a) return `降雨前 · ${Math.round(a - min)} 分钟后起雨`;
    if (min < b) return `降雨中 · 已下 ${Math.round(min - a)} 分钟`;
    return `退水中 · 雨停 ${Math.round(min - b)} 分钟`;
  }

  // ---------------------------------------------------------------- 曲线
  function drawCurve(min) {
    if (!curve) return;
    const c = idx && idx.cases
      ? idx.cases.find((q) => q.name === flood.caseName) : null;
    const pts = c ? c.curve : [];
    const W = 600, H = 26;
    let svg = '';
    // 降雨窗口底色（全天雨时就是整条）
    const x = (t) => (t / 1440) * W;
    svg += `<rect x="${x(flood.rainStart)}" y="0" width="${x(flood.rainEnd) - x(flood.rainStart)}" `
      + `height="${H}" fill="rgba(226,164,92,.14)"/>`;
    if (pts.length > 1) {
      const mx = Math.max(1, ...pts.map((p) => p[1]));
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},`
        + `${(H - 2 - (p[1] / mx) * (H - 4)).toFixed(1)}`).join(' ');
      svg += `<path d="${d}" fill="none" stroke="#5aa9ee" stroke-width="1.6"/>`;
      // 【峰值必须画在曲线上】用户反馈「时间轴和底下峰值标的对不上」——
      // 旧版只有一条游标线，峰值只能靠猜。这里在 wet_ha 最大处插一个 ▲，
      // 它和曲线同一个坐标变换，不可能再错位。
      let bi = 0;
      for (let i = 1; i < pts.length; i++) if (pts[i][1] > pts[bi][1]) bi = i;
      const px = x(pts[bi][0]), py = H - 2 - (pts[bi][1] / mx) * (H - 4);
      svg += `<path d="M${px.toFixed(1)},${(py - 5).toFixed(1)} l-3.2,5 h6.4 z" fill="#ffd9a0"/>`;
      svg += `<line x1="${px.toFixed(1)}" y1="0" x2="${px.toFixed(1)}" y2="${H}" `
        + `stroke="rgba(255,217,160,.35)" stroke-width="1" stroke-dasharray="2 3"/>`;
    }
    svg += `<line x1="${x(min).toFixed(1)}" y1="0" x2="${x(min).toFixed(1)}" y2="${H}" `
      + `stroke="#ffd9a0" stroke-width="1.5"/>`;
    curve.innerHTML = svg;
  }

  // ---------------------------------------------------------------- 档位
  function markTiers(box, val) {
    for (const b of box.querySelectorAll('button')) {
      b.classList.toggle('on', Number(b.dataset.v) === Number(val));
    }
  }
  async function applyParams(p, s, force) {
    rainVal = p; surgeVal = s;
    $('ctlRainVal').textContent = String(p);
    $('ctlSurgeVal').textContent = String(s);
    markTiers(rainBox, p); markTiers(surgeBox, s);
    const c = await flood.setParams(p, s);
    if (c) $('ctlCase').textContent = `统一内核 · ${c.frames} 帧 · 峰 ${c.peak_wet_ha} ha`;
    drawCurve(clock.minute);
    if (force) update();
  }

  function buildTiers(box, arr, cur, unit, cb) {
    box.innerHTML = arr.map((v) =>
      `<button data-v="${v}" class="${v === cur ? 'on' : ''}">${v}${unit}</button>`).join('');
    box.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-v]');
      if (b) cb(Number(b.dataset.v));
    });
  }

  // ---------------------------------------------------------------- 每帧刷新
  function update() {
    const min = clock.minute;
    const el = $('ctlClock'); if (el) el.textContent = dayClockText(min);
    const ph = $('ctlPhase'); if (ph) ph.textContent = phaseText(min);
    const pl = $('ctlPlay'); if (pl) pl.textContent = clock.playing ? '暂停' : '播放';
    const sp = $('ctlSpeed'); if (sp) sp.textContent = '×' + clock.speed;
    const wt = $('ctlWater'); if (wt) wt.textContent = waterVisible ? '水面 开' : '水面 关';
    const tr = $('ctlTrap');
    if (tr) {
      const c = crowdState(min);
      const st = (window.__ped && window.__ped.fleeStats)
        ? window.__ped.fleeStats() : null;
      // 【2026-11-10】街面人数改成社会层的真实逐人统计：旧 crowdState
      // 是 24 人时代的固定表（夜里 4 人、白天 24 人），全城 240 人铺开后
      // 面板会和画面严重对不上。按分钟缓存，避免每帧遍历几百人。
      const CL = window.__crowdLife;
      let streetN = c.count, indoorN = '';
      if (CL && CL.persons && CL.persons.length) {
        const mk = Math.floor(min);
        const cache = window.__crowdStreetCache;
        if (!cache || cache.m !== mk) {
          let n = 0;
          for (let i = 0; i < CL.persons.length; i++) if (!CL.at(i, min).indoor) n++;
          window.__crowdStreetCache = { m: mk, n, total: CL.persons.length };
        }
        streetN = window.__crowdStreetCache.n;
        indoorN = ` / 室内 ${window.__crowdStreetCache.total - streetN} 人`;
      }
      tr.textContent = `${c.dayLabel} · 街上 ${streetN} 人${indoorN}`
        + (st ? ` · 被困 ${st.trapped ?? 0}` : '');
    }
    drawCurve(min);
    const fbEl = $('ctlFB');
    if (fbEl && flood.fb) {
      const s = flood.fb.stats();
      const d = s.maxDelay >= 0.05 ? `${s.maxDelay.toFixed(1)} min` : '0';
      // 壅高按厘米显示，低于 2 mm 就不报（那是四舍五入噪声，不是现象）
      const cm = s.maxDisp > 0.002 ? ` · 壅高 ${(s.maxDisp * 100).toFixed(1)} cm` : '';
      fbEl.textContent = s.cells === 0
        ? '人流扰动 · 全场无涉水，水按预计算退'
        : `人流扰动 · 涉水 ${s.waders} 人车 · 扰动 ${s.cells} 格 · 退水延滞 ${d}${cm}`
          + (s.gain === 1 ? '' : ` · 增益 ×${s.gain}`);
    }
  }

  async function init() {
    idx = await flood.loadIndex();
    const rains = idx.rain_tiers || [20, 40, 80, 120];
    const surges = idx.surge_tiers || [0, 2, 4];
    rainVal = rains[0];                    // 与 main.js 的默认工况 u_p8_s0 对齐
    // 【2026-11-17】默认增水改 0：主场景定为"纯降雨内涝"。
    // 同一场雨下增水 0/2/4 m 的峰值湿区是 385.5／390.5／398.1 ha，
    // 差不到 3%，说明淹没范围是雨决定的；但增水会把河岸一带抬高，
    // 混进来就不是"城市内涝"这个情境了，所以主场景不叠增水。
    surgeVal = surges[0];
    buildTiers(rainBox, rains, rainVal, '', (v) => applyParams(v, surgeVal, true));
    buildTiers(surgeBox, surges, surgeVal, 'm', (v) => applyParams(rainVal, v, true));
    $('ctlRainVal').textContent = String(rainVal);
    $('ctlSurgeVal').textContent = String(surgeVal);

    $('ctlSpeed').addEventListener('click', () => {
      const i = (SPEEDS.indexOf(clock.speed) + 1) % SPEEDS.length;
      clock.setSpeed(SPEEDS[i]); update();
    });
    $('ctlWater').addEventListener('click', () => {
      waterVisible = !waterVisible;
      if (onWater) onWater(waterVisible);
      update();
    });
    // #ctlTime / #ctlPlay 由 flood.js 的 bindHud 统一绑定（一根时间轴只绑一次）
    await applyParams(rainVal, surgeVal, true);
    setInterval(update, 250);
    update();
  }
  init().catch((e) => console.warn('[control] 初始化失败：', e && e.message));

  return { update, applyParams, get params() { return { p: rainVal, s: surgeVal }; } };
}
