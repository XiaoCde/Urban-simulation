# -*- coding: utf-8 -*-
"""把流速接入打到草稿副本上（不动 web/src，等 sweep_v3_tl 跑完再整体复制回去）。

用法：python tools/apply_velocity_patch.py --apply
默认只做 dry-run，打印每处匹配到的行号。
"""
import argparse
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(ROOT, 'web', 'out', '_drafts', 'lib')

FLOOD_STATE = ("  const cache = new Map();        // file -> Uint8Array\n", """  const cache = new Map();        // file -> Uint8Array
  // 【2026-11-20 流速】每帧多两张 u8：流速大小（开方量化，量程见 manifest.velocity）
  // 与流向。只在有人真的踩进水里时才取，干格不下这个下载。
  const cacheV = new Map();       // file -> Uint8Array 流速
  const cacheG = new Map();       // file -> Uint8Array 流向
""")

FLOOD_CLEAR = ("    cache.clear();\n", """    cache.clear();
    cacheV.clear(); cacheG.clear();
""")

FLOOD_HELPERS = ("""  // ---------------------------------------------------------------- 采样
""", """  /**
   * 取第 i 帧的流速 / 流向图。旧工况（没有 vel 帧）一律返回 null，
   * 采样侧据此记 0 —— 不许编一个速度出来。
   */
  const wantingV = new Set();
  function bytesOfKind(i, kind) {
    const f = man && man.frames[i];
    if (!f || typeof f[kind] !== 'string') return null;
    const map = kind === 'vel' ? cacheV : cacheG;
    const k = ckey(curDir, f[kind]);
    const b = map.get(k);
    if (b) return b;
    // 和 bytesOf 同一个思路：宁可用邻帧，也不能把「有流速」说成「没流速」。
    for (let d = 1; d <= 4; d++) {
      for (const j of [i - d, i + d]) {
        const g = man.frames[j];
        if (!g || typeof g[kind] !== 'string') continue;
        const nb = map.get(ckey(curDir, g[kind]));
        if (nb) { wantKind(f, kind); return nb; }
      }
    }
    wantKind(f, kind);
    return null;
  }
  function wantKind(f, kind) {
    const file = f && f[kind];
    if (!file || wantingV.has(file)) return;
    wantingV.add(file);
    const map = kind === 'vel' ? cacheV : cacheG;
    fetch(man.root + file, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((ab) => {
        if (!ab) return;
        const u = new Uint8Array(ab);
        if (u.length) map.set(ckey(curDir, file), u);
      })
      .catch(() => {})
      .finally(() => wantingV.delete(file));
  }

  // ---------------------------------------------------------------- 采样
""")

