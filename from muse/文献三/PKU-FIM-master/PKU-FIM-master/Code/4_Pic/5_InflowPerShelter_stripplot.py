# -*-coding:utf-8 -*-
# python 3.9

"""
# @File       : 5_InflowPerShelter_stripplot.py
# @software   : PyCharm  
# @Time       ：2024/8/14 13:56
# @Author     ：Wei Lyu
"""

import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
import numpy as np
import seaborn as sns
import pandas as pd

plt.rcParams['pdf.fonttype'] = 42

if __name__ == '__main__':
    path = 'D:/LW/ABM/OutputData'

    sigma = 1

    # 设置随机数种子， stripplot每次抖动一致
    np.random.seed(42)

    df = pd.read_csv(path + '/Result/cities_21_max/Inflow/sigma=' + str(sigma) + '/inflowPerShelter_forStripplot.csv',header=0)

    # 创建自定义颜色映射
    colors = ['#F0D3DF'] * 21
    # colors = ['#CBCBE0'] * 21 # BOX颜色

    cmap = LinearSegmentedColormap.from_list('custom_cmap', colors, N=len(colors))

    # 绘制箱型图
    plt.figure(figsize=(16, 5)) # 8000+
    # plt.figure(figsize=(16, 10)) # 8000-
    lw = 1

    sns.stripplot(x='City', y='inflowPerShelter', data=df, jitter=0.1, alpha=0.5, color='#CEA2B5', size=4)    # 粉色
    
    boxplot = sns.boxplot(x='City', y='inflowPerShelter', hue='City', data=df, boxprops=dict(edgecolor="k", linewidth=lw),
                medianprops=dict(color="k", linewidth=lw), whiskerprops=dict(color="k", linewidth=lw),
                capprops=dict(color="k", linewidth=lw), palette=colors, fliersize=0)

    # plt.ylim(0, 8000)  # 限定y轴的范围
    plt.ylim(8000,)  # 限定y轴的范围

    # 计算每个类别的平均值
    means = df.groupby('City')['inflowPerShelter'].mean()

    # 为每个箱型图添加平均线
    for i, category in enumerate(means.index):
        plt.axhline(means[category], color='#2B589B', linestyle='--', xmin=i / len(means), xmax=(i + 1) / len(means), zorder=3) #1b3e89

    plt.ylabel('Inflow served per shelter', fontsize=16)
    plt.xlabel('City', fontsize=16)

    plt.xticks(fontsize=14)
    plt.yticks(fontsize=15)
    plt.xticks(rotation=45)

    ax = plt.gca()  # 获取当前轴对象
    ax.spines['bottom'].set_linewidth(1)  # x轴
    ax.spines['left'].set_linewidth(1)  # y轴
    ax.spines['top'].set_linewidth(1)  # 上边框
    ax.spines['right'].set_linewidth(1)  # 右边框

    # plt.savefig(path + '/Result/pic/sigma=' + str(sigma) + '/Inflow/NumPerShelter/ms_boxplot(ft-0&inf)8000-.png', dpi=300)
    # plt.savefig(path + '/Result/pic/sigma=' + str(sigma) + '/Inflow/NumPerShelter/ms_boxplot(ft-0&inf)8000-.pdf')

    plt.savefig(path + '/Result/pic/sigma=' + str(sigma) + '/Inflow/NumPerShelter/ms_boxplot(ft-0&inf)8000+.pdf')