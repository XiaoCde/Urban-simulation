# -*-coding:utf-8 -*-
# python 3.9
# 双轴图：绘制每个场景的平均 net benefit 和 ratio 曲线，得到平衡点

"""
# @File       : 13_CBA_NB_GR.py
# @software   : PyCharm  
# @Time       ：2025/5/7 20:07
# @Author     ：Wei Lyu
"""

import pandas as pd
import matplotlib.pyplot as plt
from matplotlib.ticker import ScalarFormatter
import numpy as np

plt.rcParams['pdf.fonttype'] = 42

def find_elbow(x, y):
    # 起点与终点构成直线向量
    line_vec = np.array([x[-1] - x[0], y[-1] - y[0]])
    line_vec = line_vec / np.linalg.norm(line_vec)

    # 计算每个点与起点的向量
    vecs = np.column_stack((x - x[0], y - y[0]))

    # 投影距离
    proj = np.dot(vecs, line_vec)
    proj_vec = np.outer(proj, line_vec)

    # 计算垂直距离（欧几里得距离）
    distances = np.linalg.norm(vecs - proj_vec, axis=1)

    return np.argmax(distances), x[np.argmax(distances)], y[np.argmax(distances)]

if __name__ == '__main__':
    # === 路径与数据读取 ===
    path = 'D:/LW/ABM/OutputData/Result/cities_21_max/Inflow/sigma=1/NumPerShelter/'
    lowers = pd.read_csv(path + 'scenarios_lowers.csv', header=0)
    uppers = pd.read_csv(path + 'scenarios_uppers.csv', header=0)
    trues = pd.read_csv(path + 'scenarios_trues.csv', header=0)

    # === 提取场景名称（如 priority0.05）===
    all_columns = lowers.columns.tolist()
    scenario_cols = [col.split('_')[0] for col in all_columns if '_BCR' in col]
    unique_scenarios = sorted(set(scenario_cols), key=lambda x: float(x.replace("priority", "")))

    # === 横轴标签 ===
    scenarios_text = [str(int(float(s.replace("priority", "")) * 100)) for s in unique_scenarios]

    # === 计算均值与置信区间 ===
    nb_mean = [trues[s + '_NB'].mean() for s in unique_scenarios]
    nb_lower = [lowers[s + '_NB'].mean() for s in unique_scenarios]
    nb_upper = [uppers[s + '_NB'].mean() for s in unique_scenarios]

    # === 确保置信区间为 NumPy 数组 ===
    nb_lower = np.array(nb_lower)
    nb_upper = np.array(nb_upper)

    # === 计算变化率 ===
    nb_mean = np.array(nb_mean)
    growth_rate = np.diff(nb_mean) / nb_mean[:-1]
    growth_rate = np.insert(growth_rate, 0, growth_rate[0])  # 用首个变化率补齐长度

    # gr_lower = (nb_lower[1:] - nb_upper[:-1]) / nb_upper[:-1]
    # gr_upper = (nb_upper[1:] - nb_lower[:-1]) / nb_lower[:-1]
    # gr_lower = np.insert(gr_lower, 0, gr_lower[0])
    # gr_upper = np.insert(gr_upper, 0, gr_upper[0])

    # === 绘图 ===
    fig, ax1 = plt.subplots(figsize=(7, 4))

    # 左轴：Net Benefit
    color1 = '#AD5380'#'#C18296' #D89490'# '#62B078' # '#A15456'
    ax1.set_xlabel('Strategy (%)', fontsize=13)
    ax1.set_ylabel('Net benefit', fontsize=13)
    line1, = ax1.plot(scenarios_text, nb_mean, color=color1, alpha=0.5, linewidth=4, label=f'Net benefit')
    nb_mean_max = max(nb_mean)
    nb_mean_min = min(nb_mean)
    nb_range = nb_mean_max - nb_mean_min
    nb_pad = nb_range * 0.2

    ax1_ylim = (
        nb_mean_min - nb_pad,
        nb_mean_max + nb_pad
    )

    ax1.set_ylim(*ax1_ylim)

    # 计算 Net Benefit 的误差棒长度
    nb_err_lower = nb_mean - nb_lower
    nb_err_upper = nb_upper - nb_mean
    nb_err = [nb_err_lower, nb_err_upper]

    ax1.fill_between(scenarios_text, nb_lower, nb_upper, color=color1, alpha=0.2)
    ax1.tick_params(axis='y', labelsize=14)
    ax1.tick_params(axis='x', labelsize=13)
    ax1.yaxis.set_major_formatter(ScalarFormatter(useMathText=True))
    ax1.yaxis.get_major_formatter().set_scientific(True)
    ax1.yaxis.get_major_formatter().set_powerlimits((-2, 2))
    ax1.spines['top'].set_visible(False)
    # 右轴：增长率
    ax2 = ax1.twinx()
    color2 = '#3B4E7D'# '#94A3B8' # '#3D499B'
    ax2.set_ylabel('Growth Rate of Net Benefit', fontsize=15)
    line2, = ax2.plot(scenarios_text, growth_rate, color=color2, alpha=0.6, linewidth=4, label=f'Growth rate')
    growth_rate_max = max(growth_rate)
    growth_rate_min = min(growth_rate)
    growth_rate_range = growth_rate_max - growth_rate_min
    growth_rate_pad = growth_rate_range * 0.2

    ax2_ylim = (
        growth_rate_min - growth_rate_pad,
        growth_rate_max + growth_rate_pad
    )

    ax2.axhline(y=0.05, color='gray', linestyle='--', linewidth=1.5)
    ax2.set_ylim(*ax2_ylim)
    # ax2.fill_between(scenarios_text, gr_lower, gr_upper, color=color2, alpha=0.2)
    ax2.tick_params(axis='y', labelsize=14)
    ax2.spines['top'].set_visible(False)
    # === 添加 marker ===
    for mark_x in ['25', '30', '35']:
        if mark_x in scenarios_text:
            idx = scenarios_text.index(mark_x)
            # 在左轴 Net Benefit 曲线上画圆点
            ax1.plot(mark_x, nb_mean[idx], 'o', color=color1, markersize=6)
            ax1.annotate(f'{nb_mean[idx]:,.0f}',
                         xy=(mark_x, nb_mean[idx]),
                         xytext=(0, 10),
                         textcoords='offset points',
                         ha='center',
                         fontsize=10,
                         color=color1)
            # 在右轴 Growth Rate 曲线上画三角形
            ax2.plot(mark_x, growth_rate[idx], 'o', color=color2, markersize=6)
            ax2.annotate(f'{growth_rate[idx]:.4f}',
                         xy=(mark_x, growth_rate[idx]),
                         xytext=(0, -15),
                         textcoords='offset points',
                         ha='center',
                         fontsize=10,
                         color=color2)
            # 添加垂直线
            ax1.axvline(x=mark_x, color='gray', linestyle='--', linewidth=1.5)

    # 标注 & 布局
    # 合并两个图例并显示
    lines = [line1, line2]
    labels = [line.get_label() for line in lines]
    fig.legend(lines, labels, loc='center right')
    fig.tight_layout()
    plt.savefig(r'D:\LW\ABM\OutputData\Result\pic\sigma=1\Inflow\NumPerShelter\CBA_NB_GR.pdf')  # 可选导出
    plt.show()