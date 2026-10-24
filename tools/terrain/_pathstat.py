import json, math
src = json.load(open('data/streets/dc_streets.json', encoding='utf-8'))
profs = src['profiles']; ways = src['ways']
def plen(p): return sum(math.hypot(p[i+1][0]-p[i][0], p[i+1][1]-p[i][1]) for i in range(len(p)-1))
def bbox(p):
    xs=[q[0] for q in p]; ys=[q[1] for q in p]
    return min(xs),min(ys),max(xs),max(ys)
# Mall bbox in plan coords: x 1250..3450, y -350..-50  (three z=-y)
paths=[w for w in ways if not str(w.get('prof','')).startswith('profile_roads_')]
print('path ways total', len(paths))
import collections
c=collections.Counter()
lens=[]
for w in paths:
    pr=profs.get(w['prof']); 
    half=max(abs(pr[0][0]),abs(pr[-1][0])) if pr else 0
    L=plen(w['pts']) if len(w['pts'])>=2 else 0
    lens.append(L)
    c[w['prof']]+=1
lens.sort()
q=lambda f: lens[min(len(lens)-1,int(len(lens)*f))]
print('len q10/q50/q90', round(q(.1)),round(q(.5)),round(q(.9)), 'total km', round(sum(lens)/1000))
print('  <10m', sum(1 for L in lens if L<10), ' <20m', sum(1 for L in lens if L<20), ' <40m', sum(1 for L in lens if L<40))
# Mall 内
inm=[w for w in paths if (lambda b: not(b[2]<1250 or b[0]>3450 or b[3]<-350 or b[1]>-50))(bbox(w['pts']))]
print('Mall bbox path ways', len(inm))
lm=sorted(plen(w['pts']) for w in inm if len(w['pts'])>=2)
if lm:
    print(' Mall len q10/50/90', round(lm[int(len(lm)*.1)]), round(lm[len(lm)//2]), round(lm[int(len(lm)*.9)]))
    print(' Mall total km', round(sum(lm)/1000,2))
    for thr in (20,40,60,100):
        print(f'  Mall paths < {thr} m: {sum(1 for L in lm if L<thr)} / {len(lm)}')
