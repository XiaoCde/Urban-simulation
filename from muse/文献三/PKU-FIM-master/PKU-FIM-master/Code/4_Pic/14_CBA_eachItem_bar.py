# -*-coding:utf-8 -*-
# python 3.9
# 绘制横向柱状图，x轴是各项费用，y轴是城市


"""
# @File       : 14_CBA_eachItem_bar.py
# @software   : PyCharm  
# @Time       ：2025/3/24 16:48
# @Author     ：Wei Lyu
"""

import pandas as pd
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.ticker import LogLocator
plt.rcParams['pdf.fonttype'] = 42

if __name__ == '__main__':
    path = 'D:/LW/ABM/OutputData'
    sigma = 1

    # 读取数据
    df = pd.read_csv(path + '/Result/cities_21_max/Inflow/sigma=' + str(sigma) + '/NumPerShelter/scenarios_trues.csv')  # 替换为你的文件路径

    cities = ['Beijing', 'Chengdu', 'Chongqing', 'Dalian', 'Dongguan', 'Shanghai', 'Qingdao', 'Hangzhou',
     'Harbin', 'Zhengzhou', 'Shenzhen', 'Xi\'an', 'Changsha', 'Wuhan', 'Foshan', 'Jinan', 'Shenyang',
     'Guangzhou', 'Tianjin', 'Kunming', 'Nanjing']
    df = df.set_index('City').loc[cities].reset_index()

    # 成本与效益字段
    cost_fields = ['priority0.3_insur', 'priority0.3_oti', 'priority0.3_aom']
    benefit_fields = ['priority0.3_ce', 'priority0.3_dmf', 'priority0.3_del', 'priority0.3_ma']

    # 图例标签
    cost_labels = ['PI', 'CON', 'AOM']
    benefit_labels = ['CE', 'DME', 'DEL', 'MA']

    # 配色方案（可自定义为论文统一色系）
    cost_colors = ['#6D8FAF', '#A3BFD9', '#C4D7EE']
    benefit_colors = ['#D59EC2', '#E6B8C4', '#F1D3E1', '#F5E6EF']

    # 计算总成本和总效益
    total_costs = df[cost_fields].sum(axis=1)
    total_benefits = df[benefit_fields].sum(axis=1)

    # === 创建上下布局图 ===
    fig, (ax1, ax2) = plt.subplots(nrows=2, figsize=(6, 10), sharey=True, gridspec_kw={'hspace': 0.2})

    # --- 成本图 ---
    cost_base = np.zeros(len(cities))
    for i, field in enumerate(cost_fields):
        values = df[field]
        ax1.barh(cities, values, left=cost_base, color=cost_colors[i], label=cost_labels[i])
        cost_base += values

    ax1.set_xscale('symlog', linthresh=1e3)
    ax1.xaxis.set_major_locator(LogLocator(base=10.0, subs=(1.0,), numticks=10))
    ax1.xaxis.set_minor_locator(LogLocator(base=10.0, subs='auto', numticks=100))
    ax1.set_xlim(10, )

    ax1.set_xlabel('Cost (million US dollar)', fontsize=12)
    ax1.invert_yaxis()

    ax1.invert_xaxis()  # 翻转 x 轴（值越大越靠左）
    ax1.yaxis.tick_right()  # Y 轴刻度放右
    ax1.yaxis.set_label_position("right")  # 标签放右

    mean_cost = total_costs.mean()
    ax1.axvline(mean_cost, color='gray', linestyle='--', linewidth=1)
    ax1.text(mean_cost * 1.1, -1, f'Cost avg.: {mean_cost / 1e6:.2f}', fontsize=9, va='bottom')

    ax1.spines['left'].set_visible(False)
    ax1.spines['top'].set_visible(False)

    # 总成本标注
    for i, val in enumerate(total_costs):
        ax1.text(val * 1.2, i, f'{val / 1e6:.2f}', va='center', ha='right', fontsize=8)

    # --- 效益图 ---
    benefit_base = np.zeros(len(cities))
    for i, field in enumerate(benefit_fields):
        values = df[field]
        ax2.barh(cities, values, left=benefit_base, color=benefit_colors[i], label=benefit_labels[i])
        benefit_base += values

    ax2.set_xscale('symlog', linthresh=1e3)
    ax2.xaxis.set_major_locator(LogLocator(base=10.0, subs=(1.0,), numticks=10))
    ax2.xaxis.set_minor_locator(LogLocator(base=10.0, subs='auto', numticks=100))
    ax2.set_xlim(10, )
    ax2.set_xlabel('Benefit (million US dollar)', fontsize=12)

    mean_benefit = total_benefits.mean()
    ax2.axvline(mean_benefit, color='gray', linestyle='--', linewidth=1)
    ax2.text(mean_benefit * 1.1, -1, f'Benefit avg.: {mean_benefit / 1e6:.2f}', fontsize=9, va='bottom')

    ax2.spines['right'].set_visible(False)
    ax2.spines['top'].set_visible(False)

    # 总效益标注
    for i, val in enumerate(total_benefits):
        ax2.text(val * 1.2, i, f'{val / 1e6:.2f}', va='center', fontsize=8)

    # --- 图例统一设置 ---
    handles1, labels1 = ax1.get_legend_handles_labels()
    handles2, labels2 = ax2.get_legend_handles_labels()
    fig.legend(handles1 + handles2, labels1 + labels2, loc='lower center', ncol=7, bbox_to_anchor=(0.5, 0.01), fontsize=10)

    # === 保存图像 ===
    fig.savefig(path + '\\' + r'Result\pic\sigma=1\Inflow\NumPerShelter\\' + "CBA_eachItem_bar.pdf", format='pdf', dpi=600, bbox_inches='tight')

    plt.tight_layout()
    plt.show()

