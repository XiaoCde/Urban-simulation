import sys, math
sys.path.insert(0, r"C:\Users\asus\AppData\Roaming\Blender Foundation\Blender\5.2\scripts\addons\blosm\util")
from transverse_mercator import TransverseMercator
lat0, lon0 = 38.89038015, -77.04975644999999
tm = TransverseMercator(lat=lat0, lon=lon0)
pts = [(-1276.96,-930.97),(4700.72,4188.47)]
for x,y in pts:
    print(x,y,"->",tm.toGeographic(x,y))
# corners
import itertools
xs=[-1276.96,4700.72]; ys=[-930.97,4188.47]
lats=[];lons=[]
for x in xs:
    for y in ys:
        la,lo=tm.toGeographic(x,y); lats.append(la);lons.append(lo)
print("bbox lat %.6f .. %.6f  lon %.6f .. %.6f" % (min(lats),max(lats),min(lons),max(lons)))
