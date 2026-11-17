# -*- coding: utf-8 -*-
# python 3.9
# 时间序列分解，去掉时间项
"""
#@Author: LW
#@FileName: 4_TimeSeriesDecomposition.py
#@Time: 2023/5/28 10:09  
#Software: PyCharm
---------------------------
"""

import numpy as np
import pandas as pd
import random
import statsmodels.api as sm
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
import matplotlib.patches as mpatches


if __name__ == '__main__':
    path = 'E:\\ABM for Human Movements'
    outputPath = path + '\\OutputData'

    # 首先确定每一类样本的抽取的数量
    quadrants = pd.read_csv(path + '\\OutputData\\quadrants.csv', header=0)
    # Merge
    quadrants.loc[quadrants['Quadrant'] == 4, ['Quadrant']] = 1
    quadrants.loc[quadrants['Quadrant'] == 3, ['Quadrant']] = 2
    sampleSize = round(len(quadrants) * 0.05)   # 598
    cls = quadrants['Quadrant'].unique()
    qrsSampleLen = []    # 每一类的样本数量
    for c in cls:
        qrLen = len(quadrants[quadrants['Quadrant'] == c])
        qrSampleLen = round(qrLen * 0.05)    # 样本数量
        qrsSampleLen.append(qrSampleLen)
    if sum(qrsSampleLen) != sampleSize:
        diff = sampleSize - sum(qrsSampleLen)
        qrsSampleLen[-1] += diff

    timeSeries = pd.read_csv(outputPath + '\\Inflow_TS_v1.csv', header=0, index_col=0)
    timeSeries = timeSeries.T
    dti = pd.date_range('2021-07-13', periods=17*24, freq='H')
    dti2 = ['07/' + str(item) for item in range(13, 30)]
    timeSeries.index = dti

    colors = ['b', 'r', 'y', 'g']

    # 分层抽样
    no = 1
    for no in range(10):
        sampleDic = {}  # {1: [], 2: [],...}
        tids = quadrants['Tid'].unique()    # 网格的id
        for c in cls:
            qr = quadrants[quadrants['Quadrant'] == c]
            tid = list(qr['Tid'].unique())
            sample = random.sample(tid, qrsSampleLen[c-1])
            if c-1 not in sampleDic.keys():
                sampleDic[c-1] = []
            sampleDic[c-1] = sample

        np.save(outputPath + '\\TSD_1day\\sample_' + str(no) + '.npy', sampleDic)

        plt.figure(figsize=(40, 30))
        xticks = range(17*24)
        for c in cls:
            # plt.figure(figsize=(40, 30)
            sample = sampleDic[c - 1]
            for i in sample:
                res = sm.tsa.seasonal_decompose(timeSeries[i], period=24)
                seasonal = res.seasonal
                trend = res.trend
                TS = np.array(timeSeries[i])
                newTS = TS - seasonal
                pos = np.isnan(trend)
                newTS[pos] = np.nan
                # print(newTS)
                plt.plot(xticks, newTS, colors[c - 1], lw=1.5, alpha=0.2)
                # break
        plt.xticks(list(range(0, 17*24, 24)), dti2, fontsize=38, fontweight='bold') #, rotation=45)
        plt.yticks(fontsize=45, fontweight='bold')
        plt.xlabel('Time', labelpad=30, fontsize=60, fontweight='bold')
        plt.ylabel('Value', labelpad=30, fontsize=60, fontweight='bold')
        # plt.axis([0, 17*24, -1000, 3000])
        bwith = 10  # 边框宽度设置为2
        ax = plt.gca()  # 获取边框
        ax.tick_params(length=15, width=5, pad=40, top='on', right='on', which='both', direction='in')
        ax.spines['bottom'].set_linewidth(bwith)
        ax.spines['left'].set_linewidth(bwith)
        ax.spines['top'].set_linewidth(bwith)
        ax.spines['right'].set_linewidth(bwith)
        for k in range(96, 24*17, 24*7):
            plt.axvspan(xmin=k, xmax=k+24*2, facecolor="grey", alpha=0.1)

        legendElement = [
            Line2D([0], [0], color='b', lw=1.5, label='sample_(Q1+Q4)', alpha=0.2),
            Line2D([0], [0], color='r', lw=1.5, label='sample_(Q2+Q3)', alpha=0.2),
        ]

        plt.legend(handles=legendElement, ncol=1, borderaxespad=1,
                   loc='best', fontsize=60, frameon=False)
        plt.title('sample_' + str(no+1), fontsize=80, fontweight='bold', pad=50)

        plt.savefig(outputPath + '\\Pic\\TSD_1day\\TSD_' + str(no+1) + '.png', dpi=300)
        plt.show()

