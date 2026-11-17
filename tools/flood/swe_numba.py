"""
swe_numba.py — 二维浅水（inertial）的 numba 内核

【为什么单独抽出来】
`shallow2d.py` 的 numpy 版每步要建十几个 190 万格的临时数组，
1.9 M 格 × 30 次逐元素运算 × 两方向 ≈ 每步 0.3 s，6 h 工况要 50 min。
同样的算子在 numba 里编译成机器码、8 核并行，每步 ~20 ms，快一个量级。

【数值口径与 numpy 版完全一致（这是刻意的）】
- 通量：Bates et al. (2010) inertial
  q_{t+dt} = (q_t + g·h_flow·dt·S) / (1 + g·dt·n²·|q_t| / h_flow^{7/3})
- 坡降裁剪 ±s_max（城市地表假陡坡会让通量爆炸）
- **格点级总出流限幅**：一个格沿本方向有两个面，各自最多出 h·dx/dt 会让它变负，
  负值一裁就是凭空加水。所以先求该格出流总量，超了按比例整体缩小；
  缩放只施加在供水方（q 的符号决定），不施加在接收方（否则干格会把流场冻住）。
- 方向分裂：先 x 后 y，逐步交替，避免固定方向偏差。

【每个 pass 一个 prange】
h 的更新必须按「格」写一次，不能在一个 pass 里同时写 h[j] 和 h[j-1]（写冲突）。
所以拆成 flux → scale → 缩放 q → 更新 h 四步。
"""

import numpy as np
from numba import njit, prange, set_num_threads

G = 9.81


@njit(parallel=True, fastmath=True, cache=True)
def _flux_x(h, qx, dz, n2, dt, dx, s_max, h_min, dl, riv):
    R, C = h.shape
    gdt = G * dt
    for i in prange(R):
        for j in range(1, C):
            hl = h[i, j - 1]
            hr = h[i, j]
            hfm = hl if hl > hr else hr
            if hfm < h_min:
                qx[i, j] = 0.0
                continue
            # 河道水位随时间变化：河格的地形是「等效水面」，水位涨落 dl 直接改它的高程。
            # 只有河格与陆地的交界面需要修正，所以写成 (river_L − river_R)·dl。
            zeff = dz[i, j - 1] + (riv[i, j - 1] - riv[i, j]) * dl
            s = (hl - hr + zeff) / dx
            if s > s_max:
                s = s_max
            elif s < -s_max:
                s = -s_max
            hf = hfm if hfm > 0.01 else 0.01
            h73 = hf * hf * (hf ** 0.3333333333333333)
            qo = qx[i, j]
            den = 1.0 + gdt * n2[i, j - 1] * abs(qo) / h73
            qx[i, j] = (qo + gdt * hfm * s) / den


@njit(parallel=True, fastmath=True, cache=True)
def _flux_y(h, qy, dz, n2, dt, dy, s_max, h_min, dl, riv):
    R, C = h.shape
    gdt = G * dt
    for i in prange(1, R):
        for j in range(C):
            hu = h[i - 1, j]
            hd = h[i, j]
            hfm = hu if hu > hd else hd
            if hfm < h_min:
                qy[i, j] = 0.0
                continue
            zeff = dz[i - 1, j] + (riv[i - 1, j] - riv[i, j]) * dl
            s = (hu - hd + zeff) / dy
            if s > s_max:
                s = s_max
            elif s < -s_max:
                s = -s_max
            hf = hfm if hfm > 0.01 else 0.01
            h73 = hf * hf * (hf ** 0.3333333333333333)
            qo = qy[i, j]
            den = 1.0 + gdt * n2[i - 1, j] * abs(qo) / h73
            qy[i, j] = (qo + gdt * hfm * s) / den


@njit(parallel=True, fastmath=True, cache=True)
def _lim_x(h, qx, scale, dt, dx):
    R, C = h.shape
    for i in prange(R):
        for j in range(C):
            out = 0.0
            if j > 0:
                q = qx[i, j]
                if q < 0.0:
                    out -= q
            if j < C - 1:
                q = qx[i, j + 1]
                if q > 0.0:
                    out += q
            if out > 1e-9:
                allowed = h[i, j] * dx / dt
                sc = allowed / out
                scale[i, j] = sc if sc < 1.0 else 1.0
            else:
                scale[i, j] = 1.0


@njit(parallel=True, fastmath=True, cache=True)
def _lim_y(h, qy, scale, dt, dy):
    R, C = h.shape
    for i in prange(R):
        for j in range(C):
            out = 0.0
            if i > 0:
                q = qy[i, j]
                if q < 0.0:
                    out -= q
            if i < R - 1:
                q = qy[i + 1, j]
                if q > 0.0:
                    out += q
            if out > 1e-9:
                allowed = h[i, j] * dy / dt
                sc = allowed / out
                scale[i, j] = sc if sc < 1.0 else 1.0
            else:
                scale[i, j] = 1.0


