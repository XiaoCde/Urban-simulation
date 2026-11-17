# -*-coding:utf-8 -*-
# python 3.9
# 给future projection这一章绘制3个case的图
# mismatch area

"""
# @File       : 11.2_Cases_projection_mismatch.py
# @software   : PyCharm  
# @Time       ：2025/6/19 11:39
# @Author     ：Wei Lyu
"""

import pandas as pd
import geopandas as gpd
import matplotlib.pyplot as plt
from matplotlib.ticker import MultipleLocator, FormatStrFormatter

# 设置全局字体为 Arial
plt.rcParams['font.family'] = 'Arial'
plt.rcParams['pdf.fonttype'] = 42

if __name__ == '__main__':
    path = r'D:\LW\ABM\OutputData'

    # csv_path = path + r'\Result\cities_21_max\昆明市\sigma=1\inflowPredShelter_MatchLabel.csv'
    csv_path = path + r'\Result_SSP585_pop2\cities_21_max\昆明市\sigma=1\inflowPredShelter_MatchLabel.csv'
    grid_path = path + r'\cities_21\昆明市\昆明市_grid.shp'
    boundary_path = path + r'\cities_21\昆明市\昆明市.shp'

    # === 1. 读取数据 ===
    df = pd.read_csv(csv_path)
    gdf_grid = gpd.read_file(grid_path)
    gdf_boundary = gpd.read_file(boundary_path)

    # === 2. 处理字段并关联 ===
    df['Tid'] = df['Tid'] - 1
    gdf_grid = gdf_grid.merge(df[['Tid', 'match_type']], on='Tid', how='left')

    # === 3. 替换 match_type 中的值 ===
    gdf_grid['match_type'] = gdf_grid['match_type'].replace({'deficit': 'unbalance', 'surplus': 'unbalance'})

    # === 4. 设置颜色映射 ===
    color_map = {
        'balance': '#F2F2F2',
        'unbalance': '#86A98C'#'#C58991'
    }
    gdf_grid['color'] = gdf_grid['match_type'].map(color_map)

    # === 5. 绘图 ===
    fig, ax = plt.subplots(figsize=(10, 8))

    # 主体图层
    gdf_grid.plot(ax=ax, color=gdf_grid['color'], edgecolor='white', linewidth=0.1)
    gdf_boundary.boundary.plot(ax=ax, color='black', linewidth=1)

    # 经纬网设置
    ax.set_axisbelow(True)
    ax.grid(which='major', linestyle='--', linewidth=0.5, color='#CFCFCF')

    # 显示经纬网刻度
    ax.xaxis.set_major_locator(MultipleLocator(0.5))
    ax.xaxis.set_major_formatter(FormatStrFormatter('%.1f'))
    ax.yaxis.set_major_locator(MultipleLocator(0.5))
    ax.yaxis.set_major_formatter(FormatStrFormatter('%.1f'))

    # 6. 限定显示范围
    minx, miny, maxx, maxy = gdf_grid.total_bounds
    offset = 0.1
    ax.set_xlim(minx - offset-0.5, maxx + offset+0.5)
    ax.set_ylim(miny - offset, maxy + offset)

    # 坐标轴设置
    ax.tick_params(labelsize=26)
    ax.set_xlabel("Longitude", fontsize=33, labelpad=15)
    ax.set_ylabel("Latitude", fontsize=33, labelpad=15)

    for spine in ax.spines.values():
        spine.set_linewidth(2)  # 设置为你想要的粗度，例如 2

    plt.tight_layout()
    # plt.savefig(path + r'\Result_SSP585_pop2\pic\sigma=1\cases_projection\Kunming_mismatch_current.png', dpi=300)
    plt.savefig(path + r'\Result_SSP585_pop2\pic\sigma=1\cases_projection\Kunming_mismatch_ssp585.png', dpi=300)
    plt.show()


