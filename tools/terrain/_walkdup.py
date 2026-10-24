import json, math
src = json.load(open('data/streets/dc_streets.json', encoding='utf-8'))
profs = src['profiles']; ways = src['ways']
WALK_W = 1.8
CELL = 8.0
def plen(p): return sum(math.hypot(p[i+1][0]-p[i][0], p[i+1][1]-p[i][1]) for i in range(len(p)-1))
def d_seg(px,py,ax,ay,bx,by):
    dx,dy=bx-ax,by-ay; L2=dx*dx+dy*dy
    if L2<1e-12: return math.hypot(px-ax,py-ay)
    t=max(0.0,min(1.0,((px-ax)*dx+(py-ay)*dy)/L2))
    return math.hypot(px-(ax+dx*t), py-(ay+dy*t))
# 车行道走廊
segs=[]; grid={}
for w in ways:
    if not str(w.get('prof','')).startswith('profile_roads_'): continue
    pr=profs.get(w['prof'])
    if not pr: continue
    half=max(abs(pr[0][0]),abs(pr[-1][0]))
    if half<=0: continue
    outer=half+WALK_W
    for j in range(len(w['pts'])-1):
        ax,ay=w['pts'][j]; bx,by=w['pts'][j+1]
        si=len(segs); segs.append((ax,ay,bx,by,outer))
        for cx in range(int(min(ax,bx)//CELL),int(max(ax,bx)//CELL)+1):
            for cy in range(int(min(ay,by)//CELL),int(max(ay,by)//CELL)+1):
                grid.setdefault((cx,cy),[]).append(si)
print('road segs', len(segs))
stats={}
tot=0; dup=0; dupkm=0.0
for w in ways:
    if str(w.get('prof','')).startswith('profile_roads_'): continue
    p=w['pts']
    if len(p)<2: continue
    L=plen(p)
    if L < 6: continue
    tot+=1
    probes=[p[0]]
    for j in range(len(p)-1):
        ax,ay=p[j]; bx,by=p[j+1]; L2=math.hypot(bx-ax,by-ay)
        m=max(1,int(math.ceil(L2/4.0)))
        for s in range(1,m+1):
            t=s/m; probes.append((ax+(bx-ax)*t, ay+(by-ay)*t))
    cov=0
    for px,py in probes:
        hit=False
        for si in grid.get((int(px//CELL),int(py//CELL)),()):
            ax,ay,bx,by,outer=segs[si]
            if d_seg(px,py,ax,ay,bx,by)<=outer: hit=True; break
        if hit: cov+=1
    r=cov/len(probes)
    if r>=0.82: dup+=1; dupkm+=L
print(f'path ways(>=6m) {tot}, 全在车行道人行道走廊内 {dup} ({dup/tot:.1%}), 长度 {dupkm/1000:.1f} km')
