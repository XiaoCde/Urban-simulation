# -*- coding: utf-8 -*-
"""DC 规划局官网对我们这个 IP 直接 Cloudflare 拦截（Location CN），
改走 Wayback Machine 存档。"""
import json, urllib.request, urllib.parse

BASE = "https://planning.dc.gov/sites/default/files/dc/sites/op/publication/attachments/"
DOCS = {
    "projection_schedule": "Projection%20Schedule%202024.pdf",
    "roof_guidelines":     "DC%20Roof%20Guidelines.pdf",
    "chase_patternbook":   "140318_CHASEPatternBook-LO_Part1_0.pdf",
    "projections_picturesque": "3.%20Projections%20and%20the%20Picturesque%20City.pdf",
    "porches_steps":       "DC%20Porches%20and%20Steps.pdf",
    "window_guidelines":   "Window%20Guidelines%20Final.pdf",
}
def get(url, timeout=45):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()

for name, fn in DOCS.items():
    full = BASE + fn
    api = "https://archive.org/wayback/available?url=" + urllib.parse.quote(full, safe="")
    try:
        st, body = get(api)
        js = json.loads(body.decode("utf-8", "replace"))
        snap = js.get("archived_snapshots", {}).get("closest")
        if snap:
            print("[有存档] %-24s %s  (%s)" % (name, snap["url"], snap.get("timestamp")))
        else:
            print("[无存档] %-24s" % name)
    except Exception as e:
        print("[查询失败] %-22s %s" % (name, e))