@njit(parallel=True, fastmath=True, cache=True)
def _apply_x(h, qx, scale, dt, dx, clip_mask):
    R, C = h.shape
    k = dt / dx
    for i in prange(R):
        for j in range(1, C):
            q = qx[i, j]
            if q > 0.0:
                q *= scale[i, j - 1]
            elif q < 0.0:
                q *= scale[i, j]
            qx[i, j] = q
    for i in prange(R):
        for j in range(C):
            dv = 0.0
            if j > 0:
                dv += qx[i, j]
            if j < C - 1:
                dv -= qx[i, j + 1]
            nh = h[i, j] + dv * k
            # 河道格（clip_mask=0）允许为负：负值代表"从河里取水"，
            # 由 _forcings 统一记账后清零。若在这里裁成 0，河水倒灌就变成凭空造水。
            if nh > 0.0 or clip_mask[i, j] == 0.0:
                h[i, j] = nh
            else:
                h[i, j] = 0.0


@njit(parallel=True, fastmath=True, cache=True)
def _apply_y(h, qy, scale, dt, dy, clip_mask):
    R, C = h.shape
    k = dt / dy
    for i in prange(1, R):
        for j in range(C):
            q = qy[i, j]
            if q > 0.0:
                q *= scale[i - 1, j]
            elif q < 0.0:
                q *= scale[i, j]
            qy[i, j] = q
    for i in prange(R):
        for j in range(C):
            dv = 0.0
            if i > 0:
                dv += qy[i, j]
            if i < R - 1:
                dv -= qy[i + 1, j]
            nh = h[i, j] + dv * k
            # 河道格（clip_mask=0）允许为负：负值代表"从河里取水"，
            # 由 _forcings 统一记账后清零。若在这里裁成 0，河水倒灌就变成凭空造水。
            if nh > 0.0 or clip_mask[i, j] == 0.0:
                h[i, j] = nh
            else:
                h[i, j] = 0.0


@njit(parallel=True, fastmath=True, cache=True)
def _forcings(h, runoff_add, dt, raining, inlet, drain_cap, land,
              river, edge, edge_rel, served, h_cap,
              f0_mps, fc_mps, soil_cap_mm, soil_left, soil_rec_step,
              et_mps, rain_scale):
    """
    统一内核的一步外力。**四条退水去路全部在这里**，不再有第二个内核：

      降雨（按雨型缩放）
        → 下渗  f = fc + (f0-fc)·(soil_left/cap)，受土壤蓄水库限制，雨停按指数回补
        → 蒸散  只作用于积水表面
        → 管道  街面雨水口 × 逐步服务率 served（管网满管桶在主循环维护）
        → 入河  河道 Dirichlet（河格清零并记账，河水位涨落由 dl 改 zeff）
      外加开边界出流、超深削平。

    返回 6 个「深度和」（m·格），主循环乘 cell_area 换成 m³。
    """
    R, C = h.shape
    v_dr = np.zeros(R, dtype=np.float32)
    v_ed = np.zeros(R, dtype=np.float32)
    v_rv = np.zeros(R, dtype=np.float32)
    v_cp = np.zeros(R, dtype=np.float32)
    v_sp = np.zeros(R, dtype=np.float32)
    v_ev = np.zeros(R, dtype=np.float32)
    for i in prange(R):
        dr = np.float32(0.0)
        ed = np.float32(0.0)
        rv = np.float32(0.0)
        cp = np.float32(0.0)
        sp = np.float32(0.0)
        ev = np.float32(0.0)
        for j in range(C):
            x = h[i, j]
            capmm = soil_cap_mm[i, j]

            # ---- 1) 降雨（雨型给的是「整场平均雨强」的形状，∫shape = 1）----
            if raining:
                x += runoff_add[i, j] * dt * rain_scale

            # ---- 2) 下渗：进土，第一条退水去路 ----
            # 干土初渗 f0 → 饱和稳渗 fc，随 soil_left 线性衰退；
            # 水库吸满就停（不是恒定速率无限吸），雨停后按 soil_rec_step 回补。
            if capmm > 0.0 and x > 0.0:
                left = soil_left[i, j]
                sat = left / capmm
                if sat < 0.0:
                    sat = 0.0
                elif sat > 1.0:
                    sat = 1.0
                f = fc_mps[i, j] + (f0_mps[i, j] - fc_mps[i, j]) * sat
                seep = f * dt
                seep_mm = seep * 1000.0
                if seep_mm > left:
                    seep_mm = left
                    seep = seep_mm / 1000.0
                if seep > x:
                    seep = x
                    seep_mm = seep * 1000.0
                x -= seep
                soil_left[i, j] = left - seep_mm
                sp += seep
            if not raining and capmm > 0.0:
                soil_left[i, j] += (capmm - soil_left[i, j]) * soil_rec_step

            # ---- 3) 蒸散：进空气，第二条退水去路（只扣积水表面）----
            if et_mps > 0.0 and x > 0.0:
                e = et_mps * dt
                if e > x:
                    e = x
                x -= e
                ev += e

            # ---- 4) 管道输送：雨水口泵走，第三条退水去路 ----
            # served 由主循环的「满管桶」逐步算出，雨中雨停同一口径
            # （旧版雨停后不乘 served，等于凭空把管网能力拉满，已修）。
            if inlet[i, j] > 0.0:
                cap = drain_cap[i, j] * (dt * served)
                if cap > x:
                    cap = x
                x -= cap
                dr += cap

            # ---- 5) 入河 / 开边界，第四条退水去路 ----
            if river[i, j] > 0.0:
                rv += x
                x = 0.0
            elif edge[i, j] > 0.0:
                o = x * edge_rel
                x -= o
                ed += o

            # 超深削平：DEM 里的铁路堑、地下通道在粗网格上会变成封闭深坑，
            # 把水吸到十几米深。超出的按「溢流进地下/涵洞」记账，不凭空消失。
            if x > h_cap:
                cp += x - h_cap
                x = h_cap
            h[i, j] = x if x > 0.0 else 0.0
        v_dr[i] = dr
        v_ed[i] = ed
        v_rv[i] = rv
        v_cp[i] = cp
        v_sp[i] = sp
        v_ev[i] = ev
    return (float(v_dr.sum()), float(v_ed.sum()), float(v_rv.sum()),
            float(v_cp.sum()), float(v_sp.sum()), float(v_ev.sum()))


