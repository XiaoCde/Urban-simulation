# -*- coding: utf-8 -*-
# python 3.9
# 为融合Quadrant做准备，得到每个网格对应的Quadrant
"""
#@Author: LW
#@FileName: 1_DissolveQuadrants.py
#@Time: 2023/5/8 21:00  
#Software: PyCharm
---------------------------
"""

import pandas as pd

if __name__ == '__main__':
    path = 'E:\\ABM for Human Movements'
    quadrants = pd.DataFrame()
    count = 0
    for i in range(4):
        fileName = 'quadrant' + str(i+1) + '_Target_IDnumber.xls'
        quadrant = pd.read_excel(io=path + '\\Data\\quadrant\\' + fileName)
        quadrant['Quadrant'] = i+1
        count += len(quadrant)
        print(count)
        quadrants = pd.concat([quadrants, quadrant])

    quadrants.to_csv(path + '\\OutputData\\quadrants.csv', header=True, index=False)