FLOOD_SAMPLE = ("""  /** 空间双线性 + 帧间线性，返回米。 */""", """  /**
   * 流速采样（m/s + x/z 分量）。复用与水深相同的「空间双线性 + 帧间线性」，
   * 但先把角度换成向量再插值 —— 直接插值角度会在 0/2π 接缝上算出反向流。
   * 所有角点都是干格（没有流速）时返回 0。
   */
  const _fl = { sp: 0, ux: 0, uz: 0 };
  function sampleFlow(x, z, t, out) {
    out = out || _fl;
    out.sp = 0; out.ux = 0; out.uz = 0;
    if (!man || !Array.isArray(man.frames)) return out;
    const vel = man.velocity;
    if (!vel || !(vel.speed_scale_mps > 0)) return out;
    const { cols, rows, step_m: step, x0, z0 } = man;
    const px = Number(x), pz = Number(z);
    if (!Number.isFinite(px) || !Number.isFinite(pz) || !(step > 0)) return out;
    const fx = (px - x0) / step - 0.5;
    const fz = (pz - z0) / step - 0.5;
    if (!(fx >= -1) || !(fz >= -1) || fx > cols || fz > rows) return out;
    let c0 = Math.floor(fx), r0 = Math.floor(fz);
    const tx = fx - c0, tz = fz - r0;
    const c1 = Math.min(cols - 1, c0 + 1), r1 = Math.min(rows - 1, r0 + 1);
    c0 = Math.max(0, Math.min(cols - 1, c0)); r0 = Math.max(0, Math.min(rows - 1, r0));
    const { i0, i1, f } = bracket(t);
    const v0 = bytesOfKind(i0, 'vel'), g0 = bytesOfKind(i0, 'dir');
    if (!v0 || !g0) return out;
    const blend = i1 !== i0 && f > 1e-4;
    const v1 = blend ? bytesOfKind(i1, 'vel') : null;
    const g1 = blend ? bytesOfKind(i1, 'dir') : null;
    const scale = vel.speed_scale_mps;
    const n = cols * rows;
    let wsum = 0, sumSp = 0, sumUx = 0, sumUz = 0;
    for (let k = 0; k < 4; k++) {
      const c = k & 1 ? c1 : c0, r = k >>> 1 ? r1 : r0;
      const w = (k & 1 ? tx : 1 - tx) * (k >>> 1 ? tz : 1 - tz);
      if (!(w > 0)) continue;
      const i = r * cols + c;
      if (i >= n) continue;
      let sv = v0[i];
      if (v1 && i < v1.length) sv += (v1[i] - sv) * f;
      if (!(sv > 0)) continue;                 // 干格不记流速，权重让给湿格
      let sa = g0[i];
      if (g1 && i < g1.length) sa += (g1[i] - sa) * f;
      const q = sv / 255;
      const sp = scale * q * q;                // 与导出时的开方量化对应
      const ang = (sa / 255) * Math.PI * 2 - Math.PI;
      sumSp += sp * w;
      sumUx += Math.cos(ang) * w;
      sumUz += Math.sin(ang) * w;
      wsum += w;
    }
    if (!(wsum > 1e-9)) return out;
    const sp = sumSp / wsum;
    const mag = Math.hypot(sumUx, sumUz) / wsum;
    out.sp = sp;
    if (mag > 1e-6) {
      out.ux = (sumUx / wsum) / mag * sp;
      out.uz = (sumUz / wsum) / mag * sp;
    }
    return out;
  }

  /** 空间双线性 + 帧间线性，返回米。 */""")

FLOOD_DINFO = ("""  function depthInfo(x, z, out) {
    out = out || _samp;
    const d = depthAt(x, z);
    out.d = d;
    out.wet = d >= 0.12;      // 12 cm 以上行人就当路断了（齐踝）
    return out;
  }""", """  function depthInfo(x, z, out) {
    out = out || _samp;
    const d = depthAt(x, z);
    out.d = d;
    out.wet = d >= 0.12;      // 12 cm 以上行人就当路断了（齐踝）
    // 【2026-11-20 流速】只有脚底真的在水里才取流速：全城上千人每帧都做一次
    // 双线性是白烧 CPU。旧工况没有 vel 帧，sampleFlow 返回 0，行为与改动前一致。
    if (d >= 0.05) {
      sampleFlow(x, z, undefined, _fl);
      out.sp = _fl.sp; out.ux = _fl.ux; out.uz = _fl.uz;
    } else { out.sp = 0; out.ux = 0; out.uz = 0; }
    return out;
  }""")

FLOOD_SAMP_INIT = ("  const _samp = { d: 0, wet: false };\n",
                   "  const _samp = { d: 0, wet: false, sp: 0, ux: 0, uz: 0 };\n")

FLOOD_EXPORT = ("""    depthAt, depthInfo, depthNow,
""", """    depthAt, depthInfo, depthNow,
    // 【2026-11-20】流速口：sampleFlow 是原始采样，speedAt 只给大小。
    sampleFlow,
    speedAt(x, z, tMin) {
      sampleFlow(x, z, tMin, _fl);
      return _fl.sp;
    },
""")

PED_DS = ("""        let dd0 = 0;
        if (dInfo) { const ds0 = dInfo(p.obj.position.x, p.obj.position.z, _ds); dd0 = ds0.d || 0; }""",
          """        let dd0 = 0;
        // 【2026-11-20 流速】同一次采样把流速一起带回来，避免为每个人再查一遍栅格。
        let ds0 = null;
        if (dInfo) { ds0 = dInfo(p.obj.position.x, p.obj.position.z, _ds); dd0 = ds0.d || 0; }""")

