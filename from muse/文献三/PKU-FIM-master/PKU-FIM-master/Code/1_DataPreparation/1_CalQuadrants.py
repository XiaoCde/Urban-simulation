# -*- coding: utf-8 -*-
# python3.8

"""
#@Author  : Wei Lyu
#@FileName: 1_CalQuadrants.py
#@Time    : 2023/11/30 9:28
#@Software: PyCharm 
"""

import pandas as pd
import os

if __name__ == '__main__':

    path = '/remote-home/lw/ABM'
    # path = 'D:/LW/ABM'

    dataPath = path + '/Data'
    outputPath = path + '/OutputData'

    # 前7天平均
    dir = 'ODT_7_bef'
    files = os.listdir(dataPath + '/' + dir)
    count = 0
    bef = pd.DataFrame()
    for file in files:
        for i in range(24):
            df = pd.read_excel(dataPath + '/' + dir + '/' + file, header=None, sheet_name=str(i))
            bef = pd.concat([bef, df])
            count += len(df)
            print(file + str(i))
    print(len(bef))
    bef = bef[bef[0] != bef[1]]
    print(count)
    print(len(bef))
    del df



    # 计算灾前inflow
    tmp = bef.groupby(bef[1]).sum()  # 根据D group by
    inflow_bef_7 = tmp[2]
    inflow_bef_hour = inflow_bef_7 / 7 / 24 # 小时平均
    del tmp

    inflow_bef_hour = inflow_bef_hour.to_frame()
    inflow_bef_hour.reset_index(inplace=True)
    inflow_bef_hour.columns = ['Tid', 'Value']
    inflow_bef_hour.index = inflow_bef_hour['Tid']

    inflow_bef_hour.to_csv(outputPath + '/inflow_bef_aveHour.csv', header=True, index=False)



    # 计算灾前outflow
    tmp = bef.groupby(bef[0]).sum()  # 根据O group by
    outflow_bef_3 = tmp[2]
    outflow_bef_hour = outflow_bef_3 / 3 / 24
    del tmp

    outflow_bef_hour = outflow_bef_hour.to_frame()
    outflow_bef_hour.reset_index(inplace=True)
    outflow_bef_hour.columns = ['Tid', 'Value']
    outflow_bef_hour.index = outflow_bef_hour['Tid']
    outflow_bef_hour.to_csv(outputPath + '/outflow_bef_aveHour.csv', header=True, index=False)



    # 灾前netflow
    tids0 = list(set(inflow_bef_hour.index) | set(outflow_bef_hour.index))
    netflow_bef_hour = pd.DataFrame({'Tid': tids0, 'Value': [0.0] * len(tids0)}, index=tids0)

    for tid in tids0:
        s1 = 0
        s2 = 0
        if tid in inflow_bef_hour.index:
            s1 = inflow_bef_hour.loc[tid, 'Value']
        if tid in outflow_bef_hour.index:
            s2 = outflow_bef_hour.loc[tid, 'Value']
        s3 = s1 - s2
        netflow_bef_hour.loc[tid, 'Value'] = s3
    netflow_bef_hour = netflow_bef_hour[~(netflow_bef_hour['Value'] == 0)]
    netflow_bef_hour.to_csv(outputPath + '/netflow_bef_aveHour.csv', header=True, index=False)

    # 灾中
    dir = 'ODT_3_dur' 
    files = os.listdir(dataPath + '/' + dir)
    count = 0
    dur = pd.DataFrame()
    for file in files:
        for i in range(24):
            df = pd.read_excel(dataPath + '/' + dir + '/' + file, header=None, sheet_name=str(i))
            dur = pd.concat([dur, df])
            count += len(df)
            print(file + str(i))
    print(len(dur))
    dur = dur[dur[0] != dur[1]]
    print(count)
    print(len(dur))
    del df

    tmp = dur.groupby(dur[1]).sum()  # 根据D group by
    inflow_dur_3 = tmp[2]
    inflow_dur_hour = inflow_dur_3 / 3 / 24
    del tmp

    inflow_dur_hour = inflow_dur_hour.to_frame()
    inflow_dur_hour.reset_index(inplace=True)
    inflow_dur_hour.columns = ['Tid', 'Value']
    inflow_dur_hour.index = inflow_dur_hour['Tid']

    inflow_dur_hour.to_csv(outputPath + '/inflow_dur_aveHour.csv', header=True, index=False)



    # 计算灾中outflow
    tmp = dur.groupby(dur[0]).sum()  # 根据O group by
    outflow_dur_3 = tmp[2]
    outflow_dur_hour = outflow_dur_3 / 3 / 24
    del tmp

    outflow_dur_hour = outflow_dur_hour.to_frame()
    outflow_dur_hour.reset_index(inplace=True)
    outflow_dur_hour.columns = ['Tid', 'Value']
    outflow_dur_hour.index = outflow_dur_hour['Tid']

    outflow_dur_hour.to_csv(outputPath + '/outflow_dur_aveHour.csv', header=True, index=False)



    # 计算灾中netflow
    tids2 = list(set(inflow_dur_hour.index) | set(outflow_dur_hour.index))
    netflow_dur_hour = pd.DataFrame({'Tid': tids2, 'Value': [0.0] * len(tids2)}, index=tids2)
    for tid in tids2:
        s1 = 0
        s2 = 0
        if tid in inflow_dur_hour.index:
            s1 = inflow_dur_hour.loc[tid, 'Value']
        if tid in outflow_dur_hour.index:
            s2 = outflow_dur_hour.loc[tid, 'Value']
        s3 = s1 - s2
        netflow_dur_hour.loc[tid, 'Value'] = s3
    netflow_dur_hour = netflow_dur_hour[~(netflow_dur_hour['Value'] == 0)]
    netflow_dur_hour.to_csv(outputPath + '/netflow_dur_aveHour.csv', header=True, index=False)



    # 计算红蓝图，灾中减灾前
    tids = list(set(netflow_bef_hour.index) | set(netflow_dur_hour.index))
    df = pd.DataFrame({'Tid': tids, 'Value': [0.0] * len(tids)}, index=tids)
    for tid in tids:
        s1 = 0
        s2 = 0
        if tid in netflow_bef_hour.index:
            s1 = netflow_bef_hour.loc[tid, 'Value']
        if tid in netflow_dur_hour.index:
            s2 = netflow_dur_hour.loc[tid, 'Value']
        s3 = s2 - s1
        df.loc[tid, 'Value'] = s3
    df = df[~(df['Value'] == 0)]  # 去除0的部分
    df.to_csv(outputPath + '/new_2quadrants(netflow)_aveHour.csv', header=True, index=False)

    # 计算红蓝图，灾中减灾前
    tids = list(set(inflow_bef_hour.index) | set(inflow_dur_hour.index))
    df = pd.DataFrame({'Tid': tids, 'Value': [0.0] * len(tids)}, index=tids)
    for tid in tids:
        s1 = 0
        s2 = 0
        if tid in inflow_bef_hour.index:
            s1 = inflow_bef_hour.loc[tid, 'Value']
        if tid in inflow_dur_hour.index:
            s2 = inflow_dur_hour.loc[tid, 'Value']
        s3 = s2 - s1
        df.loc[tid, 'Value'] = s3
    df = df[~(df['Value'] == 0)]  # 去除0的部分
    df.to_csv(outputPath + '/new_2quadrants(inflow)_aveHour.csv', header=True, index=False)