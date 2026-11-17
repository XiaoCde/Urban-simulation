# -*-coding:utf-8 -*-
# python 3.9
# 给future projection这一章绘制3个case的图
# mismatch area

"""
# @File       : 11.3_Cases_projection_expo.py
# @software   : PyCharm  
# @Time       ：2025/6/19 14:07
# @Author     ：Wei Lyu
"""

import pandas as pd
import numpy as np
import geopandas as gpd
import matplotlib.pyplot as plt
from matplotlib.ticker import MultipleLocator, FormatStrFormatter
import matplotlib.cm as cm
from scipy.stats import boxcox
from matplotlib.colors import LinearSegmentedColormap
import matplotlib.colors as mcolors

# 定义 Box-Cox 变换函数
def boxcox_transform(x, lmbda):
    # 将 NaN 替换为 1，以避免 boxcox 函数报错
    x_nonan = np.where(np.isnan(x), 1, x + 1e-6)
    transformed = boxcox(x_nonan, lmbda)
    # 将原始的 NaN 值还原
    return np.where(np.isnan(x), np.nan, transformed)

# 定义反向 Box-Cox 变换函数
def inv_boxcox_transform(x, lmbda):
    if lmbda == 0:
        return np.where(np.isnan(x), np.nan, np.exp(x))
    else:
        return np.where(np.isnan(x), np.nan, np.power((x * lmbda + 1), 1 / lmbda))

# 设置全局字体为 Arial
plt.rcParams['font.family'] = 'Arial'
plt.rcParams['pdf.fonttype'] = 42

if __name__ == '__main__':
    path = r'D:\LW\ABM\OutputData'
    csv_path = path + r'\Result\cities_21_max\深圳市\sigma=1\inflowPredShelter_MatchLabel.csv'
    # csv_path = path + r'\Result_SSP585_pop2\cities_21_max\深圳市\sigma=1\inflowPredShelter_MatchLabel.csv'
    grid_path = path + r'\cities_21\深圳市\深圳市_grid.shp'
    boundary_path = path + r'\cities_21\深圳市\深圳市.shp'

    # === 3. 设置 colormap 和 colorbar ===
    max_value = 6368.46998020792 # 指定colorbar的最大值
    lmbda = 0.2
    colors = ['#F2F2F2', '#F5F5F5', '#F2B69E', '#9D425A']
    cmap = LinearSegmentedColormap.from_list("custom_pink", colors, N=256)
    # cmap = cm.RdPu
    norm = mcolors.FuncNorm((lambda x: boxcox_transform(x, lmbda), lambda x: inv_boxcox_transform(x, lmbda)), vmin=0, vmax=max_value)

    # === 1. 读取数据 ===
    df = pd.read_csv(csv_path)
    gdf_grid = gpd.read_file(grid_path)
    gdf_boundary = gpd.read_file(boundary_path)

    # === 2. 处理字段并关联 ===
    df['Tid'] = df['Tid'] - 1
    gdf_grid = gdf_grid.merge(df[['Tid', 'human_expo']], on='Tid', how='left')


    # === 4. 绘图 ===
    fig, ax = plt.subplots(figsize=(13, 8))

    # 栅格图
    gdf_grid.plot(column='human_expo', ax=ax, cmap=cmap, norm=norm, edgecolor='none')

    # 边界图层
    gdf_boundary.boundary.plot(ax=ax, color='black', linewidth=1)

    # 经纬网设置
    ax.set_axisbelow(True)
    ax.grid(which='major', linestyle='--', linewidth=0.5, color='#CFCFCF')

    # 显示经纬网刻度
    ax.xaxis.set_major_locator(MultipleLocator(0.2))
    ax.xaxis.set_major_formatter(FormatStrFormatter('%.1f'))
    ax.yaxis.set_major_locator(MultipleLocator(0.2))
    ax.yaxis.set_major_formatter(FormatStrFormatter('%.1f'))

    # 6. 限定显示范围
    minx, miny, maxx, maxy = gdf_grid.total_bounds
    offset = 0.05
    ax.set_xlim(minx - offset, maxx + offset)
    ax.set_ylim(miny - offset - 0.15, maxy + offset + 0.15)

    # 坐标轴设置
    ax.tick_params(labelsize=26)
    ax.set_xlabel("Longitude", fontsize=33, labelpad=15)
    ax.set_ylabel("Latitude", fontsize=33, labelpad=15)

    for spine in ax.spines.values():
        spine.set_linewidth(2)  # 设置为你想要的粗度，例如 2

    # colorbar设置
    ax1 = fig.add_axes([0.92, 0.15, 0.03, 0.6])
    cbar = fig.colorbar(cm.ScalarMappable(norm=norm, cmap=cmap), cax=ax1, orientation='vertical', pad=0.02)
    cbar.ax.tick_params(labelsize=20)
    cbar.outline.set_visible(False)
    cbar.set_label('Population exposure', fontsize=26)

    plt.tight_layout()
    # plt.savefig(path + r'\Result_SSP585_pop2\pic\sigma=1\cases_projection\Shenzhen_exposure_current.png', dpi=300)
    # plt.savefig(path + r'\Result_SSP585_pop2\pic\sigma=1\cases_projection\Shenzhen_exposure_ssp585.png', dpi=300)
    plt.savefig(path + r'\Result_SSP585_pop2\pic\sigma=1\cases_projection\Chongqing_exposure(legend).pdf')
    plt.show()


