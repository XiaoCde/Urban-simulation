"""最小复现：20×20 平地，中央一个水块，验证 inertial + 方向分裂 + 格点限幅是否守恒。"""
import numpy as np

G = 9.81
nx = ny = 20
dx = dy = 4.0
res = 4.0


def run(s_max=0.1, cfl=0.5, dt_max=20.0, n_steps=60, bld_step=0.0, verbose=True):
    z = np.full((ny, nx), 10.0, dtype="float32")
    if bld_step:
        z[8:12, 8:12] += bld_step
    h = np.zeros((ny, nx), dtype="float32")
    h[9:11, 9:11] = 1.0
    V0 = float(h.sum()) * dx * dy

    qx = np.zeros_like(h)
    qy = np.zeros_like(h)
    nm = np.full((ny, nx), 0.015, dtype="float32")
    n_x2 = (np.maximum(nm[:, :-1], nm[:, 1:]) ** 2).astype("float32")
    n_y2 = (np.maximum(nm[:-1, :], nm[1:, :]) ** 2).astype("float32")
    dz_x = (z[:, :-1] - z[:, 1:]).astype("float32")
    dz_y = (z[:-1, :] - z[1:, :]).astype("float32")
    inv_dx = np.float32(1 / dx)
    inv_dy = np.float32(1 / dy)

    t = 0.0
    worst = 0.0
    for step in range(n_steps):
        hs = h.ravel()[::4]
        hm = min(float(np.percentile(hs, 99.5)), 2.0)
        dt = min(dt_max, cfl * res / np.sqrt(G * max(hm, 0.05)))
        dtf = np.float32(dt)
        gdt = np.float32(G) * dtf
        for _f in (0, 1):
            if (_f == 0) == (step % 2 == 0):
                hL, hR = h[:, :-1], h[:, 1:]
                hflow = np.maximum(hL, hR)
                S = np.clip((hL - hR + dz_x) * inv_dx, -s_max, s_max)
                qo = qx[:, 1:]
                hf = np.maximum(hflow, 0.01)
                h73 = np.cbrt(hf); h73 *= hf; h73 *= hf
                den = np.float32(1.0) + gdt * n_x2 * np.abs(qo) / h73
                qn = (qo + gdt * hflow * S) / den
                np.multiply(qn, hflow >= 1e-4, out=qn)
                ou = np.zeros_like(h); ou[:, 1:] = np.maximum(-qn, 0.0)
                od = np.zeros_like(h); od[:, :-1] = np.maximum(qn, 0.0)
                tot = ou + od
                allow = h * np.float32(dx / dt)
                sc = np.ones_like(h)
                np.divide(allow, np.maximum(tot, 1e-12), out=sc)
                np.minimum(sc, 1.0, out=sc)
                qn *= np.where(qn > 0, sc[:, :-1], sc[:, 1:])
                qx[:, 1:] = qn
                sdt = np.float32(dt / dx)
                dh = np.zeros_like(h)
                dh[:, 1:] += qn * sdt
                dh[:, :-1] -= qn * sdt
            else:
                hU, hD = h[:-1, :], h[1:, :]
                hflow = np.maximum(hU, hD)
                S = np.clip((hU - hD + dz_y) * inv_dy, -s_max, s_max)
                qo = qy[1:, :]
                hf = np.maximum(hflow, 0.01)
                h73 = np.cbrt(hf); h73 *= hf; h73 *= hf
                den = np.float32(1.0) + gdt * n_y2 * np.abs(qo) / h73
                qn = (qo + gdt * hflow * S) / den
                np.multiply(qn, hflow >= 1e-4, out=qn)
                ou = np.zeros_like(h); ou[1:, :] = np.maximum(-qn, 0.0)
                od = np.zeros_like(h); od[:-1, :] = np.maximum(qn, 0.0)
                tot = ou + od
                allow = h * np.float32(dy / dt)
                sc = np.ones_like(h)
                np.divide(allow, np.maximum(tot, 1e-12), out=sc)
                np.minimum(sc, 1.0, out=sc)
                qn *= np.where(qn > 0, sc[:-1, :], sc[1:, :])
                qy[1:, :] = qn
                sdt = np.float32(dt / dy)
                dh = np.zeros_like(h)
                dh[1:, :] += qn * sdt
                dh[:-1, :] -= qn * sdt
            h += dh
            worst = min(worst, float(h.min()))
            np.maximum(h, 0, out=h)
        t += dt
        V = float(h.sum()) * dx * dy
        if verbose and (step < 5 or step % 10 == 0):
            print(f"  step{step:3d} t={t:6.1f} dt={dt:5.2f} hmax={h.max():8.4f} "
                  f"V={V:9.4f} 闭合={100*(V-V0)/V0:+7.3f}% hmin={worst:+.2e}")
    return h, V0


print("A) 平地，纯扩散 60 步")
h, V0 = run(n_steps=60)
print(f"   V0={V0:.3f} Vend={float(h.sum())*dx*dy:.3f}")

print("\nB) 中间 0.30 m 建筑台阶")
h, V0 = run(n_steps=60, bld_step=0.30)
print(f"   V0={V0:.3f} Vend={float(h.sum())*dx*dy:.3f}")
