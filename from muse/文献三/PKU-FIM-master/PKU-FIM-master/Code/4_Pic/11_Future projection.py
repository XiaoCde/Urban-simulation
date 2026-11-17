# -*-coding:utf-8 -*-
# 绘制三个小提琴图，每个指标对应一个小提琴图（count, prop, total inflow sum）
#

"""
# @File       : 11_Future projection.py
# @software   : PyCharm  
# @Time       ：2025/5/24 16:21
# @Author     ：Wei Lyu
"""

import pandas as pd
import numpy as np
from scipy import stats
import matplotlib.pyplot as plt
import seaborn as sns

plt.rcParams['pdf.fonttype'] = 42

if __name__ == '__main__':
    # 读取数据
    df_current = pd.read_csv(r'D:\LW\ABM\OutputData\Result\cities_21_max\Inflow\sigma=1\NumPerShelter\match_stats.csv', usecols=['city', 'count', 'hazard', 'human_expo'], header=0)
    df_ssp = pd.read_csv(r'D:\LW\ABM\OutputData\Result_SSP585_pop2\cities_21_max\Inflow\sigma=1\NumPerShelter\match_stats.csv', usecols=['city', 'count', 'hazard', 'human_expo'], header=0)

    # 添加状态标识
    df_current['Scenario'] = 'Current'
    df_ssp['Scenario'] = 'SSP585'

    # 合并数据
    df_combined = pd.concat([df_current, df_ssp], ignore_index=True)
    #
    # # 添加 total_inflow_sum 字段
    # df_combined['total_inflow_sum'] = df_combined['deficit_inflow_sum'] + df_combined['surplus_inflow_sum']

    # 定义颜色
    palette = {0: {"Current": "#B3D7E5", "SSP585": "#CF92A8"}, 1: {"Current": "#C2A6D2", "SSP585": "#CFDCCB"},
               2: {"Current": "#C2C7E3", "SSP585": "#DC8E84"}}

    # 绘制图形
    plt.figure(figsize=(12, 4))
    # 改成无网格线
    sns.set(style="ticks")

    for idx, (metric, title) in enumerate(zip(['hazard', 'count', 'human_expo'], ['Potential flooded area', 'Mismatch area', 'Population exposure'])):
        plt.subplot(1, 3, idx + 1)

        # 小提琴图
        sns.violinplot(x='Scenario', y=metric, data=df_combined, hue='Scenario', palette=palette[idx], linewidth=0, inner=None)

        # 使用 stripplot 显示每个城市点
        sns.stripplot(x='Scenario', y=metric, data=df_combined, hue='Scenario', palette=palette[idx], jitter=0.03, size=7, alpha=1, edgecolor='k', linewidth=1, legend=False)

        # 添加均值线
        y_min = df_combined[metric].min()
        means = df_combined.groupby('Scenario')[metric].mean()
        for state, mean_val in means.items():
            xpos = 0 if state == 'Current' else 1
            plt.plot([xpos - 0.2, xpos + 0.2], [mean_val, mean_val], color='k', lw=1.5, linestyle='--')
            plt.text(xpos, y_min - 0.5 * abs(y_min), f'Avg. ({mean_val:.2f})', color='k', ha='center', va='bottom', fontsize=11)  # 添加标注


        sums = df_combined.groupby('Scenario')[metric].sum()
        for state, sum_val in sums.items():
            xpos = 0 if state == 'Current' else 1
            plt.text(xpos, y_min - 0.7 * abs(y_min), f'Sum. ({sum_val:.2f})', color='k', ha='center', va='top', fontsize=11)  # 添加标注

        # 计算并添加 p 值
        group1 = df_combined[df_combined['Scenario'] == 'Current'][metric]
        group2 = df_combined[df_combined['Scenario'] == 'SSP585'][metric]
        t_stat, p_val = stats.ttest_ind(group1, group2, nan_policy='omit')
        plt.text(0.5, max(df_combined[metric]) * 0.95, f"P-value ({p_val:.3f})", ha='center', fontsize=12)

    plt.tight_layout()
    plt.savefig(r'D:\LW\ABM\OutputData\Result_SSP585_pop2\pic\sigma=1\future_proj_comparison.pdf')
    plt.show()