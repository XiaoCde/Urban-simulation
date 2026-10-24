import json, math, collections
src = json.load(open('data/streets/dc_streets.json', encoding='utf-8'))
ways = src['ways']
def plen(p): return sum(math.hypot(p[i+1][0]-p[i][0], p[i+1][1]-p[i][1]) for i in range(len(p)-1))
CELL=8.0; TOL=2.5
grid=collections.defaultdict(list)
for i,w in enumerate(ways):
    for q in (w['pts'][0], w['pts'][-1]):
        grid[(int(q[0]//CELL),int(q[1]//CELL))].append((i,q[0],q[1]))
def near(i,x,y):
    for ii,xx,yy in grid.get((int(x//CELL),int(y//CELL)),()):
        if ii!=i and math.hypot(xx-x,yy-y)<=TOL: return True
    return False
tot=0; dangling=0; dkm=0.0; kept=0; kkm=0.0
for i,w in enumerate(ways):
    if str(w.get('prof','')).startswith('profile_roads_'): continue
    p=w['pts']
    if len(p)<2: continue
    L=plen(p); tot+=1
    a=near(i,p[0][0],p[0][1]); b=near(i,p[-1][0],p[-1][1])
    if L<25 and not a and not b:
        dangling+=1; dkm+=L
    else:
        kept+=1; kkm+=L
print(f'path ways {tot}: 双端悬空且<25m = {dangling} ({dkm/1000:.1f} km); 保留 {kept} ({kkm/1000:.1f} km)')
