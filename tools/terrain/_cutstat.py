import numpy as np
p='../../web/assets/roads/cut.i16'
a=np.fromfile(p,dtype='<i2').reshape(853,996)
X0,Y1,S=-1277.0,4189.0,6.0
def rc(x,y): return int(round((Y1-y)/S-0.5)), int(round((x-X0)/S-0.5))
valid=(a!=-32768)
print('全城 cut 覆盖 %.1f%%'%(valid.mean()*100))
# Mall bbox
r0,c0=rc(1250,-300); r1,c1=rc(3500,150)
sub=a[r0:r1,c0:c1]
print('Mall bbox',sub.shape,'覆盖 %.1f%%'%((sub!=-32768).mean()*100))
# 白宫南草坪
r0,c0=rc(1000,-760); r1,c1=rc(1300,-500)
sub2=a[r0:r1,c0:c1]
print('白宫南 lawn 覆盖 %.1f%%'%((sub2!=-32768).mean()*100))
# 采样一行
print('行 y=-100 从 x=1250 到 1500 每 6m:')
r,_=rc(0,-100)
print(''.join('#' if a[r,rc(x,0)[1]]!=-32768 else '.' for x in range(1250,1500,6)))