class SweCore:
    """把数组和常量打包，主循环只剩一行 step()。"""

    def __init__(self, h, z, dz_x, dz_y, n_x2, n_y2, runoff_add, inlet, drain_cap,
                 river_f, land_f, edge_f, dx, dy, s_max, h_min,
                 edge_rel, served, h_cap=4.0, threads=None,
                 f0_mps=None, fc_mps=None, soil_cap_mm=None, soil_left=None,
                 et_mps=0.0):
        self.h = h
        self.qx = np.zeros_like(h)
        self.qy = np.zeros_like(h)
        self.scale = np.ones_like(h)
        self.dz_x, self.dz_y = dz_x, dz_y
        self.n_x2, self.n_y2 = n_x2, n_y2
        self.runoff_add = runoff_add
        self.inlet = inlet
        self.drain_cap = drain_cap
        self.river_f = river_f
        self.land_f = land_f
        self.edge_f = edge_f
        self.dx, self.dy = float(dx), float(dy)
        self.s_max = float(s_max)
        self.h_min = float(h_min)
        self.edge_rel = float(edge_rel)
        self.served = float(served)
        self.h_cap = float(h_cap)
        # 统一退水的逐格状态（缺任何一个就退化成「不下渗、不蒸散」）
        z0 = np.zeros_like(h)
        self.f0_mps = f0_mps if f0_mps is not None else z0
        self.fc_mps = fc_mps if fc_mps is not None else z0
        self.soil_cap_mm = soil_cap_mm if soil_cap_mm is not None else z0
        self.soil_left = soil_left if soil_left is not None else z0.copy()
        self.et_mps = float(et_mps)
        if threads:
            set_num_threads(int(threads))

    def step(self, dt, raining, x_first, cell_area, dl=0.0,
             rain_scale=1.0, served_now=None, soil_rec_step=0.0):
        dt = float(dt)
        dl = float(dl)
        riv = self.river_f
        if x_first:
            _flux_x(self.h, self.qx, self.dz_x, self.n_x2, dt, self.dx, self.s_max, self.h_min, dl, riv)
            _lim_x(self.h, self.qx, self.scale, dt, self.dx)
            _apply_x(self.h, self.qx, self.scale, dt, self.dx, self.land_f)
            _flux_y(self.h, self.qy, self.dz_y, self.n_y2, dt, self.dy, self.s_max, self.h_min, dl, riv)
            _lim_y(self.h, self.qy, self.scale, dt, self.dy)
            _apply_y(self.h, self.qy, self.scale, dt, self.dy, self.land_f)
        else:
            _flux_y(self.h, self.qy, self.dz_y, self.n_y2, dt, self.dy, self.s_max, self.h_min, dl, riv)
            _lim_y(self.h, self.qy, self.scale, dt, self.dy)
            _apply_y(self.h, self.qy, self.scale, dt, self.dy, self.land_f)
            _flux_x(self.h, self.qx, self.dz_x, self.n_x2, dt, self.dx, self.s_max, self.h_min, dl, riv)
            _lim_x(self.h, self.qx, self.scale, dt, self.dx)
            _apply_x(self.h, self.qx, self.scale, dt, self.dx, self.land_f)
        sv = self.served if served_now is None else float(served_now)
        vd, ve, vr, vcp, vsp, vev = _forcings(
            self.h, self.runoff_add, dt, bool(raining), self.inlet,
            self.drain_cap, self.land_f, self.river_f, self.edge_f,
            self.edge_rel, sv, self.h_cap,
            self.f0_mps, self.fc_mps, self.soil_cap_mm, self.soil_left,
            float(soil_rec_step), self.et_mps, float(rain_scale))
        return (vd * cell_area, ve * cell_area, vr * cell_area, vcp * cell_area,
                vsp * cell_area, vev * cell_area)