PED_CTX = ("""        INC.tick(p.i, dt, {
          x: p.obj.position.x, z: p.obj.position.z, depth: dd0,
          speed: realSpeed, indoor: !!q.indoor,""",
           """        INC.tick(p.i, dt, {
          x: p.obj.position.x, z: p.obj.position.z, depth: dd0,
          // 【2026-11-20】流速（m/s）：没有流速帧的工况恒为 0，此时内核行为与
          // 改动前完全一致（见 kernel/flow-hazard.js 的 isUnstable）。
          flowSpeed: ds0 && ds0.sp > 0 ? ds0.sp : 0,
          speed: realSpeed, indoor: !!q.indoor,""")

INC_IMPORT = ("""import { jonkmanFatality, fatalRiskPerSecond, personalThreshold } from './kernel/fatality.js';
""", """import { jonkmanFatality, fatalRiskPerSecond, personalThreshold } from './kernel/fatality.js';
// 【2026-11-20 流速】危险度 HR / D·V 失稳 / 自设的冲走溺亡风险，见 flow-hazard.js。
import { hazardRating, hazardClass, isUnstable, sweptRiskPerSecond, stabilityLimits }
  from './kernel/flow-hazard.js';
""")

INC_BLANK = ("""  // 弃车时刻：下车后头两分钟按"站不住"处理（见 tick 的 C 段）。
  carExitMin: null,""", """  // 弃车时刻：下车后头两分钟按"站不住"处理（见 tick 的 C 段）。
  carExitMin: null,
  // 【2026-11-20 流速】swptRisk 是「已经站不住的人被水流带走后溺亡」的累积风险，
  // 和室内的 floodRisk 同一套阈值（personalThreshold）。hrPeak / hazardSec 只做
  // 报告：这个人这辈子遇到的最高危险度、以及暴露在 HR≥1.25 水里的秒数。
  sweptRisk: 0, hrPeak: 0, hazardSec: 0, sweepSec: 0,""")

INC_DEATHCODE = ("""    const action = c.inVehicle ? '开车'
      : c.basement ? '进入地下室'
        : wasStranded ? '被困'
          : c.indoor ? '滞留室内' : '涉水行走';""",
                  """    const action = c.swept ? '被水流冲走'
      : c.inVehicle ? '开车'
        : c.basement ? '进入地下室'
          : wasStranded ? '被困'
            : c.indoor ? '滞留室内' : '涉水行走';""")

INC_ZONE = ("""    const zone = c.basement ? '地下室进水'
      : c.inVehicle ? '车内'
        : c.indoor ? '室内被淹'""",
            """    const zone = c.swept ? '室外被冲走'
      : c.basement ? '地下室进水'
        : c.inVehicle ? '车内'
          : c.indoor ? '室内被淹'""")

INC_LEGACY = ("""    if (s.includes('深水')) return '深水被困致死';""",
              """    if (s.includes('冲走')) return '被冲走溺亡';
    if (s.includes('深水')) return '深水被困致死';""")

