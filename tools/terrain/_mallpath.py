import json, math, collections
src=json.load(open('data/streets/dc_streets.json',encoding='utf-8'))
ways=[w for w in src['ways'] if not str(w.get('prof','')).startswith('profile_roads_')]
def inb(p): return all(1250<=q[0]<=3450 and -350<=q[1]<=-50 for q in p)
mm=[w for w in ways if inb(w['pts'])]
print('Mall 内 path ways', len(mm))
c=collections.Counter(w['prof'] for w in mm); print(c)
def plen(p): return sum(math.hypot(p[i+1][0]-p[i][0],p[i+1][1]-p[i][1]) for i in range(len(p)-1))
# bbox of each way to see parallel duplicates
boxes=[]
for w in mm:
    xs=[q[0] for q in w['pts']]; ys=[q[1] for q in w['pts']]
    boxes.append((min(xs),max(xs),min(ys),max(ys),plen(w['pts'])))
# count ways whose bbox center is within 3m of another
cent=[((b[0]+b[1])/2,(b[2]+b[3])/2) for b in boxes]
near=0
for i in range(len(cent)):
    for j in range(i+1,len(cent)):
        if abs(cent[i][0]-cent[j][0])<50 and abs(cent[i][1]-cent[j][1])<50:
            if math.hypot(cent[i][0]-cent[j][0],cent[i][1]-cent[j][1])<3.0: near+=1
print('bbox 中心 <3m 的成对数量', near)
tot=sum(b[4] for b in boxes); print('总长 km', round(tot/1000,2))
lens=sorted(b[4] for b in boxes)
print('长度分位', [round(lens[int(q*len(lens))],1) for q in (0.1,0.5,0.9,0.99)])
