import json,collections
d=json.load(open('../../data/streets/dc_streets.json'))
ways=d['ways']
# Mall bbox x 1250..3500, y -300..150
cnt=collections.Counter(); inside=collections.Counter(); lens=collections.Counter()
tot=collections.Counter()
for w in ways:
    p=w['prof']; tot[p]+=1
    pts=w['pts']
    xs=[q[0] for q in pts]; ys=[q[1] for q in pts]
    if min(xs)>=1150 and max(xs)<=3600 and min(ys)>=-450 and max(ys)<=300:
        inside[p]+=1
        L=sum(((pts[i+1][0]-pts[i][0])**2+(pts[i+1][1]-pts[i][1])**2)**0.5 for i in range(len(pts)-1))
        lens[p]+=L
print('Mall bbox 内的 way 数:',dict(inside))
print('对应总长 (m):',{k:round(v) for k,v in lens.items()})
print('全城 way 总数:',dict(tot))
# 该 bbox 内 footway 长度分布
import statistics
fl=[]
for w in ways:
    if w['prof']!='profile_paths_footway': continue
    pts=w['pts']; xs=[q[0] for q in pts]; ys=[q[1] for q in pts]
    if min(xs)>=1150 and max(xs)<=3600 and min(ys)>=-450 and max(ys)<=300:
        L=sum(((pts[i+1][0]-pts[i][0])**2+(pts[i+1][1]-pts[i][1])**2)**0.5 for i in range(len(pts)-1))
        fl.append((L,w.get('name',''),len(pts)))
fl.sort(reverse=True)
print('Mall 内 footway 数',len(fl),'总长',round(sum(x[0] for x in fl)))
print('最长 10:',[(round(a),b[:20],c) for a,b,c in fl[:10]])
