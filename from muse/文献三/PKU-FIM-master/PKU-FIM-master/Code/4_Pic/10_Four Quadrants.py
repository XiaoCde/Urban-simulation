# -*-coding:utf-8 -*-
# Python 3.9
# 根据不同类型的Global SA+prop划分四象限图

"""
# @File       : 10_Four Quadrants.py
# @software   : PyCharm  
# @Time       ：2025/4/6 21:04
# @Author     ：Wei Lyu
"""

import pandas as pd
import matplotlib.pyplot as plt
from sklearn.preprocessing import MinMaxScaler
plt.rcParams['pdf.fonttype'] = 42
if __name__ == '__main__':
    path = 'D:/LW/ABM'
    outputPath = path + '/OutputData'

    df = pd.read_csv(outputPath + r'\Result\cities_21_max\Inflow\sigma=1\NumPerShelter\fourQuadrants.csv', header=0)

    # 设置图形
    fig, axs = plt.subplots(1, 2, figsize=(12, 6))
    titles = ['Deficit Quadrant', 'Surplus Quadrant']
    x_cols = ['Prop_deficit', 'Prop_surplus']
    y_cols = ['SA_deficit', 'SA_surplus']

    for ax, title, x_col, y_col in zip(axs, titles, x_cols, y_cols):
        ax.axhline(0.5, color='k', linewidth=1)
        ax.axvline(0.5, color='k', linewidth=1)

        for i, row in df.iterrows():
            city = row['City']
            x = row[x_col]
            y = row[y_col]
            # 判断城市
            if city == 'Shanghai':
                color = '#9CD0CC'
                marker = 'o'
            elif city == 'Zhengzhou':
                color = '#F98E7C'
                marker = 's'
            else:
                color = '#BCB6D7'
                marker = '^'

            ax.scatter(x, y, color=color, marker=marker, s=100, edgecolors='black')

        ax.set_xlim(-0.1, 1.1)
        ax.set_ylim(-0.1, 1.1)
        ax.set_xlabel('Proportion', fontsize=14)
        ax.set_ylabel('Global Spatial Autocorrelation', fontsize=14)
        ax.set_title(title)

    plt.tight_layout()
    plt.savefig(outputPath + r'\Result\pic\sigma=1\Inflow\NumPerShelter\four Quadrants.pdf')