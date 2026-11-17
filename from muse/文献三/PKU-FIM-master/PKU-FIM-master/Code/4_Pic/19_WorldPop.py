# -*- coding: utf-8 -*-
# python 3.9
# 创建一个Constrained population的heatmap，方便检查

"""
#@Author  : Wei Lyu
#@FileName: 10_Pic_Pop.py
#@Time    : 2023/11/18 16:36
#@Software: PyCharm 
"""

import numpy as np
import matplotlib.cm as cm
import matplotlib.pyplot as plt
import pandas as pd
from scipy.stats import boxcox
import geopandas as gpd
import matplotlib.colors as mcolors
from matplotlib.colors import LinearSegmentedColormap
from sklearn.preprocessing import MinMaxScaler


# 定义 Box-Cox 变换函数
def boxcox_transform(x, lmbda):
    
    x_nonan = np.where(np.isnan(x), 1, x + 1e-6)
    transformed = boxcox(x_nonan, lmbda)
    
    return np.where(np.isnan(x), np.nan, transformed)

# 定义反向 Box-Cox 变换函数
def inv_boxcox_transform(x, lmbda):
    if lmbda == 0:
        return np.where(np.isnan(x), np.nan, np.exp(x))
    else:
        return np.where(np.isnan(x), np.nan, np.power((x * lmbda + 1), 1 / lmbda))


if __name__ == '__main__':
    path = 'D:/LW/ABM/OutputData'

    lmbda = 0.5

    relation = pd.read_csv(path + '/cities_21/' + 'cities21_pop_CH.csv', header=None, usecols=[0, 3], encoding='gbk')
    cities_cn = relation[0].tolist()
    cities_en = relation[3].tolist()


    for i in range(len(cities_cn)):
        city = cities_cn[i]
        city_en = cities_en[i].capitalize()
        data_path = path + '/Result/cities_21_max/' + city
        pic_storagePath = data_path + '/pic'
        shp_path = path + '/cities_21/' + city + '/' + city + '_grid.shp'
        shp = gpd.read_file(shp_path)

        worldpop = pd.read_csv(data_path + '/model_input.csv', header=0)
        worldpop['Tid'] = worldpop['Tid'] - 1  # 推演的时候Tid比shp里的Tid大1
        merged = shp.merge(worldpop, on='Tid')  # 合并 inflow DataFrame 和 shapefile

        scaler = MinMaxScaler()
        merged['Con_pop'] = scaler.fit_transform(merged[['Con_pop']])

        # 设置坐标系为 WGS84 (经纬度)
        merged = merged.to_crs(epsg=4326)

        colors = ["#E4D3DF", "#CC96AF", "#BE7495", "#AC5281"]
        cmap = LinearSegmentedColormap.from_list("custom_pink", colors, N=256)
        norm = mcolors.FuncNorm((lambda x: boxcox_transform(x, lmbda), lambda x: inv_boxcox_transform(x, lmbda)), vmin=0, vmax=1)

        # 绘制地图
        fig, ax = plt.subplots(figsize=(10, 6))
        ax1 = fig.add_axes([0.92, 0.25, 0.03, 0.5])

        merged.plot(column=merged['Con_pop'], ax=ax, norm=norm, cmap=cmap, edgecolor='white', linewidth=0.001, legend=False)

        cbar = fig.colorbar(cm.ScalarMappable(norm=norm, cmap=cmap), cax=ax1, orientation='vertical')
        cbar.ax.tick_params(labelsize=12)
        cbar.outline.set_visible(False)

        # 关闭ax边框
        for spine in ax.spines.values():
            spine.set_visible(False)

        # 添加经纬线
        ax.grid(True, which='both', color='gray', linestyle='--', linewidth=0.5)
        ax.set_axisbelow(True)
        ax.tick_params(axis='both', length=0, width=0, labelsize=12)

        filename = 'worldpop_boxcox' + str(lmbda)
        plt.savefig(pic_storagePath + '/' + filename + '.pdf', format='pdf')
        plt.savefig(pic_storagePath + '/' + filename + '.png', dpi=300)
        plt.close()
        print(city)







