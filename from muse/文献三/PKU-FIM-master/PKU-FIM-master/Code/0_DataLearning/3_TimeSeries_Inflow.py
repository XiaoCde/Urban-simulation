# -*- coding: utf-8 -*-
# python 3.9
# 提取Inflow OD time series
"""
#@Author: LW
#@FileName: 3_TimeSeries_Inflow.py
#@Time: 2023/5/28 11:42  
#Software: PyCharm
---------------------------
"""

import pandas as pd
import numpy as np
import time
import os

if __name__ == '__main__':
    path = 'E:\\ABM for Human Movements'
    outputPath = path + '\\OutputData'

    timeSeriesDic = {}    # {网格id:[]}----{1:[], 2: [], 3: [], ...}
    dirName = ['bef', 'dur', 'aft']
    k = 0   # 时间序列中的某小时
    for dir in dirName:
        filePath = path + '\\Data\\ODT_7_' + dir
        for file in os.listdir(filePath):
            print(file)
            t1 = time.time()
            for i in range(24):
                ODT_day_sheet = pd.read_excel(filePath + '\\' + file, header=None, sheet_name=i)
                D_day_sheet = list(ODT_day_sheet[1].unique())
                for D in D_day_sheet:
                    D_day_sheet = ODT_day_sheet[ODT_day_sheet[1] == D]
                    if len(D_day_sheet) != 0:
                        count = D_day_sheet[2].sum()
                    else:
                        count = 0
                    if D not in timeSeriesDic.keys():
                        timeSeriesDic[D] = [0] * (17 * 24)
                    timeSeriesDic[D][k] = count
                k += 1  # 计数时间步长
            t2 = time.time()
            print('用时分钟：' + str(round((t2-t1)/60)))

        timeSeries_df = pd.DataFrame(timeSeriesDic)
        timeSeries_df = timeSeries_df.T
        timeSeries_df.sort_index(inplace=True)

        timeSeries_df.to_csv(outputPath+'\\Inflow_TS_v1.csv', index=True, header=True)
