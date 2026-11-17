# -*-coding:utf-8 -*-
# 仅用于制作气泡图的图例

"""
# @File       : 7.2_Mismatch_Inflow&Area(legend).py
# @software   : PyCharm  
# @Time       ：2024/9/26 17:27
# @Author     ：Wei Lyu
"""

import matplotlib.pyplot as plt
import numpy as np

plt.rcParams['pdf.fonttype'] = 42

# 创建一个带泡泡图的legend函数
def create_bubble_legend(ax, sizes, colors, labels):
    # 创建虚拟点，大小和颜色分别代表值的大小
    for size, color, label in zip(sizes, colors, labels):
        ax.scatter([], [], s=size, c=color, alpha=0.6, label=label, edgecolors='black')

    # 添加 legend
    ax.legend(scatterpoints=1, frameon=False, labelspacing=1, title='Legend: Bubble Size and Color')

if __name__ == '__main__':
    # 创建一个 'Greens' colormap
    cmap = plt.get_cmap('Blues')

    # 创建一个归一化的对象，将数值范围映射到 [0, 1] 的范围
    norm = plt.Normalize(vmin=0.2680231730071425, vmax=3.1377077078237536)  # 这里假设数值范围为 [0, 1]，根据实际情况调整

    # 计算特定值对应的颜色，假设你想查询值 0.5 对应的颜色
    # value = 0.5  # 需要查询的值，取值范围应该在 [vmin, vmax] 之间
    # color = cmap(norm(value))  # 将值映射到颜色
    #
    # print(f"The color corresponding to the value {value} is {color}.")

    values = [0.5, 2.0, 3.5]
    sizes = [values[0] * 140, values[1] * 140, values[2] * 140]  # 泡泡大小
    colors = [cmap(norm(values[0])), cmap(norm(values[1])), cmap(norm(values[2]))]  # 泡泡颜色
    labels = ['Small', 'Medium', 'Large']  # 标签

    fig, ax = plt.subplots()
    create_bubble_legend(ax, sizes, colors, labels)

    plt.savefig(r'D:\LW\ABM\OutputData\Result\pic\sigma=1\Inflow\NumPerShelter\mismatch_human_expo(legend).pdf', dpi=300)

