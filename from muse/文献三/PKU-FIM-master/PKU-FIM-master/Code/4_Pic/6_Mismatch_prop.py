# -*-coding:utf-8 -*-
# python 3.9
# 绘制一个环形堆叠柱状图

"""
# @File       : 6_Mismatch_prop.py
# @software   : PyCharm  
# @Time       ：2024/8/15 23:50
# @Author     ：Wei Lyu
"""

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

plt.rcParams['pdf.fonttype'] = 42

if __name__ == '__main__':
    path = 'D:/LW/ABM/OutputData'

    sigma = 1

    summary = pd.read_csv(path + '/Result/cities_21_max/Inflow/sigma=' + str(sigma) + '/NumPerShelter/match_stats.csv', header=0)

    # 提取数据
    summary['deficit_prop'] = summary['deficit'] / summary['count'] * summary['prop'] * 100 # 转成百分数
    summary['surplus_prop'] = summary['surplus'] / summary['count'] * summary['prop'] * 100

    # 设置极坐标，并将图形放大5倍
    fig, ax = plt.subplots(figsize=(20, 20), subplot_kw={'projection': 'polar'})

    # 设置缝隙大小
    gap = 0.1  # 缝隙的角度大小

    # 设置每个柱形的固定角度
    fixed_angle = 2 * np.pi / len(summary)

    # 使用固定角度来绘制柱形
    angles_with_gap = np.full(len(summary), fixed_angle - gap)
    cum_angle = np.linspace(0, 2 * np.pi, len(summary), endpoint=False) + fixed_angle / 2

    # 绘制 deficit 部分
    bars1 = ax.bar(cum_angle, summary['deficit_prop'], width=angles_with_gap, bottom=10, color='#AAB2D6', edgecolor='black', linewidth=1.5, alpha=1)#a089a5

    # 绘制 surplus 部分
    bars2 = ax.bar(cum_angle, summary['surplus_prop'], width=angles_with_gap, bottom=summary['deficit_prop'] + 10, color='#E59693', edgecolor='black', linewidth=1.5, alpha=1)#f27f8e

    # 添加标签
    for i, (angle, city, deficit, surplus) in enumerate(zip(cum_angle, summary['city'], summary['deficit_prop'], summary['surplus_prop'])):
        # 计算标签的位置
        x = angle
        y = 10 + deficit + surplus + 5  # 标签放置在柱形的末端外部

        # 添加标签文字
        text = str(round(deficit, 2)) + '%(+' + str(round(surplus, 2)) + '%)'
        ax.text(x, y, text, ha='center', va='center', fontsize=16, color='black', rotation_mode='anchor')

    # 设置标签和环形半径
    ax.set_yticklabels([])
    ax.set_xticks(cum_angle)
    ax.set_xticklabels(summary['city'], fontsize=20)

    # 设置极坐标的起始位置
    ax.set_theta_offset(np.pi / 2)
    ax.set_theta_direction(-1)

    # 显示图形
    plt.savefig(path + '/Result/pic/sigma=' + str(sigma) + '/Inflow/NumPerShelter/mismatch_prop.pdf')
