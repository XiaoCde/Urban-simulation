# -*-coding:utf-8 -*-
# python 3.9
# 给21个城市聚类

"""
# @File       : 8_SP_HDBSCAN.py
# @software   : PyCharm  
# @Time       ：2025/4/8 14:37
# @Author     ：Wei Lyu
"""

import pandas as pd
import matplotlib.pyplot as plt
import hdbscan
import seaborn as sns
import numpy as np
from matplotlib.ticker import ScalarFormatter
from scipy.spatial import ConvexHull

def compute_aspect_ratio(points):
    if len(points) < 3:
        return np.nan  # 无法构成凸包
    hull = ConvexHull(points)
    hull_points = points[hull.vertices]

    # 得到边界点的最小外接矩形
    x_min, y_min = np.min(hull_points, axis=0)
    x_max, y_max = np.max(hull_points, axis=0)
    width = x_max - x_min
    height = y_max - y_min

    if min(width, height) == 0:
        return np.nan  # 避免除以0
    return max(width, height) / min(width, height)

if __name__ == '__main__':
    path = 'D:/LW/ABM'
    outputPath = path + '/OutputData'

    sigma = 1

    relation = pd.read_csv(outputPath + '/cities_21/' + 'cities21_pop_CH.csv', header=None, usecols=[0, 3], encoding='gbk')
    cities_cn = relation[0].tolist()
    cities_en = relation[3].tolist()

    del relation

    sns.set_context('poster')
    sns.set_style('white')
    sns.set_color_codes()
    plot_kwds = {'alpha': 0.5, 's': 90, 'linewidths': 0}

    for i in range(len(cities_cn)):
        # i = 0
        city = cities_cn[i]
        city_en = cities_en[i][:-3]
        if city_en == 'xian':
            city_en = 'xi\'an'
        if city_en == 'haerbin':
            city_en = 'harbin'
        city_path = outputPath + '/Result/cities_21_max/' + city
        file = 'mismatch_centroids.csv'
        df = pd.read_csv(city_path + '/sigma=' + str(sigma) + '/' + file, header=0)

        # 原始数据点
        plt.figure(figsize=(12, 8))

        plt.scatter(df['X'], df['Y'], color='g', **plot_kwds)
        plt.title(f'{city_en.capitalize()} - Mismatch Points', fontsize=16)
        plt.xlabel('X', fontsize=14)
        plt.ylabel('Y', fontsize=14)

        # 科学计数法
        ax = plt.gca()
        ax.ticklabel_format(style='sci', axis='both', scilimits=(0, 0))
        ax.xaxis.set_major_formatter(ScalarFormatter(useMathText=True))
        ax.yaxis.set_major_formatter(ScalarFormatter(useMathText=True))
        ax.xaxis.offsetText.set_fontsize(12)
        ax.yaxis.offsetText.set_fontsize(12)

        plt.xticks(fontsize=14)
        plt.yticks(fontsize=14)

        plt.tight_layout()
        plt.savefig(city_path + '/pic/sigma=' + str(sigma) + '/' + 'Clustering - Original Points')
        plt.close()


        # hdbscan-----------------------------------

        test_data = np.vstack([df['X'], df['Y']]).T

        cluster = hdbscan.HDBSCAN(min_cluster_size=5, gen_min_span_tree=True)
        labels = cluster.fit_predict(test_data)   # 注意结果=-1是噪声点，后面的凸包计算也要忽略

        # 保存结果
        df['label'] = labels

        aspect_ratios = {}

        for label, group in df.groupby('label'):
            points = group[['X', 'Y']].values
            ratio = compute_aspect_ratio(points)
            aspect_ratios[label] = ratio    # 忽略-1的噪声点

        # 关联上df
        df['ConvexHull'] = df['label'].map(aspect_ratios)
        df.to_csv(city_path + '/sigma=' + str(sigma) + '/' + 'clustered results.csv', header=True, index=False)


        # 绘制相关图表---------------------------------------------------------
        plt.figure(figsize=(12, 8), dpi=100)
        plt.scatter(test_data[:, 0], test_data[:, 1], c=labels, cmap='viridis', s=80)
        plt.title(f'{city_en.capitalize()} - HDBSCAN Clustering', fontsize=16)
        plt.xlabel('X', fontsize=14)
        plt.ylabel('Y', fontsize=14)

        # 科学计数法
        ax = plt.gca()
        ax.ticklabel_format(style='sci', axis='both', scilimits=(0, 0))
        ax.xaxis.set_major_formatter(ScalarFormatter(useMathText=True))
        ax.yaxis.set_major_formatter(ScalarFormatter(useMathText=True))
        ax.xaxis.offsetText.set_fontsize(12)
        ax.yaxis.offsetText.set_fontsize(12)

        plt.xticks(fontsize=14)
        plt.yticks(fontsize=14)

        cbar = plt.colorbar()  # 获取 colorbar 对象
        cbar.set_label('Cluster Label', fontsize=14)  # 设置 colorbar 标题字体大小
        cbar.ax.tick_params(labelsize=12)  # 设置 colorbar 刻度字体大小

        plt.tight_layout()
        plt.savefig(city_path + '/pic/sigma=' + str(sigma) + '/' + 'Clustering - HDBSCAN Clustering.png', dpi=300)
        plt.close()

        print(city_en)