import json, os, math
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
d = json.load(open(os.path.join(ROOT, 'web', 'assets', 'water', 'water.json'), encoding='utf-8'))
bodies = d['bodies']
print('bodies', len(bodies), 'keys', list(bodies[0].keys()))
rows = []
for b in bodies:
    o = b['outline']
    n = len(o)
    cx = sum(p[0] for p in o) / n
    cy = sum(p[1] for p in o) / n
    ylo = min(p[1] for p in o); yhi = max(p[1] for p in o)
    rows.append((b['id'], b.get('surface_mode'), b.get('area_m2'), round(cx, 1), round(cy, 1),
                 round(ylo, 1), round(yhi, 1), b['normal_water_level_m'], b.get('dem_plateau_m'),
                 b.get('flat_ratio')))
for r in rows[:25]:
    print(r)
