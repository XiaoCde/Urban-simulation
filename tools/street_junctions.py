"""street_junctions.py — 从 OSM 路网算路口坐标，给信号灯用。

【为什么要自己算】主场景的道路是 `roads.mesh`（烘焙好的三角面），没有路口表；
`roadribbon.js` 的 `junctions` 只在 district / office 两个页面用得上。
信号灯必须摆在「两条路真的交叉」的位置，所以直接从 `dc_streets.json` 的折线
两两求交 —— 只看目标半径内的 way，几百条，够快。

输出：`web/assets/street/junctions.json`
  [{ "x": 2501.0, "z": 355.0, "a": "10th Street NW", "b": "Constitution Ave NW",
     "major": 1 }]
  z = -planY（与 three 坐标一致）。major=1 表示两条路里至少一条是 primary/secondary。
"""
import json
import math
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "data", "streets", "dc_streets.json")
DST = os.path.join(ROOT, "web", "assets", "street", "junctions.json")

CX, CZ = 2501.0, 355.0     # FAA 办公楼（three 坐标）
R = 520.0                  # 比 MegaKit 半径略大，信号灯可以在街区外也有一圈

MAJOR = ("primary", "secondary", "trunk")


def seg_hit(p, q, r, s):
    """两条线段求交，返回交点或 None。"""
    px, py = p; qx, qy = q; rx, ry = r; sx, sy = s
    d1 = (qx - px, qy - py)
    d2 = (sx - rx, sy - ry)
    den = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(den) < 1e-9:
        return None
    t = ((rx - px) * d2[1] - (ry - py) * d2[0]) / den
    u = ((rx - px) * d1[1] - (ry - py) * d1[0]) / den
    if -0.02 <= t <= 1.02 and -0.02 <= u <= 1.02:
        return (px + d1[0] * t, py + d1[1] * t)
    return None


def main():
    d = json.load(open(SRC, encoding="utf-8"))
    ways = []
    for w in d["ways"]:
        pts = w.get("pts") or []
        if len(pts) < 2:
            continue
        # 有没有一段落在半径内
        inside = False
        for x, y in pts:
            if math.hypot(x - CX, -y - CZ) <= R:
                inside = True
                break
        if not inside:
            continue
        ways.append(w)
    print(f"半径 {R:.0f} m 内 {len(ways)} 条 way（总 {len(d['ways'])}）")

    out = []
    seen = set()
    n = len(ways)
    for i in range(n):
        a = ways[i]
        pa = a["pts"]
        for j in range(i + 1, n):
            b = ways[j]
            # 同名路（同一条街被切成多段）不算路口
            if a.get("name") and a.get("name") == b.get("name"):
                continue
            pb = b["pts"]
            hitp = None
            for k in range(len(pa) - 1):
                for m in range(len(pb) - 1):
                    h = seg_hit(pa[k], pa[k + 1], pb[m], pb[m + 1])
                    if h:
                        hitp = h
                        break
                if hitp:
                    break
            if not hitp:
                continue
            x, z = hitp[0], -hitp[1]
            if math.hypot(x - CX, z - CZ) > R:
                continue
            key = (round(x / 6), round(z / 6))       # 6 m 内算同一个路口
            if key in seen:
                continue
            seen.add(key)
            major = 1 if (a.get("h") in MAJOR or b.get("h") in MAJOR) else 0
            out.append({
                "x": round(x, 1), "z": round(z, 1),
                "a": a.get("name") or "", "b": b.get("name") or "",
                "major": major,
            })

    out.sort(key=lambda o: (-o["major"], math.hypot(o["x"] - CX, o["z"] - CZ)))
    os.makedirs(os.path.dirname(DST), exist_ok=True)
    json.dump(out, open(DST, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    nmaj = sum(o["major"] for o in out)
    print(f"路口 {len(out)} 个（其中主路交叉 {nmaj} 个）→ {DST}")
    for o in out[:8]:
        print(f"  ({o['x']:.0f},{o['z']:.0f}) {o['a'][:22]} × {o['b'][:22]} major={o['major']}")


if __name__ == "__main__":
    main()
