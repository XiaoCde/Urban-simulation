# -*-coding:utf-8 -*-
# python 3.9
# 绘制横向统计图，左侧是inflow平均气泡图，右侧是面积
# 气泡图新增一列，得到deficit area的affected pop

"""
# @File       : 7.1_Mismatch_Inflow&Area.py
# @software   : PyCharm  
# @Time       ：2024/8/16 22:47
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
    human_expo = summary['human_expo']/1000000
    area_deficit = summary['deficit']/1000
    area_surplus = summary['surplus']/1000

    # 设置y轴
    y = np.arange(len(summary))[::-1]

    # 创建图形和两个子图
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10, 8), gridspec_kw={'width_ratios': [0.4, 2]}, sharey=True)
    # plt.subplots_adjust(wspace=1)  # 将 wspace 的值调大以增加子图之间的间距

    # 绘制左侧气泡图
    x_labels = ['Human exposure']
    bubble_data = np.array(human_expo[::-1]).T  # 转置矩阵

    x_positions = np.array([0])
    ax1.set_xticks(x_positions)

    # 绘制左侧子图（气泡热图），缩小气泡
    scatter = ax1.scatter(np.tile(x_positions, len(bubble_data)), np.repeat(np.arange(len(bubble_data)), 1),
                          s=bubble_data.flatten() * 140, c=bubble_data.flatten(), cmap='Blues', alpha=0.8, edgecolor='black')

    # 设置x轴从-0.5开始
    ax1.set_xlim(-0.5, len(x_labels) - 0.5)
    ax1.yaxis.set_ticks_position('right')  # 将y轴刻度线移到右侧
    ax1.set_xticklabels(x_labels, rotation=-45)

    # 添加渐变绿色的colorbar，并放置在左侧框线外
    cbar = plt.colorbar(scatter, ax=ax1, orientation='vertical', pad=0.3)
    cbar.set_label('Value')
    cbar.ax.tick_params(labelsize=12)
    cbar.outline.set_visible(False)

    # 绘制右侧子图（反转后的area），调整为正值以分布在右侧
    ax2.barh(y, area_deficit, color='#abb6d9', label='Area Deficit', align='center', edgecolor='black', linewidth=1)
    ax2.barh(y, area_surplus, left=area_deficit, color='#dda1db', label='Area Surplus', align='center', edgecolor='black', linewidth=1)
    ax2.set_xlabel('Total area', fontsize=12)
    ax2.tick_params(axis='x', labelsize=12)

    # 将X轴移到中央
    ax2.spines['left'].set_position('zero')
    ax2.spines['left'].set_color('black')
    ax2.spines['left'].set_linewidth(1.5)

    # # 隐藏顶部和右侧的边框
    ax2.spines['top'].set_color('none')
    ax2.spines['right'].set_color('none')

    # 设置y轴标签并隐藏 ylabel
    ax1.set_yticks(y)
    ax1.set_yticklabels(summary['city'], fontsize=12)
    ax1.set_ylabel('')  # 隐藏 ylabel
    ax1.tick_params(axis='y', pad=80)  # 将 pad 的值调大以增加 yticklabels 与 y 轴之间的距离

    # 添加合并的图例
    handles2, labels2 = ax2.get_legend_handles_labels()
    fig.legend(handles2, labels2, loc='lower right', ncol=2, frameon=False)

    # 在右侧子图的中间添加area的具体数值标注，并标注surplus的数值
    for i in range(len(y)):
        area_deficit_value = round(area_deficit[i], 2)
        area_surplus_value = round(area_surplus[i], 2)
        ax2.text(3.5, y[i], f'{area_deficit_value} (+{area_surplus_value})', va='center', ha='center', color='black')

    # 设置X轴和Y轴的线条宽度相同
    ax1.spines['left'].set_linewidth(1.5)
    ax1.spines['right'].set_linewidth(1.5)  # 设置X轴的线条宽度
    ax1.spines['top'].set_linewidth(1.5)
    ax1.spines['bottom'].set_linewidth(1.5)  # 设置X轴的线条宽度

    ax2.spines['left'].set_linewidth(1.5)
    ax2.spines['bottom'].set_linewidth(1.5)  # 设置X轴的线条宽度

    # 显示图形
    plt.tight_layout()
    # plt.show()
    plt.savefig(path + '/Result/pic/sigma=' + str(sigma) + '/Inflow/NumPerShelter/mismatch_human_expo.pdf')
    plt.savefig(path + '/Result/pic/sigma=' + str(sigma) + '/Inflow/NumPerShelter/mismatch_human_expo.png', dpi=300)



