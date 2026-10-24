import json, math
src=json.load(open('data/streets/dc_streets.json',encoding='utf-8'))
ways=src['ways']
def plen(p): return sum(math.hypot(p[i+1][0]-p[i][0],p[i+1][1]-p[i][1]) for i in range(len(p)-1))
lens=[plen(w['pts']) for w in ways if not str(w.get('prof','')).startswith('profile_roads_')]
lens.sort()
n=len(lens)
def pct(q): return lens[min(n-1,int(q*n))]
print('path ways',n,'total_km',round(sum(lens)/1000,1))
for t in (2,5,8,10,15,20,25,40,60,100):
    c=sum(1 for L in lens if L<t); km=sum(L for L in lens if L<t)/1000
    print(f'  <{t}m : {c} ({c/n*100:.1f}%) {km:.1f} km')