INC_FLOW = ("""    r.localExposureDepth = dExp;
    if (!r.everWaded) r.everWaded = true;""",
            """    r.localExposureDepth = dExp;
    // ---- 【2026-11-20 流速】危险度与「被水流冲倒 / 带走」 ----
    // 之前这一段不存在：没有流速场，`docs/依据台账.md` 把「流速取 0」标成
    // 目前自己定的，于是「被冲走」整类死亡在模型里是空的。
    // 现在按 FD2321 的 HR = d(v+0.5)+DF 算危险度，用 ARR 的 D·V 判站不站得住；
    // 站不住之后按 flow-hazard.js 里那条【目前自己定的】风险曲线累积溺亡风险。
    // 注意：isUnstable 在 v=0 时退化成「只看限值静水深」，所以旧的判定没有被放宽。
    const vFlow = Math.max(0, Number(ctx.flowSpeed) || 0);
    if (vFlow > 0.05) {
      const hr = hazardRating(dExp, vFlow);
      if (hr > r.hrPeak) r.hrPeak = hr;
      if (hr >= 1.25) r.hazardSec += h;
      if (isUnstable(dExp, vFlow, ageOf(i), limitedMobilityByAge(ageOf(i)))) {
        const pRisk = sweptRiskPerSecond(hr);
        if (pRisk > 0) {
          r.sweptRisk += pRisk * h;
          if (r.sweptRisk >= personalThreshold(i)) {
            die(i, `被水流冲倒后溺亡：水深 ${dExp.toFixed(2)} m、流速 `
              + `${vFlow.toFixed(2)} m/s、危险度 HR ${hr.toFixed(2)}`
              + `（${hazardClass(hr) === 'all' ? '对所有人极端危险' : '对多数人危险'}）`,
            { ...ctx, swept: true });
            return r.status;
          }
        }
      }
    }
    if (!r.everWaded) r.everWaded = true;""")

INC_STAT_INIT = ("""    deathsByCause: {}, deathsByLegacyCause: {}, deathsByZone: {}, incidentsByType: {}, exposed: 0, maxDepth: 0,""",
                 """    deathsByCause: {}, deathsByLegacyCause: {}, deathsByZone: {}, incidentsByType: {}, exposed: 0, maxDepth: 0,
    // 【2026-11-20 流速】死亡里有多少是「被水流冲倒」那一支；以及全城最高危险度。
    sweptDeaths: 0, peakHr: 0, hazardPersonSec: 0,""")

INC_STATS = ("""    const outdoorMargin = {
      n: margins.length,""",
             """    let sweptDeaths = 0, peakHr = 0, hazardPersonSec = 0;
    for (const r of rows) {
      if (!r) continue;
      if (r.deathAction === '被水流冲走') sweptDeaths++;
      if (r.hrPeak > peakHr) peakHr = r.hrPeak;
      if (r.hazardSec > 0) hazardPersonSec += r.hazardSec;
    }
    stat.sweptDeaths = sweptDeaths;
    stat.peakHr = peakHr;
    stat.hazardPersonSec = Math.round(hazardPersonSec);
    const outdoorMargin = {
      n: margins.length,""")

PATCHES = {
    'flood.js': [FLOOD_STATE, FLOOD_CLEAR, FLOOD_HELPERS, FLOOD_SAMP_INIT,
                 FLOOD_SAMPLE, FLOOD_DINFO, FLOOD_EXPORT],
    'ped.js': [PED_DS, PED_CTX],
    'incidents.js': [INC_IMPORT, INC_BLANK, INC_DEATHCODE, INC_ZONE, INC_LEGACY,
                     INC_FLOW, INC_STAT_INIT, INC_STATS],
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='真的写盘（默认 dry-run）')
    args = ap.parse_args()
    bad = 0
    for name, edits in PATCHES.items():
        path = os.path.join(LIB, name)
        with io.open(path, encoding='utf-8', newline='') as f:
            raw = f.read()
        # 仓库里各文件行尾并不统一（flood.js 是 CRLF，ped.js/incidents.js 是 LF）。
        # 这里统一按 LF 打补丁，写回时再恢复原样，免得「一个字段改动 = 整文件重写」。
        crlf = '\r\n' in raw
        text = raw.replace('\r\n', '\n')
        for i, (old, new) in enumerate(edits):
            cnt = text.count(old)
            if cnt != 1:
                bad += 1
                print('[MISS] %s #%d 命中 %d 次' % (name, i, cnt))
                continue
            text = text.replace(old, new, 1)
            print('[ok  ] %s #%d' % (name, i))
        if args.apply:
            out = text.replace('\n', '\r\n') if crlf else text
            with io.open(path, 'w', encoding='utf-8', newline='') as f:
                f.write(out)
            print('[write] %s (%s)' % (name, 'CRLF' if crlf else 'LF'))
    print('misses = %d' % bad)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())